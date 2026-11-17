use std::{borrow::Cow, ops::Range, sync::Arc};

use sha2::{Digest, Sha256};

use crate::{
    Error, Limits, Result, TransferSyntax,
    codec::MAX_ENCODED_FRAME_BYTES,
    dicom::{File, Fragment},
    frame_index::MAX_FRAME_INDEX_BYTES,
};

type Hash = [u8; 32];
const SIGNATURE: &[u8; 4] = b"RKP1";
const MAX_REVISION_BYTES: usize = 256;
pub const MAX_FRAME_PROOF_BYTES: usize =
    MAX_ENCODED_FRAME_BYTES + MAX_FRAME_INDEX_BYTES + 1024 * 1024;

fn hash(parts: &[&[u8]]) -> Hash {
    let mut sha = Sha256::new();
    for part in parts {
        sha.update(part);
    }
    sha.finalize().into()
}

fn leaf(header: &Hash, record: &[u8], bytes: &[u8]) -> Hash {
    hash(&[&[0], header, record, &hash(&[bytes])])
}

fn node(left: &Hash, right: &Hash) -> Hash {
    hash(&[&[1], left, right])
}

fn hex(hash: &Hash) -> String {
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn push_size(out: &mut Vec<u8>, value: usize) {
    out.extend_from_slice(&(value as u32).to_le_bytes());
}

fn take<'a>(bytes: &mut &'a [u8], count: usize) -> Result<&'a [u8]> {
    let (head, rest) = bytes
        .split_at_checked(count)
        .ok_or(Error::Integrity("truncated frame proof"))?;
    *bytes = rest;
    Ok(head)
}

fn size(bytes: &mut &[u8]) -> Result<usize> {
    Ok(u32::from_le_bytes(take(bytes, 4)?.try_into().map_err(|_| Error::Internal)?) as usize)
}

/// Proofs prepared from an already authenticated, complete JPEG Baseline source.
pub struct FrameProofCatalog {
    source: Arc<File>,
    header: Vec<u8>,
    records: Vec<(Vec<u8>, Range<usize>)>,
    tree: Vec<Hash>,
    leaf_start: usize,
}

impl FrameProofCatalog {
    pub(crate) fn new(
        source: Arc<File>,
        fragments: &[Fragment],
        frames: &[Range<usize>],
        revision: &str,
    ) -> Result<Self> {
        if source.syntax != TransferSyntax::JpegBaseline {
            return Err(Error::Unsupported("frame proofs require JPEG Baseline"));
        }
        if revision.is_empty() || revision.len() > MAX_REVISION_BYTES {
            return Err(Error::InvalidRequest("frame proof revision"));
        }
        let pixels = source.pixel_extent.clone().ok_or(Error::Internal)?;
        let metadata = source.bytes.len() - pixels.len();
        if metadata + 84 + revision.len() > MAX_FRAME_INDEX_BYTES {
            return Err(Error::Limit("frame proof metadata"));
        }
        let mut header = Vec::with_capacity(metadata + 84 + revision.len());
        for value in [
            source.source_bytes,
            pixels.start,
            pixels.end,
            frames.len(),
            revision.len(),
        ] {
            push_size(&mut header, value);
        }
        header.extend_from_slice(source.sha256.as_bytes());
        header.extend_from_slice(revision.as_bytes());
        header.extend_from_slice(&source.bytes[..pixels.start]);
        header.extend_from_slice(&source.bytes[pixels.end..]);
        let header_hash = hash(&[&header]);
        let leaf_start = frames.len().next_power_of_two();
        let mut tree = vec![hash(&[&[2]]); leaf_start * 2];
        let mut records = Vec::with_capacity(frames.len());
        for (index, frame) in frames.iter().enumerate() {
            let parts = fragments.get(frame.clone()).ok_or(Error::Internal)?;
            let span = parts.first().ok_or(Error::Internal)?.bytes.start
                ..parts.last().ok_or(Error::Internal)?.bytes.end;
            if span.len() > MAX_ENCODED_FRAME_BYTES {
                return Err(Error::Limit("encoded frame proof bytes"));
            }
            let mut record = Vec::with_capacity(8 + parts.len() * 8);
            push_size(&mut record, index);
            push_size(&mut record, parts.len());
            for part in parts {
                push_size(&mut record, part.bytes.start);
                push_size(&mut record, part.bytes.end);
            }
            tree[leaf_start + index] = leaf(&header_hash, &record, &source.bytes[span.clone()]);
            records.push((record, span));
        }
        for i in (1..leaf_start).rev() {
            tree[i] = node(&tree[i * 2], &tree[i * 2 + 1]);
        }
        Ok(Self {
            source,
            header,
            records,
            tree,
            leaf_start,
        })
    }

