use std::{collections::BTreeMap, ops::Range, sync::Arc};

use dicom_core::{DataDictionary, Tag, VR, dictionary::VirtualVr};
use dicom_dictionary_std::StandardDataDictionary;
use flate2::{Decompress, FlushDecompress, Status};
use sha2::{Digest, Sha256, digest::Output};

use crate::{Error, Limits, Result, TransferSyntax};

pub(crate) type Key = (u16, u16);
pub(crate) const PIXEL_DATA: Key = (0x7fe0, 0x0010);
const ITEM: Key = (0xfffe, 0xe000);
const ITEM_END: Key = (0xfffe, 0xe00d);
const SEQUENCE_END: Key = (0xfffe, 0xe0dd);
const UNDEFINED: u32 = u32::MAX;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ByteOrder {
    Little,
    Big,
}

impl ByteOrder {
    pub(crate) fn u16(self, bytes: [u8; 2]) -> u16 {
        match self {
            Self::Little => u16::from_le_bytes(bytes),
            Self::Big => u16::from_be_bytes(bytes),
        }
    }

    pub(crate) fn u32(self, bytes: [u8; 4]) -> u32 {
        match self {
            Self::Little => u32::from_le_bytes(bytes),
            Self::Big => u32::from_be_bytes(bytes),
        }
    }

    pub(crate) fn u64(self, bytes: [u8; 8]) -> u64 {
        match self {
            Self::Little => u64::from_le_bytes(bytes),
            Self::Big => u64::from_be_bytes(bytes),
        }
    }
}

#[derive(Clone, Copy)]
struct Encoding {
    order: ByteOrder,
    explicit: bool,
}

impl Encoding {
    const EXPLICIT_LE: Self = Self {
        order: ByteOrder::Little,
        explicit: true,
    };

    fn for_syntax(syntax: TransferSyntax) -> Self {
        match syntax {
            TransferSyntax::ImplicitLe => Self {
                explicit: false,
                ..Self::EXPLICIT_LE
            },
            TransferSyntax::ExplicitBe => Self {
                order: ByteOrder::Big,
                explicit: true,
            },
            _ => Self::EXPLICIT_LE,
        }
    }
}

#[derive(Default)]
pub(crate) struct Dataset {
    elements: BTreeMap<Key, Element>,
}

pub(crate) struct Element {
    pub(crate) vr: Option<VR>,
    pub(crate) value: Value,
}

pub(crate) enum Value {
    Bytes(Range<usize>),
    Sequence(Vec<Dataset>),
    Encapsulated {
        offset_table: Range<usize>,
        fragments: Vec<Fragment>,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct Fragment {
    pub(crate) offset: usize,
    pub(crate) bytes: Range<usize>,
}

impl Dataset {
    pub(crate) fn get(&self, key: Key) -> Option<&Element> {
        self.elements.get(&key)
    }

    pub(crate) fn bytes<'a>(&self, bytes: &'a [u8], key: Key) -> Option<&'a [u8]> {
        let Value::Bytes(range) = &self.get(key)?.value else {
            return None;
        };
        Some(&bytes[range.clone()])
    }

