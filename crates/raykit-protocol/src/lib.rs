use std::sync::Arc;

use raykit_core::{
    Error, Frame, Limits, Result, Session,
    geometry::{PatientPoint, PixelPoint, ScreenPoint, View},
    interop::SrOptions,
    measurement::{Record, Request},
    pixel::{Palette, RenderOptions, Samples, Voi, VoiSelection, Window},
    quantitative::QuantitativeScale,
    tiles::{Region as TileRegion, TileCatalog, TiledImage},
    volume::{Reslice, ResliceWork, Resliced, Sampling, Volume},
};
use serde::{Deserialize, Serialize};

pub const ABI_VERSION: u32 = 1;
pub const MAX_COMMAND_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
#[derive(Default)]
pub struct OpenOptions {
    pub limits: Limits,
    pub expected_sha256: Option<String>,
    pub expected_size: Option<usize>,
    pub expected_instance_uid: Option<String>,
    pub expected_series_uid: Option<String>,
    pub expected_study_uid: Option<String>,
    pub prepare_first_frame: bool,
    attachment: Option<Attachment>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Attachment {
    Sr {
        expected_source_sha256: Option<String>,
    },
    Segmentation {
        frame: usize,
        segment: u16,
    },
    Presentation {
        frame: usize,
    },
}

impl OpenOptions {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() {
            return Ok(Self::default());
        }
        if bytes.len() > MAX_COMMAND_BYTES {
            return Err(Error::Limit("open options bytes"));
        }
        serde_json::from_slice(bytes).map_err(|_| Error::InvalidRequest("open options"))
    }

    fn check_primary(&self) -> Result<()> {
        if self.attachment.is_some() {
            return Err(Error::InvalidRequest(
                "primary source cannot be an attachment",
            ));
        }
        Ok(())
    }

