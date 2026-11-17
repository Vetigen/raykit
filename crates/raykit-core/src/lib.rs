mod codec;
mod dicom;
mod source;

pub mod geometry;
pub mod interop;
pub mod measurement;
pub mod pixel;
pub mod volume;

pub use source::{
    Capabilities, Frame, FrameGeometry, Inspection, Memory, Object, Sample, Session, TransferSyntax,
};

use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum Error {
    InvalidDicom(&'static str),
    Integrity(&'static str),
    Unsupported(&'static str),
    Limit(&'static str),
    Decode(&'static str),
    Geometry(&'static str),
    InvalidRequest(&'static str),
    Closed,
    Cancelled,
    Internal,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    pub source_bytes: usize,
    pub inflated_bytes: usize,
    pub frame_pixels: usize,
    pub frames: usize,
    pub elements: usize,
    pub fragments: usize,
    pub cache_bytes: usize,
    pub cache_frames: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            source_bytes: 192 * 1024 * 1024,
            inflated_bytes: 192 * 1024 * 1024,
            frame_pixels: 16 * 1024 * 1024,
            frames: 4096,
            elements: 100_000,
            fragments: 65_536,
            cache_bytes: 64 * 1024 * 1024,
            cache_frames: 2,
        }
    }
}

impl Limits {
    pub(crate) fn validate(self) -> Result<()> {
        let ceiling = Self::default();
        if self.source_bytes > ceiling.source_bytes
            || self.inflated_bytes > ceiling.inflated_bytes
            || self.frame_pixels > ceiling.frame_pixels
            || self.frames > ceiling.frames
            || self.elements > ceiling.elements
            || self.fragments > ceiling.fragments
            || self.cache_bytes > ceiling.cache_bytes
            || self.cache_frames > 8
        {
            return Err(Error::Limit("session limits"));
        }
        Ok(())
    }
}
