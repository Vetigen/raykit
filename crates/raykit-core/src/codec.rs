use std::{borrow::Cow, ops::Range};

use jpeg_decoder::{ColorTransform, Decoder, PixelFormat as JpegFormat};

use crate::{
    Error, Limits, Result, TransferSyntax,
    dicom::{ByteOrder, File, Fragment, PIXEL_DATA, Value},
    frame_index::DetachedIndex,
    pixel::{ColorSpace, Photometric, PixelFormat, Samples},
};

#[cfg(feature = "advanced-codecs")]
mod advanced;

pub(crate) const MAX_ENCODED_FRAME_BYTES: usize = 32 * 1024 * 1024;

pub(crate) enum Index {
    Native {
        bytes: Range<usize>,
        frame_bytes: usize,
        swap_bytes: bool,
    },
    Encapsulated {
        fragments: Vec<Fragment>,
        frames: Vec<Range<usize>>,
    },
    Detached(DetachedIndex),
}

impl Index {
    pub(crate) fn new(
        file: &File,
        format: PixelFormat,
        count: usize,
        limits: Limits,
    ) -> Result<Self> {
        let data = file
            .dataset
            .get(PIXEL_DATA)
            .ok_or(Error::InvalidDicom("missing Pixel Data"))?;
        match &data.value {
            Value::Bytes(bytes) if !file.syntax.encapsulated() => {
                let frame_bytes = if format.photometric == Photometric::YbrFull422 {
                    if !format.columns.is_multiple_of(2) {
                        return Err(Error::Unsupported("native YBR_FULL_422 odd width"));
                    }
                    format.pixels() * 2
                } else {
                    format.pixels() * format.components() * usize::from(format.bits_allocated / 8)
                };
                let total = frame_bytes
                    .checked_mul(count)
                    .ok_or(Error::Limit("native pixel bytes"))?;
                if total.checked_next_multiple_of(2) != Some(bytes.len()) {
                    return Err(Error::InvalidDicom("native pixel data length"));
                }
                Ok(Self::Native {
                    bytes: bytes.clone(),
                    frame_bytes,
                    swap_bytes: file.order == ByteOrder::Big
                        && format.bits_allocated == 8
                        && data.vr == Some(dicom_core::VR::OW),
                })
            }
            Value::Encapsulated {
                offset_table,
                fragments,
            } if file.syntax.encapsulated() => {
                if fragments.is_empty() {
                    return Err(Error::InvalidDicom("empty encapsulated pixels"));
                }
                let frames = frame_ranges(
                    file,
                    &file.bytes[offset_table.clone()],
                    fragments,
                    count,
                    limits,
                )?;
                Ok(Self::Encapsulated {
                    fragments: fragments.clone(),
                    frames,
                })
            }
            _ => Err(Error::InvalidDicom(
                "Pixel Data encoding does not match transfer syntax",
            )),
        }
    }

    pub(crate) fn bytes(&self) -> usize {
        match self {
            Self::Native { .. } => 0,
            Self::Encapsulated { fragments, frames } => {
                fragments.capacity() * size_of::<Fragment>()
                    + frames.capacity() * size_of::<Range<usize>>()
            }
            Self::Detached(index) => index.bytes(),
        }
    }