    pub(crate) fn text<'a>(&self, bytes: &'a [u8], key: Key) -> Option<&'a str> {
        let bytes = self.bytes(bytes, key)?;
        if bytes.len() > 4096 {
            return None;
        }
        Some(
            std::str::from_utf8(bytes)
                .ok()?
                .trim_end_matches([' ', '\0']),
        )
    }

    pub(crate) fn sequence(&self, key: Key) -> Option<&[Dataset]> {
        let Value::Sequence(items) = &self.get(key)?.value else {
            return None;
        };
        Some(items)
    }

    pub(crate) fn one(&self, key: Key) -> Option<&Dataset> {
        let [item] = self.sequence(key)? else {
            return None;
        };
        Some(item)
    }

    pub(crate) fn us(&self, file: &File, key: Key) -> Option<u16> {
        Some(
            file.order
                .u16(self.bytes(&file.bytes, key)?.try_into().ok()?),
        )
    }

    pub(crate) fn ul(&self, file: &File, key: Key) -> Option<u32> {
        Some(
            file.order
                .u32(self.bytes(&file.bytes, key)?.try_into().ok()?),
        )
    }

    pub(crate) fn fd(&self, file: &File, key: Key) -> Option<f64> {
        let v = f64::from_bits(
            file.order
                .u64(self.bytes(&file.bytes, key)?.try_into().ok()?),
        );
        v.is_finite().then_some(v)
    }

    pub(crate) fn ds<const N: usize>(&self, file: &File, key: Key) -> Option<[f64; N]> {
        let mut values = self.text(&file.bytes, key)?.split('\\');
        let mut out = [0.0_f64; N];
        for v in &mut out {
            *v = values.next()?.trim().parse().ok()?;
            if !v.is_finite() {
                return None;
            }
        }
        values.next().is_none().then_some(out)
    }

    pub(crate) fn first_ds(&self, file: &File, key: Key) -> Option<f64> {
        let value: f64 = self
            .text(&file.bytes, key)?
            .split('\\')
            .next()?
            .trim()
            .parse()
            .ok()?;
        value.is_finite().then_some(value)
    }
}

pub(crate) struct File {
    pub(crate) bytes: Arc<Vec<u8>>,
    pub(crate) dataset: Dataset,
    pub(crate) order: ByteOrder,
    pub(crate) syntax: TransferSyntax,
    pub(crate) class_uid: String,
    pub(crate) instance_uid: String,
    pub(crate) sha256: String,
    pub(crate) source_bytes: usize,
    pub(crate) elements: usize,
    pub(crate) pixel_extent: Option<Range<usize>>,
}

impl File {
    pub(crate) fn parse(
        bytes: Vec<u8>,
        limits: Limits,
        expected_sha256: Option<&str>,
    ) -> Result<Self> {
        Self::check_source_size(bytes.len(), limits)?;
        let digest = source_digest(&bytes);
        Self::parse_with_digest(bytes, limits, expected_sha256, digest)
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) async fn parse_in_worker(
        bytes: Vec<u8>,
        limits: Limits,
        expected_sha256: Option<&str>,
    ) -> Result<Self> {
        Self::check_source_size(bytes.len(), limits)?;
        let digest = web_crypto_digest(&bytes)
            .await
            .unwrap_or_else(|| source_digest(&bytes));
        Self::parse_with_digest(bytes, limits, expected_sha256, digest)
    }

    pub(crate) fn check_source_size(size: usize, limits: Limits) -> Result<()> {
        limits.validate()?;
        if size > limits.source_bytes {
            return Err(Error::Limit("source bytes"));
        }
        Ok(())
    }

    fn parse_with_digest(
        bytes: Vec<u8>,
        limits: Limits,
        expected_sha256: Option<&str>,
        digest: Output<Sha256>,
    ) -> Result<Self> {
        let sha256 = format!("{digest:x}");
        if expected_sha256.is_some_and(|hash| !sha256.eq_ignore_ascii_case(hash)) {
            return Err(Error::Integrity("source SHA-256"));
        }
        let source_bytes = bytes.len();
        Self::parse_dataset(bytes, limits, source_bytes, sha256)
    }

    pub(crate) fn parse_dataset(
        bytes: Vec<u8>,
        limits: Limits,
        source_bytes: usize,
        sha256: String,
    ) -> Result<Self> {
        Self::parse_shared(Arc::new(bytes), limits, source_bytes, sha256)
    }