    fn check_expected_size(&self, len: usize) -> Result<()> {
        if self.expected_size.is_some_and(|size| len != size) {
            return Err(Error::Integrity("source byte length"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Frame {
        index: usize,
        #[serde(default)]
        output: FrameOutput,
        #[serde(default)]
        options: DisplayOptions,
        #[serde(default)]
        fallback_voi: bool,
    },
    Prefetch {
        index: usize,
    },
    Render {
        index: usize,
        #[serde(default)]
        options: DisplayOptions,
    },
    Views {
        index: usize,
    },
    Sample {
        index: usize,
        x: u32,
        y: u32,
    },
    SampleAt {
        index: usize,
        x: u32,
        y: u32,
    },
    FrameInfo {
        index: usize,
    },
    LocatePatient {
        point: PatientPoint,
        reference: String,
        normal: [f64; 3],
    },
    Transform {
        index: usize,
        view: View,
        point: Option<ScreenPoint>,
    },
    Measure {
        index: usize,
        request: Request,
    },
    Reopen {
        record: Record,
    },
    Verify {
        record: Record,
    },
    Evict,
    Stats,
    CreateFrameIndex,
    FrameProof {
        index: usize,
        revision: String,
    },
    PrepareTiles {
        index: usize,
        edge: u32,
        revision: String,
    },
    Tile {
        index: usize,
    },
    Document,
    Video,
    ExportSr {
        record: Record,
        options: SrOptions,
    },
    VolumeCandidates,
    VolumeBuild {
        index: usize,
        revision: u32,
    },
    VolumeSample {
        point: raykit_core::geometry::PatientPoint,
    },
    Reslice {
        plane: Reslice,
        window: Option<Window>,
        #[serde(default)]
        sampling: Sampling,
        #[serde(default)]
        invert: bool,
        #[serde(default)]
        palette: Palette,
    },
    ResliceStart {
        ticket: u32,
        plane: Reslice,
        window: Option<Window>,
        #[serde(default)]
        sampling: Sampling,
        #[serde(default)]
        invert: bool,
        #[serde(default)]
        palette: Palette,
    },
    ResliceStep {
        ticket: u32,
    },
    ResliceCancel {
        ticket: u32,
    },
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FrameOutput {
    #[default]
    Rgba,
    Stored,
    Stored16,
    Texture16,
    Modality,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct DisplayOptions {
    window: Option<Window>,
    invert: bool,
    palette: Palette,
    voi: Option<VoiSelection>,
    quantitative: bool,
}

impl DisplayOptions {
    fn resolve(
        self,
        session: &Session,
        index: usize,
        fallback_voi: bool,
    ) -> Result<(RenderOptions, Option<Voi>, Option<QuantitativeScale>)> {
        if self.quantitative && (self.window.is_some() || self.voi.is_some()) {
            return Err(Error::InvalidRequest("quantitative scale or VOI selection"));
        }
        if let Some(window) = self.window {
            window.validate()?;
            if self.voi.is_some() {
                return Err(Error::InvalidRequest("one VOI selection or window"));
            }
        }
        let voi = match self
            .voi
            .map(|selection| session.select_voi(index, selection))
            .transpose()
        {
            Ok(voi) => voi,
            Err(_) if fallback_voi => None,
            Err(error) => return Err(error),
        };
        let scale = if self.quantitative {
            let scale = session.quantitative_scale(index);
            if scale.is_none() && !fallback_voi {
                return Err(Error::Unsupported("verified quantitative mapping"));
            }
            scale
        } else {
            None
        };
        Ok((
            RenderOptions {
                window: self.window,
                invert: self.invert,
                palette: self.palette,
            },
            voi,
            scale,
        ))
    }
}

pub struct Reply {
    pub metadata: String,
    pub data: Vec<u8>,
}

fn json(value: &impl Serialize) -> Result<Reply> {
    binary(value, Vec::new())
}

fn binary(value: &impl Serialize, data: Vec<u8>) -> Result<Reply> {
    let metadata = serde_json::to_string(value).map_err(|_| Error::Internal)?;
    Ok(Reply { metadata, data })
}

pub fn error_json(error: &Error) -> String {
    serde_json::to_string(error).unwrap_or_else(|_| r#"{"code":"internal"}"#.to_owned())
}

pub fn capabilities() -> Result<Reply> {
    json(
        &serde_json::json!({"abi": ABI_VERSION, "limits": Limits::default(), "methods": raykit_vet::methods().collect::<Vec<_>>() }),
    )
}

pub struct BoundSession {
    session: Session,
    active: Option<Arc<Frame>>,
    volume_sources: Vec<Session>,
    volume: Option<Volume>,
    plane: Option<ActivePlane>,
    reslicing: Option<PendingPlane>,
    plane_hits: u64,
    planes_computed: u64,
    volume_revision: u32,
    output_copy_bytes: u64,
    peak_output_bytes: usize,
    rendered_frames: u64,
    rendered_frame_bytes: u64,
    frame_proofs: Option<(String, raykit_core::FrameProofCatalog)>,
    tiles: Option<TileCatalog>,
    full_source_file_read_us: Option<u128>,
}

#[derive(Clone, Copy, PartialEq)]
struct PlaneKey(Reslice, Sampling);

struct ActivePlane {
    key: PlaneKey,
    image: Resliced,
}

struct PendingPlane {
    ticket: u32,
    key: PlaneKey,
    work: ResliceWork,
    options: RenderOptions,
}

impl BoundSession {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open_path(path: &std::path::Path, options: OpenOptions) -> Result<(Self, Reply)> {
        Self::open_file(raykit_core::NativeFile::open(path)?, None, options)
    }
    pub fn open(bytes: Vec<u8>, options: OpenOptions) -> Result<(Self, Reply)> {
        options.check_primary()?;
        Self::bind(Self::checked_source(bytes, options)?)
    }

    pub fn open_index(bytes: &[u8], pin: &str, options: OpenOptions) -> Result<(Self, Reply)> {
        options.check_primary()?;
        let session = Self::checked_index(bytes, pin, &options)?;
        Self::bind(session)
    }

    pub fn open_proof(
        packet: Vec<u8>,
        pin: &str,
        revision: &str,
        frame: usize,
        options: OpenOptions,
    ) -> Result<(Self, Reply)> {
        options.check_primary()?;
        let session = Session::open_frame_proof(
            packet,
            pin,
            revision,
            frame,
            options.limits,
            options.expected_sha256.as_deref(),
        )?;
        options.check_expected_size(session.memory().source_bytes)?;
        Self::bind(Self::check_identifiers(session, &options)?)
    }

    pub fn stage_proof(&mut self, frame: usize, packet: Vec<u8>) -> Result<()> {
        self.session.stage_frame_proof(frame, packet)
    }

    fn checked_index(bytes: &[u8], pin: &str, options: &OpenOptions) -> Result<Session> {
        let session = Session::open_index(
            bytes,
            pin,
            options.limits,
            options.expected_sha256.as_deref(),
        )?;
        options.check_expected_size(session.memory().source_bytes)?;
        Self::check_identifiers(session, options)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn open_file(
        file: raykit_core::NativeFile,
        index: Option<(&[u8], &str)>,
        options: OpenOptions,
    ) -> Result<(Self, Reply)> {
        options.check_primary()?;
        let (session, read_us) = if let Some((manifest, pin)) = index {
            let mut session = Self::checked_index(manifest, pin, &options)?;
            session.bind_file(file)?;
            (session, None)
        } else {
            let (session, read_us) = Self::checked_file(&file, &options)?;
            (session, Some(read_us))
        };
        let (mut bound, reply) = Self::bind(session)?;
        bound.full_source_file_read_us = read_us;
        Ok((bound, reply))
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn checked_file(
        file: &raykit_core::NativeFile,
        options: &OpenOptions,
    ) -> Result<(Session, u128)> {
        if file.len()
            > options
                .limits
                .source_bytes
                .min(Limits::default().source_bytes) as u64
        {
            return Err(Error::Limit("source file bytes"));
        }
        let len = file.len() as usize;
        options.check_expected_size(len)?;
        let started = std::time::Instant::now();
        let bytes = file.read(0, len)?;
        let read_us = started.elapsed().as_micros();
        let session =
            Session::open_verified(bytes, options.limits, options.expected_sha256.as_deref())?;
        Ok((Self::check_identifiers(session, options)?, read_us))
    }

    pub fn frame_range(&self, index: usize) -> Result<raykit_core::FrameRange> {
        self.session.frame_range(index)
    }
    pub fn stage_range(&mut self, index: usize, bytes: Vec<u8>) -> Result<()> {
        self.session.stage_range(index, bytes)
    }
    pub fn clear_range(&mut self) {
        self.session.clear_range();
    }
    pub fn source_bytes(&self) -> usize {
        self.session.memory().source_bytes
    }

    pub fn adopt_full_source(&mut self, full: Self) -> Result<()> {
        if full.session.inspection().verification != "full_source"
            || full.session.inspection().content_sha256 != self.session.inspection().content_sha256
            || full.source_bytes() != self.source_bytes()
        {
            return Err(Error::Integrity("full source differs from indexed source"));
        }
        self.session = full.session;
        self.full_source_file_read_us = full.full_source_file_read_us;
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    pub async fn open_in_worker(bytes: Vec<u8>, options: OpenOptions) -> Result<(Self, Reply)> {
        options.check_primary()?;
        options.check_expected_size(bytes.len())?;
        let session = if options.prepare_first_frame {
            Session::open_preparing_frame(bytes, options.limits, options.expected_sha256.as_deref())
                .await?
        } else {
            Session::open_in_worker(bytes, options.limits, options.expected_sha256.as_deref())
                .await?
        };
        Self::bind(Self::check_identifiers(session, &options)?)
    }

    fn bind(session: Session) -> Result<(Self, Reply)> {
        let mut inspection =
            serde_json::to_value(session.inspection()).map_err(|_| Error::Internal)?;
        inspection["series_description"] = serde_json::json!(session.series_description());
        let inspection = json(&inspection)?;
        Ok((
            Self {
                session,
                active: None,
                volume_sources: Vec::new(),
                volume: None,
                plane: None,
                reslicing: None,
                plane_hits: 0,
                planes_computed: 0,
                volume_revision: 1,
                output_copy_bytes: 0,
                peak_output_bytes: 0,
                rendered_frames: 0,
                rendered_frame_bytes: 0,
                frame_proofs: None,
                tiles: None,
                full_source_file_read_us: None,
            },
            inspection,
        ))
    }

    fn checked_source(bytes: Vec<u8>, options: OpenOptions) -> Result<Session> {
        options.check_expected_size(bytes.len())?;
        let session =
            Session::open_verified(bytes, options.limits, options.expected_sha256.as_deref())?;
        Self::check_identifiers(session, &options)
    }

    fn check_identifiers(session: Session, options: &OpenOptions) -> Result<Session> {
        let info = session.inspection();
        if options
            .expected_instance_uid
            .as_deref()
            .is_some_and(|uid| uid != info.instance_uid)
            || options
                .expected_series_uid
                .as_deref()
                .is_some_and(|uid| info.series_uid.as_deref() != Some(uid))
            || options
                .expected_study_uid
                .as_deref()
                .is_some_and(|uid| info.study_uid.as_deref() != Some(uid))
        {
            return Err(Error::Integrity("source DICOM identifiers"));
        }
        Ok(session)
    }

    fn constrain_append(&self, options: &mut OpenOptions) -> Result<usize> {
        if options.attachment.is_some() {
            options.limits.source_bytes = options.limits.source_bytes.min(64 * 1024 * 1024);
            options.limits.inflated_bytes = options.limits.inflated_bytes.min(64 * 1024 * 1024);
            return Ok(64 * 1024 * 1024);
        }
        let max = Limits::default().source_bytes;
        let total = self
            .volume_sources
            .iter()
            .chain(std::iter::once(&self.session))
            .map(|session| session.memory().resident_dataset_bytes)
            .sum::<usize>();
        let remaining = max.saturating_sub(total);
        options.limits.source_bytes = options.limits.source_bytes.min(remaining);
        options.limits.inflated_bytes = options.limits.inflated_bytes.min(remaining);
        if self.volume_sources.len() >= 512 {
            return Err(Error::Limit("volume source count"));
        }
        Ok(remaining)
    }

    pub fn append(&mut self, bytes: Vec<u8>, mut options: OpenOptions) -> Result<Reply> {
        let remaining = self.constrain_append(&mut options)?;
        let attachment = options.attachment.take();
        let source = Self::checked_source(bytes, options)?;
        self.attach(source, attachment, remaining)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn append_file(
        &mut self,
        file: raykit_core::NativeFile,
        mut options: OpenOptions,
    ) -> Result<Reply> {
        let remaining = self.constrain_append(&mut options)?;
        let (source, _) = Self::checked_file(&file, &options)?;
        self.attach(source, options.attachment.take(), remaining)
    }

    fn attach(
        &mut self,
        source: Session,
        attachment: Option<Attachment>,
        remaining: usize,
    ) -> Result<Reply> {
        if let Some(attachment) = attachment {
            let reply = match attachment {
                Attachment::Sr {
                    expected_source_sha256,
                } => json(
                    &self
                        .session
                        .import_distance_sr(&source, expected_source_sha256.as_deref())?,
                )?,
                Attachment::Segmentation { frame, segment } => {
                    let mut overlay = self.session.segmentation_overlay(&source, frame, segment)?;
                    let mask = std::mem::take(&mut overlay.mask);
                    binary(&overlay, mask)?
                }
                Attachment::Presentation { frame } => {
                    json(&self.session.presentation(&source, frame)?)?
                }
            };
            self.output_copy_bytes += reply.data.len() as u64;
            self.peak_output_bytes = self.peak_output_bytes.max(reply.data.capacity());
            return Ok(reply);
        }
        let new = source.inspection();
        if let Some(previous) = self
            .volume_sources
            .iter()
            .chain(std::iter::once(&self.session))
            .map(Session::inspection)
            .find(|old| old.instance_uid == new.instance_uid)
        {
            if previous.content_sha256 != new.content_sha256 {
                return Err(Error::Integrity(
                    "volume already contains this instance at a different revision",
                ));
            }
            return json(
                &serde_json::json!({"added": false, "revision": self.volume_revision, "inspection": previous}),
            );
        }
        if source.memory().resident_dataset_bytes > remaining {
            return Err(Error::Limit("volume source bytes"));
        }
        self.volume_revision += 1;
        let reply = json(
            &serde_json::json!({"added": true, "revision": self.volume_revision, "inspection": new}),
        )?;
        self.volume_sources.push(source);
        self.volume = None;
        self.invalidate_plane();
        Ok(reply)
    }

    fn frame(&mut self, index: usize) -> Result<Arc<Frame>> {
        if let Some(frame) = &self.active
            && frame.index == index
        {
            return Ok(Arc::clone(frame));
        }
        self.session.read_frame(index)
    }

    pub fn request(&mut self, bytes: &[u8]) -> Result<Reply> {
        if bytes.len() > MAX_COMMAND_BYTES {
            return Err(Error::Limit("command bytes"));
        }
        let command =
            serde_json::from_slice(bytes).map_err(|_| Error::InvalidRequest("command"))?;
        let reply = match command {
            Command::Frame {
                index,
                output,
                options,
                fallback_voi,
            } => {
                let (options, voi, scale) = options.resolve(&self.session, index, fallback_voi)?;
                let frame = self.frame(index)?;
                let (encoding, data) = match output {
                    FrameOutput::Texture16
                        if scale.is_none() && frame.texture16_with_voi(options, voi.as_ref()) =>
                    {
                        let Samples::Monochrome(samples) = &frame.samples else {
                            return Err(Error::Internal);
                        };
                        let rgba = samples
                            .iter()
                            .flat_map(|&sample| {
                                let [low, high] = (sample as u16).to_le_bytes();
                                [low, high, 0, 255]
                            })
                            .collect();
                        ("mono_u16_rg", rgba)
                    }
                    FrameOutput::Rgba | FrameOutput::Texture16 => (
                        "rgba8",
                        self.render_frame(&frame, options, voi.as_ref(), scale.as_ref())?,
                    ),
                    FrameOutput::Stored16 if frame.format.stored_bounds().is_some() => {
                        let Samples::Monochrome(samples) = &frame.samples else {
                            return Err(Error::Internal);
                        };
                        let bias = if frame.format.signed { 0 } else { 32768 };
                        (
                            "mono_i16_le",
                            samples
                                .iter()
                                .flat_map(|&sample| ((sample - bias) as i16).to_le_bytes())
                                .collect(),
                        )
                    }
                    FrameOutput::Stored | FrameOutput::Stored16 => match &frame.samples {
                        Samples::Monochrome(samples) => (
                            "mono_i32_le",
                            samples.iter().flat_map(|s| s.to_le_bytes()).collect(),
                        ),
                        Samples::Color { space, values } => {
                            let encoding = match space {
                                raykit_core::pixel::ColorSpace::Rgb => "rgb8",
                                raykit_core::pixel::ColorSpace::YbrFull => "ybr_full8",
                            };
                            (encoding, values.clone())
                        }
                    },
                    FrameOutput::Modality => {
                        let Samples::Monochrome(samples) = &frame.samples else {
                            return Err(Error::Unsupported("color modality values"));
                        };
                        let display = frame.display.as_ref().ok_or(Error::Internal)?;
                        let values = samples
                            .iter()
                            .flat_map(|&stored| {
                                if display.is_padding(stored) {
                                    f64::NAN
                                } else {
                                    display.modality.at(stored)
                                }
                                .to_le_bytes()
                            })
                            .collect();
                        ("modality_f64_le", values)
                    }
                };
                let reply = binary(
                    &serde_json::json!({
                        "source": self.session.source_reference(index)?, "format": frame.format,
                        "geometry": frame.geometry, "display": frame.display, "encoding": encoding,
                        "views": self.session.voi_alternatives(index)?,
                        "modality_unit": self.session.modality_unit(index)?,
                        "quantitative_scale": scale.or_else(|| self.session.quantitative_scale(index)),
                        "doppler_scales": self.session.doppler_scales(index),
                    }),
                    data,
                )?;
                self.active = Some(frame);
                reply
            }
            Command::Prefetch { index } => {
                self.frame(index)?;
                json(&())?
            }
            Command::CreateFrameIndex => {
                let index = self.session.create_frame_index()?;
                binary(&serde_json::json!({"sha256": index.sha256}), index.bytes)?
            }
            Command::FrameProof { index, revision } => {
                if !self
                    .frame_proofs
                    .as_ref()
                    .is_some_and(|(cached, _)| *cached == revision)
                {
                    let catalog = self.session.create_frame_proofs(&revision)?;
                    self.frame_proofs = Some((revision, catalog));
                }
                let (revision, catalog) = self.frame_proofs.as_ref().ok_or(Error::Internal)?;
                binary(
                    &serde_json::json!({
                        "root_sha256": catalog.root_sha256(), "revision": revision, "frame": index,
                        "frames": catalog.frames(), "source": self.session.source_reference(index)?,
                    }),
                    catalog.packet(index)?,
                )?
            }
            Command::PrepareTiles {
                index,
                edge,
                revision,
            } => {
                let tiles = self.session.create_tiles(index, edge, &revision)?;
                let (pin, manifest) = tiles.manifest()?;
                let count = tiles.count();
                self.tiles = Some(tiles);
                binary(
                    &serde_json::json!({"sha256":pin,"tiles":count,"revision":revision,
                    "source":self.session.source_reference(index)?}),
                    manifest,
                )?
            }
            Command::Tile { index } => binary(
                &serde_json::json!({"index":index}),
                self.tiles
                    .as_ref()
                    .ok_or(Error::InvalidRequest("prepare tiles first"))?
                    .tile(index)?,
            )?,
            Command::Render { index, options } => {
                let (options, voi, scale) = options.resolve(&self.session, index, false)?;
                let frame = self.frame(index)?;
                binary(
                    &serde_json::json!({"source": self.session.source_reference(index)?, "encoding": "rgba8"}),
                    self.render_frame(&frame, options, voi.as_ref(), scale.as_ref())?,
                )?
            }
            Command::Views { index } => json(&self.session.voi_alternatives(index)?)?,
            Command::Sample { index, x, y } => json(&self.frame(index)?.sample(x, y)?)?,
            Command::SampleAt { index, x, y } => {
                let frame = self.frame(index)?;
                let sample = frame.sample(x, y)?;
                let quantitative = match sample {
                    raykit_core::Sample::Monochrome { stored, padding: false, .. } => self.session.quantitative_scale(index).and_then(|scale|
                        scale.value(stored).map(|value| serde_json::json!({"value":value,"quantity":scale.quantity,"unit":scale.unit}))),
                    _ => None,
                };
                let at = PixelPoint {
                    x: f64::from(x),
                    y: f64::from(y),
                };
                json(&serde_json::json!({
                    "sample": sample,
                    "quantitative": quantitative,
                    "doppler_axes": self.session.doppler_point(index, x, y),
                    "source": self.session.source_reference(index)?,
                    "geometry": frame.geometry,
                    "modality_unit": self.session.modality_unit(index)?,
                    "patient": frame.geometry.patient_plane.map(|plane| plane.at(at)),
                }))?
            }
            Command::FrameInfo { index } => json(&serde_json::json!({
                "source": self.session.source_reference(index)?,
                "format": self.session.inspection().pixel_format,
                "geometry": self.session.geometry(index)?,
                "views": self.session.voi_alternatives(index)?,
                "modality_unit": self.session.modality_unit(index)?,
                "quantitative_scale": self.session.quantitative_scale(index),
                "doppler_scales": self.session.doppler_scales(index),
            }))?,
            Command::LocatePatient {
                point,
                reference,
                normal,
            } => json(
                &self
                    .session
                    .locate_patient(point, &reference, normal)?
                    .map(|(frame, pixel)| serde_json::json!({"frame":frame,"pixel":pixel})),
            )?,
            Command::Transform { index, view, point } => {
                let geometry = self.session.geometry(index)?;
                let format = self
                    .session
                    .inspection()
                    .pixel_format
                    .ok_or(Error::Internal)?;
                let transform =
                    view.transform(format.columns, format.rows, geometry.display_spacing_xy)?;
                let pixel = point.map(|p| transform.to_pixel(p));
                let patient = pixel
                    .zip(geometry.patient_plane)
                    .map(|(pixel, plane)| plane.at(pixel));
                json(
                    &serde_json::json!({"transform": transform, "pixel": pixel, "patient": patient}),
                )?
            }
            Command::Measure { index, request } => {
                let method = raykit_vet::method(&request.method)?;
                json(&self.session.measure(index, request, method)?)?
            }
            Command::Reopen { record } => {
                let method = raykit_vet::method(&record.input.method)?;
                json(&self.session.reopen_measurement(record, method)?)?
            }
            Command::Verify { record } => {
                let method = raykit_vet::method(&record.input.method)?;
                let values = record.values.clone();
                let actual = self.session.reopen_measurement(record, method)?;
                if values.len() != actual.values.len()
                    || values.iter().zip(&actual.values).any(|(stored, computed)| {
                        !stored.value.is_finite()
                            || stored.name != computed.name
                            || stored.unit != computed.unit
                            || (stored.value - computed.value).abs()
                                > 1e-12 * computed.value.abs().max(1.0)
                    })
                {
                    return Err(Error::Integrity("measurement values differ"));
                }
                json(&actual)?
            }
            Command::Evict => {
                self.active = None;
                self.tiles = None;
                self.session.evict_frames();
                self.invalidate_plane();
                if let Some(volume) = &self.volume {
                    volume.evict();
                }
                json(&())?
            }
            Command::Stats => json(&serde_json::json!({
                "session": self.session.memory(), "output_copy_bytes": self.output_copy_bytes,
                "full_source_file_read_us": self.full_source_file_read_us,
                "peak_output_bytes": self.peak_output_bytes,
                "rendered_frames": self.rendered_frames, "rendered_frame_bytes": self.rendered_frame_bytes,
                "active_pixel_bytes_upper_bound": self.active.as_ref().map_or(0, |f| f.format.pixels() * if f.format.photometric.is_monochrome() { 4 } else { 3 }),
                "volume": self.volume.as_ref().map(Volume::memory),
                "retained_dataset_bytes": self.volume_sources.iter().chain(std::iter::once(&self.session)).map(|s| s.memory().resident_dataset_bytes).sum::<usize>(),
                "plane_cache_bytes": self.plane.as_ref().map_or(0, |p| p.image.values.len() * size_of::<f32>()),
                "plane_work_bytes": self.reslicing.as_ref().map_or(0, |p| p.work.bytes()),
                "planes_computed": self.planes_computed, "plane_cache_hits": self.plane_hits,
            }))?,
            Command::Document => binary(
                &serde_json::json!({"media_type": "application/pdf"}),
                self.session.pdf()?.to_vec(),
            )?,
            Command::Video => {
                let (media, bytes) = self.session.video()?;
                binary(
                    &serde_json::json!({"media_type": media, "quality": "preview"}),
                    bytes,
                )?
            }
            Command::ExportSr { record, options } => binary(
                &serde_json::json!({"media_type": "application/dicom"}),
                self.session.export_distance_sr(record, &options)?,
            )?,
            Command::VolumeCandidates => {
                let sources = std::iter::once(&self.session)
                    .chain(&self.volume_sources)
                    .collect::<Vec<_>>();
                json(
                    &serde_json::json!({"revision": self.volume_revision, "candidates": Volume::candidates(&sources)?}),
                )?
            }
            Command::VolumeBuild { index, revision } => {
                if self.volume_revision != revision {
                    return Err(Error::Integrity("volume candidate revision"));
                }
                self.invalidate_plane();
                let mut sources = std::iter::once(&mut self.session)
                    .chain(&mut self.volume_sources)
                    .collect::<Vec<_>>();
                self.volume = None;
                let volume = Volume::build(&mut sources, index)?;
                let reply = json(&volume.metadata)?;
                self.volume = Some(volume);
                reply
            }
            Command::VolumeSample { point } => json(
                &self
                    .volume
                    .as_ref()
                    .ok_or(Error::Geometry("volume is unavailable"))?
                    .try_sample(point)?,
            )?,
            Command::Reslice {
                plane,
                window,
                sampling,
                invert,
                palette,
            } => {
                let settings = RenderOptions {
                    window,
                    invert,
                    palette,
                };
                if let Some(reply) = self.begin_plane(0, PlaneKey(plane, sampling), settings)? {
                    reply
                } else {
                    loop {
                        if let Some(reply) = self.step_plane(0)? {
                            break reply;
                        }
                    }
                }
            }
            Command::ResliceStart {
                ticket,
                plane,
                window,
                sampling,
                invert,
                palette,
            } => {
                let settings = RenderOptions {
                    window,
                    invert,
                    palette,
                };
                self.begin_plane(ticket, PlaneKey(plane, sampling), settings)?
                    .map_or_else(|| json(&()), Ok)?
            }
            Command::ResliceStep { ticket } => {
                self.step_plane(ticket)?.map_or_else(|| json(&()), Ok)?
            }
            Command::ResliceCancel { ticket } => {
                if self
                    .reslicing
                    .as_ref()
                    .is_some_and(|work| work.ticket == ticket)
                {
                    self.reslicing = None;
                }
                json(&())?
            }
        };
        self.output_copy_bytes += reply.data.len() as u64;
        self.peak_output_bytes = self.peak_output_bytes.max(reply.data.capacity());
        Ok(reply)
    }

    fn render_frame(
        &mut self,
        frame: &Frame,
        options: RenderOptions,
        voi: Option<&Voi>,
        scale: Option<&QuantitativeScale>,
    ) -> Result<Vec<u8>> {
        let rgba = if let Some(scale) = scale {
            frame.render_quantitative(scale, options.invert)?
        } else {
            frame.render_rgba_with_voi(options, voi)?
        };
        self.rendered_frames += 1;
        self.rendered_frame_bytes += rgba.len() as u64;
        Ok(rgba)
    }

    fn invalidate_plane(&mut self) {
        self.reslicing = None;
        self.plane = None;
    }

    fn begin_plane(
        &mut self,
        ticket: u32,
        key: PlaneKey,
        options: RenderOptions,
    ) -> Result<Option<Reply>> {
        if let Some(window) = options.window {
            window.validate()?;
        }
        self.reslicing = None;
        if let Some(plane) = &self.plane
            && plane.key == key
        {
            self.plane_hits += 1;
            return Ok(Some(plane_reply(&plane.image, options)?));
        }
        let volume = self
            .volume
            .as_ref()
            .ok_or(Error::Geometry("volume is unavailable"))?;
        self.plane = None;
        self.reslicing = Some(PendingPlane {
            ticket,
            key,
            work: volume.start_reslice(&key.0, key.1)?,
            options,
        });
        Ok(None)
    }

    fn step_plane(&mut self, ticket: u32) -> Result<Option<Reply>> {
        let current = self
            .reslicing
            .as_mut()
            .filter(|work| work.ticket == ticket)
            .ok_or(Error::Cancelled)?;
        let volume = self
            .volume
            .as_ref()
            .ok_or(Error::Geometry("volume is unavailable"))?;
        match volume.advance_reslice(&mut current.work) {
            Err(error) => {
                self.reslicing = None;
                Err(error)
            }
            Ok(false) => Ok(None),
            Ok(true) => {
                let current = self.reslicing.take().ok_or(Error::Internal)?;
                let image = current.work.finish()?;
                let reply = plane_reply(&image, current.options)?;
                self.plane = Some(ActivePlane {
                    key: current.key,
                    image,
                });
                self.planes_computed += 1;
                Ok(Some(reply))
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum TileCommand {
    Render {
        rect: TileRegion,
        #[serde(default)]
        options: RenderOptions,
    },
    Sample {
        x: u32,
        y: u32,
    },
    Measure {
        request: Request,
    },
    Stats,
}

pub struct BoundTiles(TiledImage);

impl BoundTiles {
    pub fn open(bytes: &[u8], pin: &str, revision: &str) -> Result<Self> {
        Ok(Self(TiledImage::open(bytes, pin, revision)?))
    }
    pub fn info(&self) -> Result<String> {
        Ok(json(&self.0.info())?.metadata)
    }
    pub fn need(&mut self, rect: &[u8]) -> Result<Vec<usize>> {
        let region =
            serde_json::from_slice(rect).map_err(|_| Error::InvalidRequest("tile region"))?;
        self.0.needed(region)
    }
    pub fn stage(&mut self, index: usize, bytes: Vec<u8>) -> Result<()> {
        self.0.stage(index, bytes)
    }
    pub fn request(&mut self, command: &[u8]) -> Result<Reply> {
        if command.len() > MAX_COMMAND_BYTES {
            return Err(Error::Limit("tile command bytes"));
        }
        match serde_json::from_slice(command).map_err(|_| Error::InvalidRequest("tile command"))? {
            TileCommand::Render { rect, options } => binary(&rect, self.0.rgba(rect, options)?),
            TileCommand::Sample { x, y } => json(&self.0.sample(x, y)?),
            TileCommand::Measure { request } => {
                let method = raykit_vet::method(&request.method)?;
                json(&self.0.measure(request, method)?)
            }
            TileCommand::Stats => {
                json(&serde_json::json!({"cached_tile_bytes": self.0.cached_bytes()}))
            }
        }
    }
}

fn plane_reply(output: &Resliced, options: RenderOptions) -> Result<Reply> {
    let (encoding, bytes) = if let Some(window) = options.window {
        (
            "rgba8",
            output.render(window, options.invert, options.palette)?,
        )
    } else {
        (
            "modality_f32_le",
            output.values.iter().flat_map(|v| v.to_le_bytes()).collect(),
        )
    };
    binary(
        &serde_json::json!({"encoding": encoding, "dimensions": output.dimensions, "plane": output.plane}),
        bytes,
    )
}