    pub(crate) fn read(
        &self,
        file: &File,
        format: PixelFormat,
        frame: usize,
    ) -> Result<(Samples, usize)> {
        match self {
            Self::Native {
                bytes,
                frame_bytes,
                swap_bytes,
            } => {
                let start = frame * frame_bytes;
                let data = &file.bytes[bytes.clone()];
                let swapped;
                let raw = if *swap_bytes {
                    swapped = (start..start + frame_bytes)
                        .map(|i| data[i ^ 1])
                        .collect::<Vec<_>>();
                    &swapped
                } else {
                    &data[start..start + frame_bytes]
                };
                Ok((
                    decode_native(raw, format, file.order),
                    if *swap_bytes { *frame_bytes } else { 0 },
                ))
            }
            Self::Encapsulated { fragments, frames } => {
                let fragments = &fragments[frames[frame].clone()];
                let size = fragments.iter().map(|f| f.bytes.len()).sum();
                if size > MAX_ENCODED_FRAME_BYTES {
                    return Err(Error::Limit("encoded frame bytes"));
                }
                let (data, copied) = if let [fragment] = fragments {
                    (Cow::Borrowed(&file.bytes[fragment.bytes.clone()]), 0)
                } else {
                    let mut joined = Vec::with_capacity(size);
                    for f in fragments {
                        joined.extend_from_slice(&file.bytes[f.bytes.clone()]);
                    }
                    (Cow::Owned(joined), size)
                };
                let samples = match file.syntax {
                    TransferSyntax::Rle => decode_rle(&data, format)?,
                    TransferSyntax::JpegBaseline
                    | TransferSyntax::JpegExtended
                    | TransferSyntax::JpegLossless
                    | TransferSyntax::JpegLosslessSv1
                    | TransferSyntax::JpegLsLossless
                    | TransferSyntax::JpegLsNearLossless => {
                        decode_jpeg(&data, format, file.syntax)?
                    }
                    #[cfg(feature = "advanced-codecs")]
                    syntax if syntax.wavelet() => advanced::decode_wavelet(&data, format, syntax)?,
                    _ => return Err(Error::Unsupported("pixel codec")),
                };
                Ok((samples, copied))
            }
            Self::Detached(_) => Err(Error::FrameRange(frame)),
        }
    }
}

pub(crate) fn read_indexed(
    index: &DetachedIndex,
    format: PixelFormat,
    frame: usize,
    bytes: &[u8],
) -> Result<(Samples, usize)> {
    if index.fragmented(frame) {
        let data = index.joined(frame, bytes)?;
        Ok((
            decode_jpeg(&data, format, TransferSyntax::JpegBaseline)?,
            data.len(),
        ))
    } else {
        Ok((decode_jpeg(bytes, format, TransferSyntax::JpegBaseline)?, 0))
    }
}

fn frame_ranges(
    file: &File,
    basic: &[u8],
    fragments: &[Fragment],
    count: usize,
    limits: Limits,
) -> Result<Vec<Range<usize>>> {
    let extended = file.dataset.bytes(&file.bytes, (0x7fe0, 1));
    let lengths = file.dataset.bytes(&file.bytes, (0x7fe0, 2));
    if let (Some(offsets), Some(lengths)) = (extended, lengths) {
        if !basic.is_empty()
            || offsets.len() != count * 8
            || lengths.len() != count * 8
            || fragments.len() != count
        {
            return Err(Error::InvalidDicom("extended offset table shape"));
        }
        let words = |b: &[u8]| u64::from_le_bytes(b.try_into().expect("offset table word"));
        for (i, fragment) in fragments.iter().enumerate() {
            let length = words(&lengths[i * 8..i * 8 + 8]);
            if words(&offsets[i * 8..i * 8 + 8]) != fragment.offset as u64
                || length < 2
                || length > fragment.bytes.len() as u64
                || length.next_multiple_of(2) != fragment.bytes.len() as u64
                || length % 2 == 1 && file.bytes[fragment.bytes.end - 1] != 0
            {
                return Err(Error::InvalidDicom("extended offset table entry"));
            }
        }
        return Ok((0..count).map(|i| i..i + 1).collect());
    }
    if extended.is_some() || lengths.is_some() {
        return Err(Error::InvalidDicom("incomplete extended offset table"));
    }
    if !basic.is_empty() {
        if basic.len() != count * 4 {
            return Err(Error::InvalidDicom("basic offset table count"));
        }
        let mut starts = Vec::with_capacity(count + 1);
        for &word in basic.as_chunks::<4>().0 {
            let offset = u32::from_le_bytes(word) as usize;
            let index = fragments
                .binary_search_by_key(&offset, |f| f.offset)
                .map_err(|_| Error::InvalidDicom("basic offset table target"))?;
            if starts.last().is_some_and(|&last| index <= last) || starts.is_empty() && index != 0 {
                return Err(Error::InvalidDicom("basic offset table order"));
            }
            starts.push(index);
        }
        starts.push(fragments.len());
        let frames: Vec<_> = starts.windows(2).map(|w| w[0]..w[1]).collect();
        if file.syntax == TransferSyntax::Rle && frames.iter().any(|r| r.len() != 1) {
            return Err(Error::InvalidDicom("RLE requires one fragment per frame"));
        }
        return Ok(frames);
    }
    if file.syntax == TransferSyntax::Rle {
        if fragments.len() != count {
            return Err(Error::InvalidDicom("RLE fragment count"));
        }
        return Ok((0..count).map(|i| i..i + 1).collect());
    }
    if count == 1 {
        return Ok(std::iter::once(0..fragments.len()).collect());
    }
    if file.syntax.wavelet() && fragments.len() == count {
        for fragment in fragments {
            let data = &file.bytes[fragment.bytes.clone()];
            if !data.starts_with(&[0xff, 0x4f, 0xff, 0x51])
                || !(data.ends_with(&[0xff, 0xd9]) || data.ends_with(&[0xff, 0xd9, 0]))
            {
                return Err(Error::InvalidDicom("wavelet frame boundaries"));
            }
        }
        return Ok((0..count).map(|i| i..i + 1).collect());
    }
    if file.syntax.jpeg_markers() {
        let mut reader = JpegStream::new(fragments.iter().map(|f| &file.bytes[f.bytes.clone()]));
        let mut ranges = Vec::with_capacity(count);
        while let Some(start) = reader.current_index() {
            if ranges.len() >= limits.frames || ranges.len() >= count {
                return Err(Error::InvalidDicom("more encoded frames than declared"));
            }
            reader.codestream(file.syntax)?;
            let end = reader.finish_fragment()?;
            ranges.push(start..end);
        }
        if ranges.len() != count {
            return Err(Error::InvalidDicom("fewer encoded frames than declared"));
        }
        return Ok(ranges);
    }
    Err(Error::Unsupported(
        "ambiguous encapsulated frame boundaries",
    ))
}