    pub(crate) fn parse_shared(
        mut bytes: Arc<Vec<u8>>,
        limits: Limits,
        source_bytes: usize,
        sha256: String,
    ) -> Result<Self> {
        if bytes.get(128..132) != Some(b"DICM") {
            return Err(Error::InvalidDicom("Part 10 signature"));
        }
        let mut meta = Parser::new(&bytes, 132, Encoding::EXPLICIT_LE, limits);
        let meta_end = if meta.key()? == (2, 0) {
            let (_, length) = meta.header()?;
            if length != 4 {
                return Err(Error::InvalidDicom("file meta group length"));
            }
            let size = meta.number()? as usize;
            Some(meta.end(size, bytes.len())?)
        } else {
            meta.pos = 132;
            None
        };
        let mut information = Dataset::default();
        let meta_bound = meta_end.unwrap_or(bytes.len());
        while meta.pos < meta_bound {
            let key = meta.key()?;
            if key.0 != 2 {
                meta.pos -= 4;
                break;
            }
            let element = meta.element(key, meta_bound, 0)?;
            if !matches!(element.value, Value::Bytes(_))
                || information.elements.insert(key, element).is_some()
            {
                return Err(Error::InvalidDicom("file meta information"));
            }
        }
        if meta_end.is_some_and(|end| end != meta.pos) {
            return Err(Error::InvalidDicom("file meta group length"));
        }
        let offset = meta.pos;
        let class_uid = uid(information.text(&bytes, (2, 2)))?.to_owned();
        let instance_uid = uid(information.text(&bytes, (2, 3)))?.to_owned();
        let syntax = TransferSyntax::from_uid(uid(information.text(&bytes, (2, 0x10)))?)?;
        let encoding = Encoding::for_syntax(syntax);
        let start = if syntax == TransferSyntax::Deflated {
            bytes = Arc::new(inflate_dataset(&bytes[offset..], limits.inflated_bytes)?);
            0
        } else {
            offset
        };
        let mut parser = Parser::new(&bytes, start, encoding, limits);
        let dataset = parser.dataset(bytes.len(), None, 0)?;
        let elements = parser.elements;
        let pixel_extent = parser.pixel_extent;
        if uid(dataset.text(&bytes, (8, 0x16)))? != class_uid
            || uid(dataset.text(&bytes, (8, 0x18)))? != instance_uid
        {
            return Err(Error::Integrity(
                "file meta and dataset SOP identifiers differ",
            ));
        }
        Ok(Self {
            bytes,
            dataset,
            order: encoding.order,
            syntax,
            class_uid,
            instance_uid,
            sha256,
            source_bytes,
            elements,
            pixel_extent,
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn source_digest(bytes: &[u8]) -> Output<Sha256> {
    Sha256::digest(bytes)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn source_digest(bytes: &[u8]) -> Output<Sha256> {
    let mut hasher = Sha256::new();
    for chunk in bytes.chunks(16 * 1024) {
        hasher.update(chunk);
    }
    hasher.finalize()
}

#[cfg(target_arch = "wasm32")]
async fn web_crypto_digest(bytes: &[u8]) -> Option<Output<Sha256>> {
    finish_web_digest(start_web_digest(bytes)?).await
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn start_web_digest(bytes: &[u8]) -> Option<js_sys::Promise> {
    use wasm_bindgen::JsCast;

    let worker: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
    let crypto = worker.crypto().ok().filter(|crypto| crypto.is_object())?;
    let subtle = crypto.subtle();
    if !subtle.is_object() {
        return None;
    }
    // Web Crypto snapshots a view of the parser's owned bytes before returning its promise.
    subtle.digest_with_str_and_u8_array("SHA-256", bytes).ok()
}

#[cfg(target_arch = "wasm32")]
pub(crate) async fn finish_web_digest(promise: js_sys::Promise) -> Option<Output<Sha256>> {
    use wasm_bindgen::JsCast;
    let result = promise.await.ok()?.dyn_into::<js_sys::ArrayBuffer>().ok()?;
    let result = js_sys::Uint8Array::new(&result);
    let mut digest = Output::<Sha256>::default();
    if result.length() as usize != digest.len() {
        return None;
    }
    result.copy_to(&mut digest);
    Some(digest)
}

fn inflate_dataset(data: &[u8], max: usize) -> Result<Vec<u8>> {
    let mut inflate = Decompress::new(false);
    let mut bytes = Vec::new();
    let mut chunk = [0; 32 * 1024];
    loop {
        let input = inflate.total_in() as usize;
        let output = inflate.total_out() as usize;
        let status = inflate
            .decompress(&data[input..], &mut chunk, FlushDecompress::None)
            .map_err(|_| Error::InvalidDicom("deflated dataset"))?;
        let end = inflate.total_out() as usize;
        if end > max {
            return Err(Error::Limit("inflated dataset bytes"));
        }
        if bytes.capacity() < end {
            let capacity = end.max(bytes.capacity().saturating_mul(2)).min(max);
            bytes
                .try_reserve_exact(capacity - bytes.len())
                .map_err(|_| Error::Limit("inflated dataset allocation"))?;
        }
        bytes.extend_from_slice(&chunk[..end - output]);
        if status == Status::StreamEnd {
            return if matches!(&data[inflate.total_in() as usize..], [] | [0]) {
                Ok(bytes)
            } else {
                Err(Error::InvalidDicom("trailing deflated data"))
            };
        }
        if end == output && inflate.total_in() as usize == input {
            return Err(Error::InvalidDicom("truncated deflated dataset"));
        }
    }
}

pub(crate) fn uid(value: Option<&str>) -> Result<&str> {
    let value = value.ok_or(Error::InvalidDicom("required UID"))?;
    if value.len() > 64
        || value.split('.').any(|part| {
            part.is_empty()
                || !part.bytes().all(|b| b.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return Err(Error::InvalidDicom("UID format"));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    encoding: Encoding,
    limits: Limits,
    elements: usize,
    pixel_extent: Option<Range<usize>>,
}

impl<'a> Parser<'a> {
    fn new(bytes: &'a [u8], pos: usize, encoding: Encoding, limits: Limits) -> Self {
        Self {
            bytes,
            pos,
            encoding,
            limits,
            elements: 0,
            pixel_extent: None,
        }
    }

    fn end(&self, length: usize, bound: usize) -> Result<usize> {
        self.pos
            .checked_add(length)
            .filter(|end| *end <= bound)
            .ok_or(Error::InvalidDicom("truncated element"))
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N]> {
        let end = self.end(N, self.bytes.len())?;
        let bytes = self.bytes[self.pos..end]
            .try_into()
            .expect("fixed byte count");
        self.pos = end;
        Ok(bytes)
    }

    fn key(&mut self) -> Result<Key> {
        let g = self.take()?;
        let e = self.take()?;
        Ok((self.encoding.order.u16(g), self.encoding.order.u16(e)))
    }

    fn number(&mut self) -> Result<u32> {
        let bytes = self.take()?;
        Ok(self.encoding.order.u32(bytes))
    }

    fn header(&mut self) -> Result<(Option<VR>, u32)> {
        if !self.encoding.explicit {
            return Ok((None, self.number()?));
        }
        let vr = VR::from_binary(self.take::<2>()?)
            .ok_or(Error::InvalidDicom("value representation"))?;
        let length = match vr {
            VR::OB
            | VR::OD
            | VR::OF
            | VR::OL
            | VR::OV
            | VR::OW
            | VR::SQ
            | VR::SV
            | VR::UC
            | VR::UN
            | VR::UR
            | VR::UT
            | VR::UV => {
                if self.take::<2>()? != [0; 2] {
                    return Err(Error::InvalidDicom("VR reserved bytes"));
                }
                self.number()?
            }
            _ => {
                let len = self.take()?;
                u32::from(self.encoding.order.u16(len))
            }
        };
        Ok((Some(vr), length))
    }

    fn budget(&mut self) -> Result<()> {
        self.elements += 1;
        if self.elements > self.limits.elements {
            return Err(Error::Limit("dataset elements"));
        }
        Ok(())
    }

    fn dataset(&mut self, end: usize, stop: Option<Key>, depth: usize) -> Result<Dataset> {
        if depth > 24 {
            return Err(Error::Limit("dataset nesting depth"));
        }
        let mut out = Dataset::default();
        while self.pos < end {
            let start = self.pos;
            self.end(8, end)?;
            let key = self.key()?;
            if Some(key) == stop && self.number()? == 0 {
                return Ok(out);
            }
            if key.0 == 0xfffe {
                return Err(Error::InvalidDicom("unexpected item delimiter"));
            }
            let element = self.element(key, end, depth)?;
            if depth == 0 && key == PIXEL_DATA {
                self.pixel_extent = Some(start..self.pos);
            }
            if out.elements.insert(key, element).is_some() {
                return Err(Error::InvalidDicom("duplicate data element"));
            }
        }
        if stop.is_some() {
            return Err(Error::InvalidDicom("missing item delimiter"));
        }
        Ok(out)
    }

    fn element(&mut self, key: Key, bound: usize, depth: usize) -> Result<Element> {
        self.budget()?;
        let (vr, length) = self.header()?;
        if self.pos > bound {
            return Err(Error::InvalidDicom("truncated element header"));
        }
        let is_sequence = vr == Some(VR::SQ)
            || vr.is_none()
                && StandardDataDictionary
                    .by_tag(Tag(key.0, key.1))
                    .is_some_and(|entry| entry.vr == VirtualVr::Exact(VR::SQ));
        let value = match length {
            UNDEFINED if key == PIXEL_DATA => self.encapsulated(bound)?,
            UNDEFINED if is_sequence || vr.is_none() => {
                Value::Sequence(self.sequence(bound, true, depth)?)
            }
            UNDEFINED => return Err(Error::Unsupported("undefined-length value representation")),
            _ if !length.is_multiple_of(2) => {
                return Err(Error::InvalidDicom("odd element length"));
            }
            _ => {
                let end = self.end(length as usize, bound)?;
                if is_sequence {
                    Value::Sequence(self.sequence(end, false, depth)?)
                } else {
                    let range = self.pos..end;
                    self.pos = end;
                    Value::Bytes(range)
                }
            }
        };
        Ok(Element { vr, value })
    }

    fn sequence(&mut self, bound: usize, undefined: bool, depth: usize) -> Result<Vec<Dataset>> {
        let mut items = Vec::new();
        while self.pos < bound {
            self.end(8, bound)?;
            let key = self.key()?;
            let length = self.number()?;
            if key == SEQUENCE_END && length == 0 && undefined {
                return Ok(items);
            }
            if key != ITEM {
                return Err(Error::InvalidDicom("sequence item"));
            }
            self.budget()?;
            let (end, delimiter) = if length == UNDEFINED {
                (bound, Some(ITEM_END))
            } else {
                (self.end(length as usize, bound)?, None)
            };
            items.push(self.dataset(end, delimiter, depth + 1)?);
        }
        if undefined {
            return Err(Error::InvalidDicom("missing sequence delimiter"));
        }
        Ok(items)
    }

    fn encapsulated(&mut self, bound: usize) -> Result<Value> {
        self.end(8, bound)?;
        if self.key()? != ITEM {
            return Err(Error::InvalidDicom("basic offset table item"));
        }
        let len = self.number()? as usize;
        if !len.is_multiple_of(4) || len / 4 > self.limits.frames {
            return Err(Error::InvalidDicom("basic offset table length"));
        }
        let base = self.end(len, bound)?;
        let offset_table = self.pos..base;
        self.pos = base;
        let mut fragments = Vec::new();
        loop {
            self.end(8, bound)?;
            let offset = self.pos - base;
            let key = self.key()?;
            let len = self.number()? as usize;
            if key == SEQUENCE_END && len == 0 {
                return Ok(Value::Encapsulated {
                    offset_table,
                    fragments,
                });
            }
            if key != ITEM || len < 2 || !len.is_multiple_of(2) {
                return Err(Error::InvalidDicom("encapsulated fragment item"));
            }
            if fragments.len() >= self.limits.fragments {
                return Err(Error::Limit("pixel fragments"));
            }
            let end = self.end(len, bound)?;
            fragments.push(Fragment {
                offset,
                bytes: self.pos..end,
            });
            self.pos = end;
        }
    }
}
