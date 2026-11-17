#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
use std::{collections::VecDeque, sync::Arc};

use serde::Serialize;

use crate::{
    Error, FrameIndex, FrameProofCatalog, FrameRange, Limits, Result,
    codec::{Index, decode_jpeg, read_indexed},
    dicom::{Dataset, File, Key, source_digest, uid},
    frame_index::DetachedIndex,
    frame_proof::{ProofIndex, VerifiedFrame},
    geometry::{
        Anatomy, Calibration, PatientPlane, PatientPoint, PixelPoint, ProjectionCalibration,
        Region, UltrasoundRegion, dot, valid_spacing,
    },
    pixel::{
        Display, Modality, Photometric, PixelFormat, RenderOptions, Samples, Voi, VoiAlternative,
        VoiScope, VoiSelection, WindowFunction, color_rgb, display, read_modality, selected_voi,
        voi_alternatives, voi_signed,
    },
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
    pub fn part10_prefix(bytes: &[u8]) -> Result<Self> {
        let (_, meta) = File::read_meta(bytes, Limits::default())?;
        Self::from_uid(uid(meta.text(bytes, (2, 0x10)))?)
    }

    pub fn may_require_advanced_codecs(self) -> bool {
        self.wavelet()
            || matches!(
                self,
                Self::JpegLsLossless | Self::JpegLsNearLossless | Self::JpegExtended
            )
    }

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
    pub(crate) fn from_uid(uid: &str) -> Self {
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
    pub verification: &'static str,
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
    pub fn texture16(&self, options: RenderOptions) -> bool {
        self.texture16_with_voi(options, None)
    }

    pub fn texture16_with_voi(&self, options: RenderOptions, voi: Option<&Voi>) -> bool {
        if self.format.columns > 4096 || self.format.rows > 4096 {
            return false;
        }
        let Some(display) = &self.display else {
            return false;
        };
        let Modality::Linear { slope, intercept } = display.modality else {
            return false;
        };
        let window = options.window.or(match voi.unwrap_or(&display.voi) {
            Voi::Window { window } => Some(*window),
            _ => None,
        });
        let Some(window) = window else {
            return false;
        };
        let linear = window.function == WindowFunction::Linear;
        let target = window.center - if linear { 0.5 } else { 0.0 };
        let center = (target - intercept) / slope;
        let width = (window.width - f64::from(linear)) / slope.abs();
        let uniform_error =
            (center - f64::from(center as f32)).abs() + (width - f64::from(width as f32)).abs();
        let error = uniform_error
            + (target.abs() + intercept.abs() + 65536.0 * slope.abs()) * 1e-15 / slope.abs();
        (center as f32).is_finite()
            && (width as f32).is_finite()
            && width >= 0.0
            && if width == 0.0 {
                (center - center.round()).abs() > error
            } else {
                error * 2048.0 <= width && width as f32 != 0.0
            }
    }

    pub fn render_rgba(&self, options: RenderOptions) -> Result<Vec<u8>> {
        self.render_rgba_with_voi(options, None)
    }

    pub fn render_rgba_with_voi(
        &self,
        options: RenderOptions,
        voi: Option<&Voi>,
    ) -> Result<Vec<u8>> {
        if let Some(window) = options.window {
            window.validate()?;
        }
        let mut rgba = Vec::with_capacity(self.format.pixels() * 4);
        match &self.samples {
            Samples::Monochrome(values) => {
                let display = self.display.as_ref().ok_or(Error::Internal)?;
                let map = display.rgba_mapper(
                    self.format,
                    options,
                    voi.unwrap_or(&display.voi),
                    values.len(),
                );
                rgba.extend(values.iter().flat_map(|&v| map(v)));
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
    pub source_read_bytes: u64,
    pub frame_index_input_bytes: usize,
    pub range_reads: u64,
    #[cfg(not(target_arch = "wasm32"))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_source_hash_us: Option<u128>,
    #[cfg(not(target_arch = "wasm32"))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_source_parse_us: Option<u128>,
}

pub struct Session {
    pub(crate) file: Arc<File>,
    pub(crate) info: Inspection,
    limits: Limits,
    index: Option<Arc<Index>>,
    frames: VecDeque<Arc<Frame>>,
    memory: Memory,
    staged: Option<(usize, Vec<u8>)>,
    proved: Option<VerifiedFrame>,
    #[cfg(not(target_arch = "wasm32"))]
    reader: Option<Arc<crate::NativeFile>>,
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
        File::check_source_size(bytes.len(), limits)?;
        #[cfg(not(target_arch = "wasm32"))]
        let hash_started = Instant::now();
        let digest = source_digest(&bytes);
        #[cfg(not(target_arch = "wasm32"))]
        let hashed = Instant::now();
        let file = File::parse_with_digest(bytes, limits, expected_sha256, digest)?;
        let session = Self::inspect_file(file, limits, None)?;
        #[cfg(not(target_arch = "wasm32"))]
        let session = {
            let mut session = session;
            session.memory.full_source_hash_us = Some((hashed - hash_started).as_micros());
            session.memory.full_source_parse_us = Some(hashed.elapsed().as_micros());
            session
        };
        Ok(session)
    }

    #[cfg(target_arch = "wasm32")]
    pub async fn open_in_worker(
        bytes: Vec<u8>,
        limits: Limits,
        expected_sha256: Option<&str>,
    ) -> Result<Self> {
        let file = File::parse_in_worker(bytes, limits, expected_sha256).await?;
        Self::inspect_file(file, limits, None)
    }

    #[cfg(target_arch = "wasm32")]
    pub async fn open_preparing_frame(
        bytes: Vec<u8>,
        limits: Limits,
        expected_sha256: Option<&str>,
    ) -> Result<Self> {
        use crate::dicom::{finish_web_digest, start_web_digest};
        File::check_source_size(bytes.len(), limits)?;
        let Some(digest) = start_web_digest(&bytes) else {
            return Self::open_verified(bytes, limits, expected_sha256);
        };
        let bytes = Arc::new(bytes);
        let prepared = File::parse_shared(Arc::clone(&bytes), limits, bytes.len(), String::new())
            .and_then(|file| Self::inspect_file(file, limits, None))
            .map(|mut source| {
                if source.info.transfer_syntax == TransferSyntax::JpegBaseline
                    && source.info.capabilities.frame_access
                    && limits.cache_frames > 0
                    && source
                        .info
                        .pixel_format
                        .is_some_and(|format| format.pixels() * 4 <= limits.cache_bytes)
                {
                    let _ = source.read_frame(0);
                }
                source
            });
        let digest = finish_web_digest(digest)
            .await
            .unwrap_or_else(|| source_digest(&bytes));
        let fingerprint = format!("{digest:x}");
        if expected_sha256.is_some_and(|hash| !fingerprint.eq_ignore_ascii_case(hash)) {
            return Err(Error::Integrity("source SHA-256"));
        }
        let mut source = prepared?;
        Arc::get_mut(&mut source.file)
            .ok_or(Error::Internal)?
            .sha256 = fingerprint.clone();
        source.info.content_sha256 = fingerprint;
        Ok(source)
    }

    pub fn open_index(
        bytes: &[u8],
        pin: &str,
        limits: Limits,
        expected_sha256: Option<&str>,
    ) -> Result<Self> {
        let (index, file) = DetachedIndex::open(bytes, pin, limits, expected_sha256)?;
        let mut session = Self::inspect_file(file, limits, Some(Index::Detached(index)))?;
        session.memory.source_read_bytes = 0;
        session.memory.frame_index_input_bytes = bytes.len();
        Ok(session)
    }

    pub fn open_frame_proof(
        packet: Vec<u8>,
        pin: &str,
        revision: &str,
        frame: usize,
        limits: Limits,
        expected_sha256: Option<&str>,
    ) -> Result<Self> {
        let (index, file, verified) =
            ProofIndex::open(packet, pin, revision, frame, limits, expected_sha256)?;
        let mut session = Self::inspect_file(file, limits, Some(Index::Proof(index)))?;
        session.memory.source_read_bytes = 0;
        session.proved = Some(verified);
        Ok(session)
    }

    pub fn create_frame_proofs(&self, revision: &str) -> Result<FrameProofCatalog> {
        let Some(Index::Encapsulated { fragments, frames }) = self.index.as_deref() else {
            return Err(Error::Unsupported(
                "frame proof generation requires a complete encapsulated source",
            ));
        };
        FrameProofCatalog::new(Arc::clone(&self.file), fragments, frames, revision)
    }

    pub fn stage_frame_proof(&mut self, frame: usize, packet: Vec<u8>) -> Result<()> {
        let Some(Index::Proof(index)) = self.index.as_deref() else {
            return Err(Error::InvalidRequest("source has no proof pin"));
        };
        self.proved = Some(index.stage(packet, frame)?);
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn bind_file(&mut self, reader: crate::NativeFile) -> Result<()> {
        if !matches!(self.index.as_deref(), Some(Index::Detached(_)))
            || reader.len() != self.file.source_bytes as u64
        {
            return Err(Error::Integrity("indexed file length"));
        }
        self.reader = Some(Arc::new(reader));
        Ok(())
    }

    pub fn create_frame_index(&self) -> Result<FrameIndex> {
        let Some(Index::Encapsulated { fragments, frames }) = self.index.as_deref() else {
            return Err(Error::Unsupported(
                "index generation requires a complete encapsulated source",
            ));
        };
        DetachedIndex::encode(&self.file, fragments, frames)
    }

    pub fn frame_range(&self, frame: usize) -> Result<FrameRange> {
        let Some(Index::Detached(index)) = self.index.as_deref() else {
            return Err(Error::InvalidRequest("source has no detached index"));
        };
        index.range(frame)
    }

    pub fn stage_range(&mut self, frame: usize, bytes: Vec<u8>) -> Result<()> {
        let Some(Index::Detached(index)) = self.index.as_deref() else {
            return Err(Error::InvalidRequest("source has no detached index"));
        };
        self.staged = None;
        self.memory.source_read_bytes += bytes.len() as u64;
        self.memory.range_reads += 1;
        index.verify(frame, &bytes)?;
        self.staged = Some((frame, bytes));
        Ok(())
    }

    pub fn clear_range(&mut self) {
        self.staged = None;
    }

    fn inspect_file(file: File, limits: Limits, detached: Option<Index>) -> Result<Self> {
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
        let (verification, detached_count) = match detached.as_ref() {
            Some(Index::Detached(index)) => ("pinned_frame_index", index.len()),
            Some(Index::Proof(index)) => ("pinned_frame_proof", index.count),
            None => ("full_source", 0),
            _ => return Err(Error::Internal),
        };
        let index = if let Some(index) = detached {
            if format.is_none_or(|format| !file.syntax.supports(format))
                || frames != detached_count
                || !object.is_image()
            {
                return Err(Error::Integrity("indexed frame metadata"));
            }
            Some(index)
        } else {
            match format {
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
            }
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
            verification,
        };
        let memory = Memory {
            source_bytes: file.source_bytes,
            resident_dataset_bytes: file.bytes.capacity(),
            dataset_elements: file.elements,
            frame_index_bytes: index.as_ref().map_or(0, Index::bytes),
            source_read_bytes: file.source_bytes as u64,
            ..Memory::default()
        };
        Ok(Self {
            file: Arc::new(file),
            info,
            limits,
            index: index.map(Arc::new),
            frames: VecDeque::new(),
            memory,
            staged: None,
            proved: None,
            #[cfg(not(target_arch = "wasm32"))]
            reader: None,
        })
    }

    pub fn inspect(bytes: Vec<u8>, limits: Limits) -> Result<Inspection> {
        Ok(Self::open(bytes, limits)?.info)
    }

    pub fn inspection(&self) -> &Inspection {
        &self.info
    }

    pub fn series_description(&self) -> Option<&str> {
        self.file.dataset.text(&self.file.bytes, (8, 0x103e))
    }

    /// In a host-registered reference space, find a unique in-bounds parallel plane.
    pub fn locate_patient(
        &self,
        point: PatientPoint,
        reference: &str,
        normal: [f64; 3],
    ) -> Result<Option<(usize, PixelPoint)>> {
        let length = dot(normal, normal);
        if !point.0.iter().all(|value| value.is_finite())
            || (length - 1.0).abs() > 0.001
            || !length.is_finite()
        {
            return Err(Error::InvalidRequest("patient point and plane normal"));
        }
        if self.frame_of_reference() != Some(reference)
            || !self.info.capabilities.patient_coordinates
        {
            return Ok(None);
        }
        let format = self.access(0)?;
        let mut result = None;
        let mut distance = f64::INFINITY;
        let mut ambiguous = false;
        for index in 0..self.info.frames {
            let Some(plane) = self.geometry(index)?.patient_plane else {
                continue;
            };
            if dot(plane.normal(), normal).abs() < 0.9999 {
                continue;
            }
            let (pixel, offset) = plane.project(point);
            let error = offset.abs();
            if error > 0.25
                || pixel.x < -0.5
                || pixel.x >= f64::from(format.columns) - 0.5
                || pixel.y < -0.5
                || pixel.y >= f64::from(format.rows) - 0.5
            {
                continue;
            }
            if (error - distance).abs() < 1e-6 {
                ambiguous = true;
            } else if error < distance {
                result = Some((index, pixel));
                distance = error;
                ambiguous = false;
            }
        }
        Ok(if ambiguous { None } else { result })
    }

    pub fn memory(&self) -> &Memory {
        &self.memory
    }

    pub fn voi_alternatives(&self, index: usize) -> Result<Vec<VoiAlternative>> {
        let format = self.access(index)?;
        let (data, scope) = scoped_group(&self.file, index, (0x28, 0x9132));
        Ok(if format.photometric.is_monochrome() {
            let signed = if data.get((0x28, 0x3010)).is_some() {
                let modality = read_modality(
                    &self.file,
                    format,
                    groups(&self.file, index, (0x28, 0x9145)),
                )?;
                voi_signed(format, &modality)
            } else {
                format.signed
            };
            voi_alternatives(&self.file, data, scope, signed)
        } else {
            Vec::new()
        })
    }

    pub fn select_voi(&self, index: usize, selection: VoiSelection) -> Result<Voi> {
        let format = self.access(index)?;
        if !format.photometric.is_monochrome() {
            return Err(Error::InvalidRequest("VOI requires a monochrome frame"));
        }
        let signed = if matches!(selection, VoiSelection::Lut(_)) {
            let modality = read_modality(
                &self.file,
                format,
                groups(&self.file, index, (0x28, 0x9145)),
            )?;
            voi_signed(format, &modality)
        } else {
            format.signed
        };
        selected_voi(
            &self.file,
            groups(&self.file, index, (0x28, 0x9132)),
            signed,
            selection,
        )
    }

    pub fn modality_unit(&self, index: usize) -> Result<Option<&'static str>> {
        let format = self.access(index)?;
        let data = groups(&self.file, index, (0x28, 0x9145));
        Ok((format.photometric.is_monochrome()
            && matches!(self.info.object, Object::Ct | Object::EnhancedCt)
            && data.text(&self.file.bytes, (0x28, 0x1054)) == Some("HU")
            && data.get((0x28, 0x3000)).is_none()
            && data
                .ds::<1>(&self.file, (0x28, 0x1053))
                .is_some_and(|[s]| s != 0.0)
            && data.ds::<1>(&self.file, (0x28, 0x1052)).is_some())
        .then_some("HU"))
    }

    pub fn read_frame(&mut self, index: usize) -> Result<Arc<Frame>> {
        if let Some(i) = self.frames.iter().position(|frame| frame.index == index) {
            let hit = self.frames.remove(i).expect("cached frame");
            self.frames.push_back(Arc::clone(&hit));
            return Ok(hit);
        }
        let format = self.access(index)?;
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
        let decoded = self.decode(index, format);
        self.staged = None;
        if self
            .proved
            .as_ref()
            .is_some_and(|frame| frame.index == index)
        {
            self.proved = None;
        }
        let (frame, copied, read_bytes) = decoded?;
        let frame = Arc::new(frame);
        self.memory.decoded_frames += 1;
        self.memory.fragment_copy_bytes += copied as u64;
        self.memory.source_read_bytes += read_bytes as u64;
        self.memory.range_reads += u64::from(read_bytes != 0);
        self.memory.produced_pixel_bytes += frame.samples.bytes() as u64;
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

    fn access(&self, index: usize) -> Result<PixelFormat> {
        if self.index.is_none() {
            return Err(Error::Unsupported(
                self.info
                    .capabilities
                    .frame_limitation
                    .unwrap_or("pixel profile"),
            ));
        }
        if index >= self.info.frames {
            return Err(Error::InvalidRequest("frame index"));
        }
        self.info.pixel_format.ok_or(Error::Internal)
    }

    fn decode(&self, index: usize, format: PixelFormat) -> Result<(Frame, usize, usize)> {
        let codec = self.index.as_ref().ok_or(Error::Internal)?;
        #[allow(unused_mut)]
        let mut read_bytes = 0;
        let (samples, copied) = if let Index::Proof(_) = codec.as_ref() {
            let proof = self
                .proved
                .as_ref()
                .filter(|frame| frame.index == index)
                .ok_or(Error::FrameRange(index))?;
            let jpeg = proof.jpeg();
            read_bytes = proof.packet.len();
            let copied = if matches!(&jpeg, std::borrow::Cow::Owned(_)) {
                jpeg.len()
            } else {
                0
            };
            (
                decode_jpeg(&jpeg, format, TransferSyntax::JpegBaseline)?,
                copied,
            )
        } else if let Index::Detached(table) = codec.as_ref() {
            if let Some((frame, bytes)) = &self.staged
                && *frame == index
            {
                read_indexed(table, format, index, bytes)?
            } else {
                #[cfg(not(target_arch = "wasm32"))]
                if let Some(reader) = &self.reader {
                    let range = table.range(index)?;
                    let bytes = reader.read(range.start, range.end - range.start)?;
                    table.verify(index, &bytes)?;
                    read_bytes = bytes.len();
                    read_indexed(table, format, index, &bytes)?
                } else {
                    return Err(Error::FrameRange(index));
                }
                #[cfg(target_arch = "wasm32")]
                return Err(Error::FrameRange(index));
            }
        } else {
            codec.read(&self.file, format, index)?
        };
        let display = match &samples {
            Samples::Monochrome(values) => {
                let transform = groups(&self.file, index, (0x28, 0x9145));
                let voi = groups(&self.file, index, (0x28, 0x9132));
                Some(display(&self.file, format, transform, voi, values)?)
            }
            _ => None,
        };
        let geometry = frame_geometry(&self.file, self.info.object, format, index);
        Ok((
            Frame {
                index,
                format,
                samples,
                display,
                geometry,
            },
            copied,
            read_bytes,
        ))
    }

    // Share the immutable source snapshot without retaining the viewer's decoded frames.
    pub(crate) fn volume_reader(&self) -> Self {
        Self {
            file: Arc::clone(&self.file),
            info: self.info.clone(),
            limits: self.limits,
            index: self.index.clone(),
            frames: VecDeque::new(),
            memory: self.memory.clone(),
            staged: None,
            proved: None,
            #[cfg(not(target_arch = "wasm32"))]
            reader: self.reader.clone(),
        }
    }

    pub(crate) fn modality_slice(&self, index: usize) -> Result<Vec<f32>> {
        let (frame, _, _) = self.decode(index, self.access(index)?)?;
        let Samples::Monochrome(pixels) = frame.samples else {
            return Err(Error::Unsupported("color volume"));
        };
        let display = frame.display.ok_or(Error::Internal)?;
        Ok(pixels
            .into_iter()
            .map(|value| {
                if display.is_padding(value) {
                    f32::NAN
                } else {
                    display.modality.at(value) as f32
                }
            })
            .collect())
    }

    pub fn geometry(&self, index: usize) -> Result<FrameGeometry> {
        Ok(frame_geometry(
            &self.file,
            self.info.object,
            self.access(index)?,
            index,
        ))
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
    scoped_group(file, index, key).0
}

fn scoped_group(file: &File, index: usize, key: Key) -> (&Dataset, VoiScope) {
    let d = &file.dataset;
    d.sequence((0x5200, 0x9230))
        .and_then(|s| s.get(index))
        .and_then(|f| f.one(key))
        .map(|group| (group, VoiScope::Frame))
        .or_else(|| {
            d.one((0x5200, 0x9229))
                .and_then(|f| f.one(key))
                .map(|group| (group, VoiScope::Shared))
        })
        .unwrap_or((d, VoiScope::Instance))
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