fn decode_native(raw: &[u8], format: PixelFormat, order: ByteOrder) -> Samples {
    if format.photometric.is_monochrome() {
        let values = if format.bits_allocated == 8 {
            raw.iter()
                .map(|&v| format.stored(u16::from(v), false))
                .collect()
        } else {
            raw.as_chunks::<2>()
                .0
                .iter()
                .map(|&p| format.stored(order.u16(p), false))
                .collect()
        };
        return Samples::Monochrome(values);
    }
    let space = if format.photometric == Photometric::Rgb {
        ColorSpace::Rgb
    } else {
        ColorSpace::YbrFull
    };
    let values = if format.photometric == Photometric::YbrFull422 {
        raw.as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[2], p[3], p[1], p[2], p[3]])
            .collect()
    } else if format.planar {
        let n = format.pixels();
        (0..n)
            .flat_map(|i| [raw[i], raw[i + n], raw[i + n * 2]])
            .collect()
    } else {
        raw.to_vec()
    };
    Samples::Color { space, values }
}

fn decode_rle(raw: &[u8], format: PixelFormat) -> Result<Samples> {
    if raw.len() < 64 {
        return Err(Error::Decode("RLE header"));
    }
    let word = |i| {
        usize::try_from(u32::from_le_bytes(
            raw[i..i + 4].try_into().expect("RLE word"),
        ))
        .expect("u32 fits usize")
    };
    let bytes_per_sample = usize::from(format.bits_allocated / 8);
    let segments = format.components() * bytes_per_sample;
    if word(0) != segments || word(4) != 64 {
        return Err(Error::Decode("RLE segment count"));
    }
    let mut planes = Vec::with_capacity(segments);
    for i in 0..segments {
        let start = word(4 + 4 * i);
        let end = if i + 1 == segments {
            raw.len()
        } else {
            word(8 + 4 * i)
        };
        let data = raw
            .get(start..end)
            .filter(|p| !p.is_empty())
            .ok_or(Error::Decode("RLE segment offsets"))?;
        let mut expanded = Vec::with_capacity(format.pixels());
        let mut rest = data;
        let columns = format.columns as usize;
        while expanded.len() < format.pixels() {
            let (&control, next) = rest
                .split_first()
                .ok_or(Error::Decode("short RLE segment"))?;
            rest = next;
            let (length, payload) = match control {
                128 => continue,
                0..=127 => (usize::from(control) + 1, usize::from(control) + 1),
                _ => (257 - usize::from(control), 1),
            };
            if length > columns - expanded.len() % columns || payload > rest.len() {
                return Err(Error::Decode("RLE run crosses row or segment"));
            }
            if control < 128 {
                expanded.extend_from_slice(&rest[..payload]);
            } else {
                expanded.resize(expanded.len() + length, rest[0]);
            }
            rest = &rest[payload..];
        }
        let tail = rest.strip_suffix(&[0]).unwrap_or(rest);
        if tail.iter().any(|&b| b != 128) {
            return Err(Error::Decode("RLE trailing runs"));
        }
        planes.push(expanded);
    }
    if format.photometric.is_monochrome() {
        let values = if bytes_per_sample == 1 {
            planes[0]
                .iter()
                .map(|&v| format.stored(u16::from(v), false))
                .collect()
        } else {
            planes[0]
                .iter()
                .zip(&planes[1])
                .map(|(&hi, &lo)| format.stored(u16::from_be_bytes([hi, lo]), false))
                .collect()
        };
        Ok(Samples::Monochrome(values))
    } else {
        let values = (0..format.pixels())
            .flat_map(|i| [planes[0][i], planes[1][i], planes[2][i]])
            .collect();
        let space = if format.photometric == Photometric::Rgb {
            ColorSpace::Rgb
        } else {
            ColorSpace::YbrFull
        };
        Ok(Samples::Color { space, values })
    }
}