    pub fn root_sha256(&self) -> String {
        hex(&self.tree[1])
    }

    pub fn frames(&self) -> usize {
        self.records.len()
    }

    pub fn packet(&self, frame: usize) -> Result<Vec<u8>> {
        let (record, span) = self
            .records
            .get(frame)
            .ok_or(Error::InvalidRequest("frame index"))?;
        let mut path = self.leaf_start + frame;
        let depth = self.leaf_start.trailing_zeros() as usize;
        let mut packet =
            Vec::with_capacity(16 + self.header.len() + record.len() + 32 * depth + span.len());
        packet.extend_from_slice(SIGNATURE);
        push_size(&mut packet, self.header.len());
        packet.extend_from_slice(&self.header);
        push_size(&mut packet, record.len());
        packet.extend_from_slice(record);
        push_size(&mut packet, depth);
        while path > 1 {
            packet.extend_from_slice(&self.tree[path ^ 1]);
            path /= 2;
        }
        packet.extend_from_slice(&self.source.bytes[span.clone()]);
        Ok(packet)
    }
}

pub(crate) struct ProofIndex {
    pub count: usize,
    header_hash: Hash,
    root: Hash,
    pixels: Range<usize>,
    limits: Limits,
}

pub(crate) struct VerifiedFrame {
    pub index: usize,
    pub packet: Vec<u8>,
    body: Range<usize>,
    fragments: Vec<Range<usize>>,
}

impl VerifiedFrame {
    pub fn jpeg(&self) -> Cow<'_, [u8]> {
        let body = &self.packet[self.body.clone()];
        if self.fragments.len() == 1 {
            Cow::Borrowed(body)
        } else {
            Cow::Owned(
                self.fragments
                    .iter()
                    .flat_map(|range| body[range.clone()].iter().copied())
                    .collect(),
            )
        }
    }
}

fn header(packet: &[u8]) -> Result<(&[u8], &[u8])> {
    if packet.len() > MAX_FRAME_PROOF_BYTES {
        return Err(Error::Limit("frame proof bytes"));
    }
    let mut data = packet;
    if take(&mut data, 4)? != SIGNATURE {
        return Err(Error::Unsupported("frame proof version"));
    }
    let len = size(&mut data)?;
    if len > MAX_FRAME_INDEX_BYTES {
        return Err(Error::Limit("frame proof metadata"));
    }
    Ok((take(&mut data, len)?, data))
}

