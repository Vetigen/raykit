use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::{
    Error, Limits, Result, TransferSyntax,
    codec::MAX_ENCODED_FRAME_BYTES,
    dicom::{File, Fragment, source_digest},
};

pub const MAX_FRAME_INDEX_BYTES: usize = 8 * 1024 * 1024;
const SIGNATURE: &[u8; 4] = b"RKI1";
const JPEG_BASELINE: &str = "1.2.840.10008.1.2.4.50";

#[derive(Debug)]
pub struct FrameIndex {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct FrameRange {
    pub start: usize,
    pub end: usize,
    pub source_bytes: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DetachedIndex {
    pub source_bytes: usize,
    source_sha256: String,
    syntax_uid: String,
    pixel_extent: Range<usize>,
    frames: Vec<EncodedFrame>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedFrame {
    fragments: Vec<[usize; 2]>,
    sha256: String,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", source_digest(bytes))
}

fn digest_text(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

impl DetachedIndex {
    pub fn encode(
        file: &File,
        fragments: &[Fragment],
        frames: &[Range<usize>],
    ) -> Result<FrameIndex> {
        if file.syntax != TransferSyntax::JpegBaseline {
            return Err(Error::Unsupported("frame indexes require JPEG Baseline"));
        }
        let pixel_extent = file.pixel_extent.clone().ok_or(Error::Internal)?;
        let mut encoded = Self {
            source_bytes: file.source_bytes,
            source_sha256: file.sha256.clone(),
            syntax_uid: JPEG_BASELINE.to_owned(),
            pixel_extent,
            frames: Vec::with_capacity(frames.len()),
        };
        for frame in frames {
            let fragments = &fragments[frame.clone()];
            let first = fragments.first().ok_or(Error::Internal)?.bytes.start;
            let end = fragments.last().ok_or(Error::Internal)?.bytes.end;
            if end - first > MAX_ENCODED_FRAME_BYTES {
                return Err(Error::Limit("indexed frame bytes"));
            }
            encoded.frames.push(EncodedFrame {
                fragments: fragments
                    .iter()
                    .map(|f| [f.bytes.start, f.bytes.end])
                    .collect(),
                sha256: hash(&file.bytes[first..end]),
            });
        }
        let table = serde_json::to_vec(&encoded).map_err(|_| Error::Internal)?;
        let size = 8 + table.len() + file.bytes.len() - encoded.pixel_extent.len();
        if size > MAX_FRAME_INDEX_BYTES {
            return Err(Error::Limit("frame index bytes"));
        }
        let mut bytes = Vec::with_capacity(size);
        bytes.extend_from_slice(SIGNATURE);
        bytes.extend_from_slice(&(table.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&table);
        bytes.extend_from_slice(&file.bytes[..encoded.pixel_extent.start]);
        bytes.extend_from_slice(&file.bytes[encoded.pixel_extent.end..]);
        Ok(FrameIndex {
            sha256: hash(&bytes),
            bytes,
        })
    }

    /// A digest pinned by the caller authenticates the complete manifest, including metadata.
    pub fn open(
        bytes: &[u8],
        pin: &str,
        limits: Limits,
        expected_source: Option<&str>,
    ) -> Result<(Self, File)> {
        limits.validate()?;
        if bytes.len() > MAX_FRAME_INDEX_BYTES {
            return Err(Error::Limit("frame index bytes"));
        }
        if !digest_text(pin) || !hash(bytes).eq_ignore_ascii_case(pin) {
            return Err(Error::Integrity("frame index SHA-256"));
        }
        if bytes.get(..4) != Some(SIGNATURE) {
            return Err(Error::Unsupported("frame index version"));
        }
        let length = bytes
            .get(4..8)
            .ok_or(Error::Integrity("frame index header"))?;
        let end = (u32::from_le_bytes(length.try_into().map_err(|_| Error::Internal)?) as usize)
            .checked_add(8)
            .ok_or(Error::Integrity("frame index table length"))?;
        let table = bytes
            .get(8..end)
            .ok_or(Error::Integrity("frame index table length"))?;
        let index: Self =
            serde_json::from_slice(table).map_err(|_| Error::Integrity("frame index table"))?;
        let metadata = &bytes[end..];
        if index.source_bytes > limits.source_bytes {
            return Err(Error::Limit("indexed source bytes"));
        }
        if !digest_text(&index.source_sha256)
            || expected_source.is_some_and(|hash| !index.source_sha256.eq_ignore_ascii_case(hash))
        {
            return Err(Error::Integrity("indexed source SHA-256"));
        }
        if index.syntax_uid != JPEG_BASELINE
            || index.frames.is_empty()
            || index.frames.len() > limits.frames
            || index.pixel_extent.start < 132
            || index.pixel_extent.start >= index.pixel_extent.end
            || index.pixel_extent.end > index.source_bytes
            || metadata.len() != index.source_bytes - index.pixel_extent.len()
        {
            return Err(Error::Integrity("frame index source representation"));
        }
        let mut fragments = 0;
        let mut last_end = None;
        for frame in &index.frames {
            let Some([start, _]) = frame.fragments.first() else {
                return Err(Error::Integrity("empty indexed frame"));
            };
            if !digest_text(&frame.sha256) || *start < index.pixel_extent.start + 20 {
                return Err(Error::Integrity("indexed frame digest or offset"));
            }
            for &[a, b] in &frame.fragments {
                fragments += 1;
                if fragments > limits.fragments
                    || b > index.pixel_extent.end - 8
                    || b < a.saturating_add(2)
                    || !a.is_multiple_of(2)
                    || !b.is_multiple_of(2)
                    || last_end.is_some_and(|end: usize| end + 8 != a)
                {
                    return Err(Error::Integrity("indexed fragment extent"));
                }
                last_end = Some(b);
            }
            if last_end.ok_or(Error::Internal)? - start > MAX_ENCODED_FRAME_BYTES {
                return Err(Error::Limit("indexed frame bytes"));
            }
        }
        if last_end != Some(index.pixel_extent.end - 8) {
            return Err(Error::Integrity("indexed pixel data length"));
        }
        let file = File::parse_dataset(
            metadata.to_vec(),
            limits,
            index.source_bytes,
            index.source_sha256.to_ascii_lowercase(),
        )?;
        if file.syntax != TransferSyntax::JpegBaseline || file.pixel_extent.is_some() {
            return Err(Error::Integrity("indexed file metadata"));
        }
        Ok((index, file))
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn bytes(&self) -> usize {
        self.frames.capacity() * size_of::<EncodedFrame>()
            + self
                .frames
                .iter()
                .map(|f| f.fragments.capacity() * size_of::<[usize; 2]>() + f.sha256.capacity())
                .sum::<usize>()
    }

    pub fn range(&self, frame: usize) -> Result<FrameRange> {
        let fragments = &self
            .frames
            .get(frame)
            .ok_or(Error::InvalidRequest("frame index"))?
            .fragments;
        Ok(FrameRange {
            start: fragments[0][0],
            end: fragments.last().ok_or(Error::Internal)?[1],
            source_bytes: self.source_bytes,
        })
    }

    pub fn verify(&self, frame: usize, bytes: &[u8]) -> Result<()> {
        let range = self.range(frame)?;
        if bytes.len() != range.end - range.start
            || !hash(bytes).eq_ignore_ascii_case(&self.frames[frame].sha256)
        {
            return Err(Error::Integrity("indexed frame bytes"));
        }
        Ok(())
    }

    pub fn joined(&self, frame: usize, bytes: &[u8]) -> Result<Vec<u8>> {
        let range = self.range(frame)?;
        let fragments = &self.frames[frame].fragments;
        Ok(fragments
            .iter()
            .flat_map(|&[a, b]| bytes[a - range.start..b - range.start].iter().copied())
            .collect())
    }

    pub fn fragmented(&self, frame: usize) -> bool {
        self.frames[frame].fragments.len() > 1
    }
}