fn decode_jpeg(raw: &[u8], format: PixelFormat, syntax: TransferSyntax) -> Result<Samples> {
    let mut stream = JpegStream::new(std::iter::once(raw));
    let sof = stream.codestream(syntax)?;
    stream.finish_fragment()?;
    if u32::from(sof.rows) != format.rows
        || u32::from(sof.columns) != format.columns
        || sof.components as usize != format.components()
        || sof.precision != format.bits_stored
    {
        return Err(Error::InvalidDicom("JPEG header differs from Pixel Module"));
    }
    #[cfg(feature = "advanced-codecs")]
    if matches!(
        syntax,
        TransferSyntax::JpegLsLossless | TransferSyntax::JpegLsNearLossless
    ) || format.bits_stored == 12 && syntax == TransferSyntax::JpegExtended
    {
        return advanced::decode_extended_jpeg(raw, format, syntax);
    }
    let mut decoder = Decoder::new(raw);
    decoder.set_max_decoding_buffer_size(format.pixels() * format.components() * 2);
    if !format.photometric.is_monochrome() {
        decoder.set_color_transform(if format.photometric == Photometric::Rgb {
            ColorTransform::RGB
        } else {
            ColorTransform::YCbCr
        });
    }
    let data = decoder
        .decode()
        .map_err(|_| Error::Decode("JPEG samples"))?;
    let info = decoder.info().ok_or(Error::Decode("JPEG output format"))?;
    let pixels = format.pixels();
    match info.pixel_format {
        JpegFormat::L8 if format.components() == 1 && data.len() == pixels => {
            Ok(Samples::Monochrome(
                data.iter()
                    .map(|&v| format.stored(u16::from(v), true))
                    .collect(),
            ))
        }
        JpegFormat::L16 if format.components() == 1 && data.len() == pixels * 2 => {
            Ok(Samples::Monochrome(
                data.as_chunks::<2>()
                    .0
                    .iter()
                    .map(|&v| format.stored(u16::from_ne_bytes(v), true))
                    .collect(),
            ))
        }
        JpegFormat::RGB24 if format.components() == 3 && data.len() == pixels * 3 => {
            Ok(Samples::Color {
                space: ColorSpace::Rgb,
                values: data,
            })
        }
        _ => Err(Error::Decode("JPEG output length or layout")),
    }
}

struct Sof {
    precision: u8,
    rows: u16,
    columns: u16,
    components: u8,
}

/// Reads markers across fragments. Entropy bytes and length-delimited segments can contain FF D9.
struct JpegStream<'a, I> {
    remaining: I,
    bytes: &'a [u8],
    index: usize,
}

