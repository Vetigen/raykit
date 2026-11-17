use std::{collections::VecDeque, sync::Arc};

use serde::Serialize;

use crate::{
    Error, Limits, Result,
    codec::Index,
    dicom::{Dataset, File, Key, uid},
    geometry::{
        Anatomy, Calibration, PatientPlane, ProjectionCalibration, Region, UltrasoundRegion,
        valid_spacing,
    },
    pixel::{Display, Photometric, PixelFormat, RenderOptions, Samples, color_rgb, display},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferSyntax {
    ImplicitLe,
    ExplicitLe,
    ExplicitBe,
    Deflated,
    Rle,
    JpegBaseline,
    JpegExtended,
    JpegLossless,
    JpegLosslessSv1,
    JpegLsLossless,
    JpegLsNearLossless,
    Jpeg2000Lossless,
    Jpeg2000,
    Htj2kLossless,
    Htj2kLosslessRpcl,
    Htj2k,
    Mpeg2,
    Mpeg4,
    Hevc,
}

impl TransferSyntax {
    pub(crate) fn from_uid(uid: &str) -> Result<Self> {
        use TransferSyntax::*;
        match uid.strip_prefix("1.2.840.10008.1.2") {
            Some("") => Ok(ImplicitLe),
            Some(".1") => Ok(ExplicitLe),
            Some(".2") => Ok(ExplicitBe),
            Some(".1.99") => Ok(Deflated),
            Some(".5") => Ok(Rle),
            Some(".4.50") => Ok(JpegBaseline),
            Some(".4.51") => Ok(JpegExtended),
            Some(".4.57") => Ok(JpegLossless),
            Some(".4.70") => Ok(JpegLosslessSv1),
            Some(".4.80") => Ok(JpegLsLossless),
            Some(".4.81") => Ok(JpegLsNearLossless),
            Some(".4.90") => Ok(Jpeg2000Lossless),
            Some(".4.91") => Ok(Jpeg2000),
            Some(".4.201") => Ok(Htj2kLossless),
            Some(".4.202") => Ok(Htj2kLosslessRpcl),
            Some(".4.203") => Ok(Htj2k),
            Some(".4.100" | ".4.100.1" | ".4.101" | ".4.101.1") => Ok(Mpeg2),
            Some(
                ".4.102" | ".4.102.1" | ".4.103" | ".4.103.1" | ".4.104" | ".4.104.1" | ".4.105"
                | ".4.105.1" | ".4.106" | ".4.106.1",
            ) => Ok(Mpeg4),
            Some(".4.107" | ".4.108") => Ok(Hevc),
            _ => Err(Error::Unsupported("transfer syntax UID")),
        }
    }

    pub(crate) fn encapsulated(self) -> bool {
        !matches!(
            self,
            Self::ImplicitLe | Self::ExplicitLe | Self::ExplicitBe | Self::Deflated
        )
    }

    pub(crate) fn jpeg_markers(self) -> bool {
        matches!(
            self,
            Self::JpegBaseline
                | Self::JpegExtended
                | Self::JpegLossless
                | Self::JpegLosslessSv1
                | Self::JpegLsLossless
                | Self::JpegLsNearLossless
        )
    }

    fn video(self) -> bool {
        matches!(self, Self::Mpeg2 | Self::Mpeg4 | Self::Hevc)
    }

    pub(crate) fn wavelet(self) -> bool {
        matches!(
            self,
            Self::Jpeg2000Lossless
                | Self::Jpeg2000
                | Self::Htj2kLossless
                | Self::Htj2kLosslessRpcl
                | Self::Htj2k
        )
    }

    fn supports(self, format: PixelFormat) -> bool {
        let gray = format.photometric.is_monochrome();
        match self {
            Self::ImplicitLe | Self::ExplicitLe | Self::ExplicitBe | Self::Deflated => true,
            Self::Rle => format.photometric != Photometric::YbrFull422,
            Self::JpegBaseline => {
                format.bits_stored == 8 && format.bits_allocated == 8 && !format.signed
            }
            Self::JpegExtended => {
                gray && !format.signed
                    && (format.bits_stored == 8
                        || cfg!(feature = "advanced-codecs") && format.bits_stored == 12)
            }
            Self::JpegLossless | Self::JpegLosslessSv1 => gray,
            Self::JpegLsLossless | Self::JpegLsNearLossless => {
                cfg!(feature = "advanced-codecs")
                    && gray
                    && format.bits_stored >= 2
                    && (self == Self::JpegLsLossless || !format.signed)
            }
            syntax if syntax.wavelet() => {
                cfg!(feature = "advanced-codecs") && gray && format.bits_stored >= 8
            }
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Object {
    Projection,
    Ultrasound,
    Ct,
    EnhancedCt,
    Mr,
    EnhancedMr,
    Pdf,
    StructuredReport,
    Segmentation,
    PresentationState,
    Other,
}

impl Object {
    fn from_uid(uid: &str) -> Self {
        match uid.strip_prefix("1.2.840.10008.5.1.4.1.1.") {
            Some("1" | "1.1" | "1.1.1" | "1.3" | "1.3.1") => Self::Projection,
            Some("3" | "3.1" | "6" | "6.1") => Self::Ultrasound,
            Some("2") => Self::Ct,
            Some("2.1") => Self::EnhancedCt,
            Some("4") => Self::Mr,
            Some("4.1") => Self::EnhancedMr,
            Some("104.1") => Self::Pdf,
            Some("88.11" | "88.22" | "88.33" | "88.34") => Self::StructuredReport,
            Some("66.4") => Self::Segmentation,
            Some("11.1") => Self::PresentationState,
            _ => Self::Other,
        }
    }

    fn is_image(self) -> bool {
        matches!(
            self,
            Self::Projection
                | Self::Ultrasound
                | Self::Ct
                | Self::EnhancedCt
                | Self::Mr
                | Self::EnhancedMr
        )
    }

    fn is_enhanced(self) -> bool {
        matches!(self, Self::EnhancedCt | Self::EnhancedMr)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Capabilities {
    pub frame_access: bool,
    pub physical_measurement: bool,
    pub patient_coordinates: bool,
    pub volume_candidate: bool,
    pub dependent_video: bool,
    pub host_document: bool,
    pub frame_limitation: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FrameGeometry {
    pub calibration: Calibration,
    pub detector_spacing_xy: Option<[f64; 2]>,
    pub display_spacing_xy: [f64; 2],
    pub patient_plane: Option<PatientPlane>,
    pub anatomy: Anatomy,
    pub increasing_column: Option<Vec<&'static str>>,
    pub increasing_row: Option<Vec<&'static str>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Inspection {
    pub sop_class_uid: String,
    pub instance_uid: String,
    pub study_uid: Option<String>,
    pub series_uid: Option<String>,
    pub content_sha256: String,
    pub transfer_syntax: TransferSyntax,
    pub object: Object,
    pub frames: usize,
    pub pixel_format: Option<PixelFormat>,
    pub frame_durations_ms: Option<Vec<f64>>,
    pub initial_geometry: Option<FrameGeometry>,
    pub capabilities: Capabilities,
}

#[derive(Debug)]
pub struct Frame {
    pub index: usize,
    pub format: PixelFormat,
    pub samples: Samples,
    pub display: Option<Display>,
    pub geometry: FrameGeometry,
}

impl Frame {
    pub fn render_rgba(&self, options: RenderOptions) -> Result<Vec<u8>> {
        if let Some(window) = options.window {
            window.validate()?;
        }
        let mut rgba = Vec::with_capacity(self.format.pixels() * 4);
        match &self.samples {
            Samples::Monochrome(values) => {
                let display = self.display.as_ref().ok_or(Error::Internal)?;
                for &value in values {
                    rgba.extend_from_slice(&display.rgb(value, options));
                    rgba.push(255);
                }
            }
            Samples::Color { space, values } => {
                for &pixel in values.as_chunks::<3>().0 {
                    rgba.extend_from_slice(&color_rgb(*space, pixel));
                    rgba.push(255);
                }
            }
        }
        Ok(rgba)
    }

    pub fn sample(&self, x: u32, y: u32) -> Result<Sample> {
        if x >= self.format.columns || y >= self.format.rows {
            return Err(Error::InvalidRequest("pixel index"));
        }
        let at = (y * self.format.columns + x) as usize;
        Ok(match &self.samples {
            Samples::Monochrome(values) => {
                let stored = values[at];
                let display = self.display.as_ref().ok_or(Error::Internal)?;
                Sample::Monochrome {
                    stored,
                    modality: display.modality.at(stored),
                    padding: display.is_padding(stored),
                }
            }
            Samples::Color { space, values } => {
                let start = at * 3;
                Sample::Color {
                    space: *space,
                    values: values[start..start + 3].try_into().expect("RGB triplet"),
                }
            }
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Sample {
    Monochrome {
        stored: i32,
        modality: f64,
        padding: bool,
    },
    Color {
        space: crate::pixel::ColorSpace,
        values: [u8; 3],
    },
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Memory {
    pub source_bytes: usize,
    pub resident_dataset_bytes: usize,
    pub dataset_elements: usize,
    pub frame_index_bytes: usize,
    pub cached_pixel_bytes: usize,
    pub cached_frames: usize,
    pub peak_cached_pixel_bytes: usize,
    pub decoded_frames: u64,
    pub fragment_copy_bytes: u64,
    pub produced_pixel_bytes: u64,
}

pub struct Session {
    pub(crate) file: File,
    pub(crate) info: Inspection,
    limits: Limits,
    index: Option<Index>,
    frames: VecDeque<Arc<Frame>>,
    memory: Memory,
}

impl Session {
    pub fn open(bytes: Vec<u8>, limits: Limits) -> Result<Self> {
        Self::open_verified(bytes, limits, None)
    }

    pub fn open_verified(
        bytes: Vec<u8>,
        limits: Limits,
        expected_sha256: Option<&str>,
    ) -> Result<Self> {
        let file = File::parse(bytes, limits, expected_sha256)?;
        let d = &file.dataset;
        let object = Object::from_uid(&file.class_uid);
        let video = file.syntax.video();
        let frames = if object.is_image() {
            let key = (0x28, 8);
            match d.get(key) {
                Some(_) => d
                    .text(&file.bytes, key)
                    .and_then(|s| s.trim().parse().ok())
                    .filter(|&n| n != 0)
                    .ok_or(Error::InvalidDicom("number of frames"))?,
                None if !object.is_enhanced() => 1,
                _ => return Err(Error::InvalidDicom("missing Number of Frames")),
            }
        } else {
            0
        };
        if frames > limits.frames {
            return Err(Error::Limit("number of frames"));
        }
        if object.is_image() && !video {
            let key = (0x52_00, 0x9230);
            if d.get(key).is_some() && !d.sequence(key).is_some_and(|items| items.len() == frames) {
                return Err(Error::InvalidDicom("per-frame functional groups count"));
            }
            let key = (0x52_00, 0x9229);
            if d.get(key).is_some() && d.one(key).is_none() {
                return Err(Error::InvalidDicom("shared functional groups count"));
            }
        }
        let mut limitation = None;
        let format = if object.is_image() && !video {
            match read_format(&file, object, limits) {
                Ok(format) => Some(format),
                Err(Error::Unsupported(detail)) => {
                    limitation = Some(detail);
                    None
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let index = match format {
            Some(format) if file.syntax.supports(format) => {
                match Index::new(&file, format, frames, limits) {
                    Ok(index) => Some(index),
                    Err(Error::Unsupported(detail)) => {
                        limitation = Some(detail);
                        None
                    }
                    Err(error) => return Err(error),
                }
            }
            Some(_) => {
                limitation = Some("pixel profile for transfer syntax");
                None
            }
            None => None,
        };
        let geometry = format.map(|f| frame_geometry(&file, object, f, 0));
        let physical_measurement = geometry.as_ref().is_some_and(|g| match &g.calibration {
            Calibration::None => false,
            Calibration::Ultrasound { regions } => regions
                .iter()
                .any(|r| r.units_xy == [3, 3] && r.spatial_format == 1),
            _ => true,
        });
        let patient_coordinates = geometry.as_ref().is_some_and(|g| g.patient_plane.is_some());
        let capabilities = Capabilities {
            frame_access: index.is_some(),
            physical_measurement: index.is_some() && physical_measurement,
            patient_coordinates: index.is_some() && patient_coordinates,
            volume_candidate: index.is_some()
                && patient_coordinates
                && matches!(
                    object,
                    Object::Ct | Object::EnhancedCt | Object::Mr | Object::EnhancedMr
                ),
            dependent_video: video,
            host_document: object == Object::Pdf,
            frame_limitation: limitation.or(match (object.is_image(), video) {
                (_, true) => Some("dependent video stream requires a host video decoder"),
                (false, false) => Some("SOP class has no independently displayable frames"),
                _ => None,
            }),
        };
        let info = Inspection {
            sop_class_uid: file.class_uid.clone(),
            instance_uid: file.instance_uid.clone(),
            study_uid: uid(d.text(&file.bytes, (0x20, 0x0d)))
                .ok()
                .map(str::to_owned),
            series_uid: uid(d.text(&file.bytes, (0x20, 0x0e)))
                .ok()
                .map(str::to_owned),
            content_sha256: file.sha256.clone(),
            transfer_syntax: file.syntax,
            object,
            frames,
            pixel_format: format,
            initial_geometry: geometry,
            capabilities,
            frame_durations_ms: durations(&file, frames),
        };
        let memory = Memory {
            source_bytes: file.source_bytes,
            resident_dataset_bytes: file.bytes.capacity(),
            dataset_elements: file.elements,
            frame_index_bytes: index.as_ref().map_or(0, Index::bytes),
            ..Memory::default()
        };
        Ok(Self {
            file,
            info,
            limits,
            index,
            frames: VecDeque::new(),
            memory,
        })
    }

    pub fn inspect(bytes: Vec<u8>, limits: Limits) -> Result<Inspection> {
        Ok(Self::open(bytes, limits)?.info)
    }

    pub fn inspection(&self) -> &Inspection {
        &self.info
    }

    pub fn memory(&self) -> &Memory {
        &self.memory
    }

    pub fn read_frame(&mut self, index: usize) -> Result<Arc<Frame>> {
        let codec = self.index.as_ref().ok_or_else(|| {
            Error::Unsupported(
                self.info
                    .capabilities
                    .frame_limitation
                    .unwrap_or("pixel profile"),
            )
        })?;
        if index >= self.info.frames {
            return Err(Error::InvalidRequest("frame index"));
        }
        if let Some(i) = self.frames.iter().position(|frame| frame.index == index) {
            let hit = self.frames.remove(i).expect("cached frame");
            self.frames.push_back(Arc::clone(&hit));
            return Ok(hit);
        }
        let format = self.info.pixel_format.ok_or(Error::Internal)?;
        let expected_bytes = format.pixels()
            * if format.photometric.is_monochrome() {
                4
            } else {
                3
            };
        while !self.frames.is_empty()
            && (self.frames.len() >= self.limits.cache_frames
                || self.memory.cached_pixel_bytes + expected_bytes > self.limits.cache_bytes)
        {
            let evicted = self.frames.pop_front().expect("cached frame");
            self.memory.cached_pixel_bytes -= evicted.samples.bytes();
        }
        self.memory.cached_frames = self.frames.len();
        let (samples, copied) = codec.read(&self.file, format, index)?;
        self.memory.decoded_frames += 1;
        self.memory.fragment_copy_bytes += copied as u64;
        self.memory.produced_pixel_bytes += samples.bytes() as u64;
        let display = match &samples {
            Samples::Monochrome(values) => {
                let transform = groups(&self.file, index, (0x28, 0x9145));
                let voi = groups(&self.file, index, (0x28, 0x9132));
                Some(display(&self.file, format, transform, voi, values)?)
            }
            _ => None,
        };
        let geometry = frame_geometry(&self.file, self.info.object, format, index);
        let frame = Arc::new(Frame {
            index,
            format,
            samples,
            display,
            geometry,
        });
        let bytes = frame.samples.bytes();
        if self.limits.cache_frames > 0
            && self.memory.cached_pixel_bytes + bytes <= self.limits.cache_bytes
        {
            self.frames.push_back(Arc::clone(&frame));
            self.memory.cached_pixel_bytes += bytes;
            self.memory.cached_frames = self.frames.len();
            self.memory.peak_cached_pixel_bytes = self
                .memory
                .peak_cached_pixel_bytes
                .max(self.memory.cached_pixel_bytes);
        }
        Ok(frame)
    }

    pub fn evict_frames(&mut self) {
        self.frames.clear();
        self.memory.cached_frames = 0;
        self.memory.cached_pixel_bytes = 0;
    }

    pub fn pdf(&self) -> Result<&[u8]> {
        if self.info.object != Object::Pdf {
            return Err(Error::InvalidRequest("encapsulated PDF"));
        }
        let data = self
            .file
            .dataset
            .bytes(&self.file.bytes, (0x42, 0x0011))
            .ok_or(Error::InvalidDicom("encapsulated document"))?;
        let length = self
            .file
            .dataset
            .ul(&self.file, (0x42, 0x0015))
            .map_or(data.len(), |n| n as usize);
        if data
            .len()
            .checked_sub(length)
            .is_none_or(|padding| padding > 1)
            || !data.starts_with(b"%PDF-")
            || self.file.dataset.text(&self.file.bytes, (0x42, 0x0012)) != Some("application/pdf")
        {
            return Err(Error::InvalidDicom("encapsulated PDF type or length"));
        }
        Ok(&data[..length])
    }

    /// Returns one continuous media stream for the host decoder. Frame indexing is external.
    pub fn video(&self) -> Result<(&'static str, Vec<u8>)> {
        if !self.file.syntax.video() {
            return Err(Error::InvalidRequest("dependent video source"));
        }
        let pixel = self
            .file
            .dataset
            .get(crate::dicom::PIXEL_DATA)
            .ok_or(Error::InvalidDicom("video Pixel Data"))?;
        let crate::dicom::Value::Encapsulated {
            offset_table,
            fragments,
        } = &pixel.value
        else {
            return Err(Error::InvalidDicom("video must be encapsulated"));
        };
        if !offset_table.is_empty() || fragments.is_empty() {
            return Err(Error::InvalidDicom("dependent video fragments"));
        }
        let size = fragments.iter().map(|f| f.bytes.len()).sum::<usize>();
        if size > 64 * 1024 * 1024 {
            return Err(Error::Limit("dependent video bytes"));
        }
        let mut bytes = Vec::with_capacity(size);
        for fragment in fragments {
            bytes.extend_from_slice(&self.file.bytes[fragment.bytes.clone()]);
        }
        let kind = if bytes.get(4..8) == Some(b"ftyp") {
            "video/mp4"
        } else if bytes.first() == Some(&0x47) && bytes.get(188) == Some(&0x47) {
            "video/mp2t"
        } else if self.file.syntax == TransferSyntax::Mpeg2 && bytes.starts_with(&[0, 0, 1, 0xba]) {
            "video/mpeg"
        } else {
            return Err(Error::Unsupported("dependent video container"));
        };
        Ok((kind, bytes))
    }

    pub(crate) fn frame_of_reference(&self) -> Option<&str> {
        uid(self.file.dataset.text(&self.file.bytes, (0x20, 0x52))).ok()
    }
}

fn read_format(file: &File, object: Object, limits: Limits) -> Result<PixelFormat> {
    let d = &file.dataset;
    let modality = d.text(&file.bytes, (8, 0x60));
    let expected_modality = match file.class_uid.strip_prefix("1.2.840.10008.5.1.4.1.1.") {
        Some("1") => "CR",
        Some("1.1" | "1.1.1") => "DX",
        Some("1.3" | "1.3.1") => "IO",
        Some("2" | "2.1") => "CT",
        Some("4" | "4.1") => "MR",
        _ => "US",
    };
    if modality != Some(expected_modality) {
        return Err(Error::InvalidDicom("modality and SOP class differ"));
    }
    let us = |key| {
        d.us(file, (0x28, key))
            .ok_or(Error::InvalidDicom("required Pixel Module attribute"))
    };
    let rows = u32::from(us(0x10)?);
    let columns = u32::from(us(0x11)?);
    if rows == 0 || columns == 0 {
        return Err(Error::InvalidDicom("zero image dimension"));
    }
    if columns > 16_384
        || rows > 16_384
        || u64::from(rows) * u64::from(columns) > limits.frame_pixels as u64
    {
        return Err(Error::Limit("frame dimensions"));
    }
    let photometric = match d.text(&file.bytes, (0x28, 4)) {
        Some("MONOCHROME1") => Photometric::Monochrome1,
        Some("MONOCHROME2") => Photometric::Monochrome2,
        Some("RGB") => Photometric::Rgb,
        Some("YBR_FULL") => Photometric::YbrFull,
        Some("YBR_FULL_422") => Photometric::YbrFull422,
        Some(_) => return Err(Error::Unsupported("photometric interpretation")),
        None => return Err(Error::InvalidDicom("photometric interpretation")),
    };
    let monochrome = photometric.is_monochrome();
    if us(2)? != if monochrome { 1 } else { 3 } {
        return Err(Error::InvalidDicom(
            "photometric and samples per pixel differ",
        ));
    }
    let (allocated, stored, high, repr) = (us(0x100)?, us(0x101)?, us(0x102)?, us(0x103)?);
    if !matches!(allocated, 8 | 16) {
        return Err(Error::Unsupported("bits allocated"));
    }
    if stored == 0 || stored > allocated || high >= allocated || high + 1 < stored || repr > 1 {
        return Err(Error::InvalidDicom("stored bits or pixel representation"));
    }
    let planar = if monochrome {
        false
    } else {
        if object != Object::Ultrasound || allocated != 8 || stored != 8 || repr != 0 {
            return Err(Error::Unsupported("color pixel layout for SOP class"));
        }
        match us(6)? {
            0 => false,
            1 if photometric != Photometric::YbrFull422 => true,
            _ => return Err(Error::InvalidDicom("planar configuration")),
        }
    };
    Ok(PixelFormat {
        rows,
        columns,
        bits_allocated: allocated as u8,
        bits_stored: stored as u8,
        high_bit: high as u8,
        signed: repr == 1,
        photometric,
        planar,
    })
}

pub(crate) fn groups(file: &File, index: usize, key: Key) -> &Dataset {
    let d = &file.dataset;
    d.sequence((0x5200, 0x9230))
        .and_then(|s| s.get(index))
        .and_then(|f| f.one(key))
        .or_else(|| d.one((0x5200, 0x9229)).and_then(|f| f.one(key)))
        .unwrap_or(d)
}

pub(crate) fn frame_geometry(
    file: &File,
    object: Object,
    format: PixelFormat,
    index: usize,
) -> FrameGeometry {
    let root = &file.dataset;
    let spacing = |data: &Dataset, key| {
        data.ds(file, key)
            .map(|[row, col]| [col, row])
            .filter(|&s| valid_spacing(s))
    };
    let pixels = spacing(groups(file, index, (0x28, 0x9110)), (0x28, 0x30));
    let detector = spacing(root, (0x18, 0x1164)).or_else(|| spacing(root, (0x18, 0x2010)));
    let aspect = spacing(root, (0x28, 0x34));
    let patient_plane = if matches!(
        object,
        Object::Ct | Object::EnhancedCt | Object::Mr | Object::EnhancedMr
    ) {
        (|| {
            PatientPlane::new(
                groups(file, index, (0x20, 0x9113)).ds(file, (0x20, 0x32))?,
                groups(file, index, (0x20, 0x9116)).ds(file, (0x20, 0x37))?,
                pixels?,
            )
        })()
    } else {
        None
    };
    let calibration = match (object, pixels) {
        (Object::Projection, Some(spacing_xy)) => {
            let method = match root.text(&file.bytes, (0x28, 0xa02)) {
                Some("FIDUCIAL") => Some(ProjectionCalibration::Fiducial),
                Some("GEOMETRY") => Some(ProjectionCalibration::Geometry),
                None if detector.is_some_and(|d| d != spacing_xy) => {
                    Some(ProjectionCalibration::CorrectedSpacing)
                }
                _ => None,
            };
            method.map_or(Calibration::None, |method| Calibration::Projection {
                spacing_xy,
                method,
            })
        }
        (Object::Ultrasound, _) => {
            let regions: Vec<_> = root
                .sequence((0x18, 0x6011))
                .unwrap_or_default()
                .iter()
                .filter_map(|item| {
                    let ul = |k| item.ul(file, (0x18, k));
                    let bounds = [ul(0x6018)?, ul(0x601a)?, ul(0x601c)?, ul(0x601e)?];
                    if bounds[0] > bounds[2]
                        || bounds[1] > bounds[3]
                        || bounds[2] >= format.columns
                        || bounds[3] >= format.rows
                    {
                        return None;
                    }
                    let region = UltrasoundRegion {
                        bounds,
                        delta_xy: [
                            item.fd(file, (0x18, 0x602c)).unwrap_or(0.0),
                            item.fd(file, (0x18, 0x602e)).unwrap_or(0.0),
                        ],
                        units_xy: [
                            item.us(file, (0x18, 0x6024)).unwrap_or(0),
                            item.us(file, (0x18, 0x6026)).unwrap_or(0),
                        ],
                        spatial_format: item.us(file, (0x18, 0x6012)).unwrap_or(0),
                    };
                    Some(region)
                })
                .collect();
            if regions.is_empty() {
                Calibration::None
            } else {
                Calibration::Ultrasound { regions }
            }
        }
        (_, Some(spacing_xy)) if patient_plane.is_some() => {
            Calibration::PatientPlane { spacing_xy }
        }
        _ => Calibration::None,
    };
    let anatomy = match root.text(&file.bytes, (0x10, 0x2210)) {
        Some("BIPED") => Anatomy::Biped,
        Some("QUADRUPED") => Anatomy::Quadruped(match root.text(&file.bytes, (0x18, 0x15)) {
            Some("HEAD" | "SKULL" | "BRAIN" | "FACE") => Region::Head,
            Some("NECK" | "CHEST" | "THORAX" | "ABDOMEN" | "PELVIS" | "TRUNK" | "TAIL") => {
                Region::Trunk
            }
            Some("SHOULDER" | "HUMERUS" | "HIP" | "FEMUR") => Region::ProximalLimb,
            Some("CARPUS" | "METACARPUS" | "FOREPAW") => Region::DistalForelimb,
            Some("TARSUS" | "METATARSUS" | "HINDPAW") => Region::DistalHindlimb,
            _ => Region::Unknown,
        }),
        _ => Anatomy::Unknown,
    };
    FrameGeometry {
        calibration,
        detector_spacing_xy: detector,
        display_spacing_xy: pixels.or(detector).or(aspect).unwrap_or([1.0, 1.0]),
        patient_plane,
        anatomy,
        increasing_column: patient_plane.and_then(|p| anatomy.direction(p.column_axis)),
        increasing_row: patient_plane.and_then(|p| anatomy.direction(p.row_axis)),
    }
}

fn durations(file: &File, count: usize) -> Option<Vec<f64>> {
    if count < 2 {
        return None;
    }
    let d = &file.dataset;
    if let Some(bytes) = d.bytes(&file.bytes, (0x18, 0x1065)) {
        if bytes.len() > count * 18 {
            return None;
        }
        let text = std::str::from_utf8(bytes).ok()?;
        let values: Vec<f64> = text
            .split('\\')
            .map(|s| s.trim().parse().ok())
            .collect::<Option<_>>()?;
        if values.len() != count
            || values[0] != 0.0
            || values[1..]
                .iter()
                .any(|v| !(0.001..=86_400_000.0).contains(v))
        {
            return None;
        }
        let mut delays = values[1..].to_vec();
        delays.push(values[count - 1]);
        return Some(delays);
    }
    let [ms] = d.ds(file, (0x18, 0x1063))?;
    (0.001..=86_400_000.0)
        .contains(&ms)
        .then(|| vec![ms; count])
}