impl ProofIndex {
    pub fn open(
        packet: Vec<u8>,
        pin: &str,
        revision: &str,
        frame: usize,
        limits: Limits,
        expected_source: Option<&str>,
    ) -> Result<(Self, File, VerifiedFrame)> {
        limits.validate()?;
        if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Integrity("frame proof pin"));
        }
        let mut root = [0; 32];
        for (i, byte) in root.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&pin[i * 2..i * 2 + 2], 16)
                .map_err(|_| Error::Integrity("frame proof pin"))?;
        }
        let (header, _) = header(&packet)?;
        let mut metadata = header;
        let length = size(&mut metadata)?;
        let pixels = size(&mut metadata)?..size(&mut metadata)?;
        let count = size(&mut metadata)?;
        let revision_len = size(&mut metadata)?;
        let digest = std::str::from_utf8(take(&mut metadata, 64)?)
            .map_err(|_| Error::Integrity("proof source digest"))?;
        if length > limits.source_bytes || count > limits.frames {
            return Err(Error::Limit("proof source size or frame count"));
        }
        if !digest.bytes().all(|b| b.is_ascii_hexdigit())
            || expected_source.is_some_and(|sha| !sha.eq_ignore_ascii_case(digest))
            || !(1..=MAX_REVISION_BYTES).contains(&revision_len)
            || take(&mut metadata, revision_len)? != revision.as_bytes()
            || count == 0
            || pixels.start < 132
            || pixels.len() < 28
            || pixels.end > length
            || metadata.len() != length - pixels.len()
        {
            return Err(Error::Integrity("frame proof source or revision"));
        }
        let index = Self {
            count,
            header_hash: hash(&[header]),
            root,
            pixels,
            limits,
        };
        let (body, fragments) = index.validate(&packet, frame)?;
        let file = File::parse_dataset(
            metadata.to_vec(),
            limits,
            length,
            digest.to_ascii_lowercase(),
        )?;
        if file.syntax != TransferSyntax::JpegBaseline || file.pixel_extent.is_some() {
            return Err(Error::Integrity("frame proof metadata"));
        }
        Ok((
            index,
            file,
            VerifiedFrame {
                index: frame,
                packet,
                body,
                fragments,
            },
        ))
    }

    pub fn stage(&self, packet: Vec<u8>, index: usize) -> Result<VerifiedFrame> {
        let (body, fragments) = self.validate(&packet, index)?;
        Ok(VerifiedFrame {
            index,
            packet,
            body,
            fragments,
        })
    }

    fn validate(&self, packet: &[u8], frame: usize) -> Result<(Range<usize>, Vec<Range<usize>>)> {
        let (header, mut content) = header(packet)?;
        if frame >= self.count || hash(&[header]) != self.header_hash {
            return Err(Error::Integrity("frame proof header"));
        }
        let record_len = size(&mut content)?;
        let record = take(&mut content, record_len)?;
        let siblings = size(&mut content)?;
        if siblings != self.count.next_power_of_two().trailing_zeros() as usize {
            return Err(Error::Integrity("frame proof depth"));
        }
        let proof = take(&mut content, siblings * 32)?;
        let mut words = record;
        let index = size(&mut words)?;
        let count = size(&mut words)?;
        if index != frame
            || count == 0
            || count > self.limits.fragments
            || words.len() != count * 8
            || content.len() > MAX_ENCODED_FRAME_BYTES
        {
            return Err(Error::Integrity("frame proof record"));
        }
        let start = size(&mut &words[..])?;
        if start < self.pixels.start + 20 {
            return Err(Error::Integrity("frame proof fragment start"));
        }
        let mut fragments = Vec::with_capacity(count);
        let mut last_end = None;
        for _ in 0..count {
            let lo = size(&mut words)?;
            let hi = size(&mut words)?;
            if hi > self.pixels.end - 8
                || hi < lo.saturating_add(2)
                || !lo.is_multiple_of(2)
                || !hi.is_multiple_of(2)
                || last_end.is_some_and(|end| end + 8 != lo)
            {
                return Err(Error::Integrity("frame proof fragment extent"));
            }
            last_end = Some(hi);
            fragments.push(lo - start..hi - start);
        }
        if fragments.last().map(|range| range.end) != Some(content.len()) {
            return Err(Error::Integrity("frame proof payload length"));
        }
        let mut computed = leaf(&self.header_hash, record, content);
        for (level, sibling) in proof.as_chunks::<32>().0.iter().enumerate() {
            computed = if frame & (1 << level) == 0 {
                node(&computed, sibling)
            } else {
                node(sibling, &computed)
            };
        }
        if computed != self.root {
            return Err(Error::Integrity("frame proof root"));
        }
        Ok((packet.len() - content.len()..packet.len(), fragments))
    }
}