impl<'a, I: Iterator<Item = &'a [u8]>> JpegStream<'a, I> {
    fn new(mut remaining: I) -> Self {
        let bytes = remaining.next().unwrap_or_default();
        Self {
            remaining,
            bytes,
            index: 0,
        }
    }

    fn current_index(&self) -> Option<usize> {
        (!self.bytes.is_empty()).then_some(self.index)
    }

    fn byte(&mut self) -> Result<u8> {
        if self.bytes.is_empty() {
            self.bytes = self
                .remaining
                .next()
                .ok_or(Error::Decode("truncated JPEG codestream"))?;
            self.index += 1;
        }
        let (&byte, rest) = self
            .bytes
            .split_first()
            .ok_or(Error::Decode("empty JPEG fragment"))?;
        self.bytes = rest;
        Ok(byte)
    }

    fn word(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes([self.byte()?, self.byte()?]))
    }

    fn skip(&mut self, mut len: usize) -> Result<()> {
        while len > self.bytes.len() {
            len -= self.bytes.len();
            self.bytes = self
                .remaining
                .next()
                .ok_or(Error::Decode("truncated JPEG segment"))?;
            self.index += 1;
        }
        self.bytes = &self.bytes[len..];
        Ok(())
    }

    fn finish_fragment(&mut self) -> Result<usize> {
        if !matches!(self.bytes, [] | [0]) {
            return Err(Error::Decode("frame does not end at a fragment boundary"));
        }
        self.bytes = self.remaining.next().unwrap_or_default();
        self.index += 1;
        Ok(self.index)
    }

    fn marker(&mut self, entropy: bool, ls: bool) -> Result<u8> {
        loop {
            if self.byte()? != 0xff {
                if entropy {
                    continue;
                }
                return Err(Error::Decode("expected JPEG marker"));
            }
            let mut next = self.byte()?;
            while next == 0xff {
                next = self.byte()?;
            }
            if entropy && (next == 0 || (ls && next < 0x80) || (0xd0..=0xd7).contains(&next)) {
                continue;
            }
            return Ok(next);
        }
    }

    fn codestream(&mut self, syntax: TransferSyntax) -> Result<Sof> {
        if self.word()? != 0xffd8 {
            return Err(Error::Decode("JPEG SOI"));
        }
        let expected = match syntax {
            TransferSyntax::JpegBaseline => 0xc0,
            TransferSyntax::JpegExtended => 0xc1,
            TransferSyntax::JpegLossless | TransferSyntax::JpegLosslessSv1 => 0xc3,
            TransferSyntax::JpegLsLossless | TransferSyntax::JpegLsNearLossless => 0xf7,
            _ => return Err(Error::Internal),
        };
        let mut sof = None;
        let mut saw_scan = false;
        let mut entropy = false;
        loop {
            let marker = self.marker(entropy, expected == 0xf7)?;
            if marker == 0xd9 {
                if !saw_scan {
                    return Err(Error::Decode("missing JPEG scan"));
                }
                return sof.ok_or(Error::Decode("JPEG frame header"));
            }
            if matches!(marker, 0 | 1 | 0xd0..=0xd8) {
                return Err(Error::Decode("unexpected JPEG marker"));
            }
            let len = usize::from(self.word()?)
                .checked_sub(2)
                .ok_or(Error::Decode("JPEG segment length"))?;
            entropy = marker == 0xda;
            if marker == expected || (expected == 0xc1 && marker == 0xc0) {
                if len < 6 || sof.is_some() {
                    return Err(Error::Decode("JPEG frame header"));
                }
                let precision = self.byte()?;
                let rows = self.word()?;
                let columns = self.word()?;
                let components = self.byte()?;
                if rows == 0 || columns == 0 || len != 6 + usize::from(components) * 3 {
                    return Err(Error::Decode("JPEG frame dimensions"));
                }
                self.skip(len - 6)?;
                sof = Some(Sof {
                    precision,
                    rows,
                    columns,
                    components,
                });
            } else if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf | 0xf7)
            {
                return Err(Error::InvalidDicom(
                    "JPEG coding process differs from transfer syntax",
                ));
            } else if entropy {
                if len < 4 || sof.is_none() {
                    return Err(Error::Decode("JPEG scan header"));
                }
                let components = usize::from(self.byte()?);
                if len != 4 + components * 2 || components == 0 || components > 3 {
                    return Err(Error::Decode("JPEG scan components"));
                }
                self.skip(components * 2)?;
                let parameter = self.byte()?;
                if (syntax == TransferSyntax::JpegLosslessSv1 && parameter != 1)
                    || (syntax == TransferSyntax::JpegLsLossless && parameter != 0)
                {
                    return Err(Error::InvalidDicom(
                        "JPEG scan parameter differs from transfer syntax",
                    ));
                }
                self.skip(2)?;
                saw_scan = true;
            } else {
                self.skip(len)?;
            }
        }
    }
}
