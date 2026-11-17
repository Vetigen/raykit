use std::sync::Arc;

use raykit_core::{
    Error, Frame, Limits, Result, Session,
    geometry::{ScreenPoint, View},
    interop::SrOptions,
    measurement::{Record, Request},
    pixel::{RenderOptions, Samples, Window},
    volume::{Reslice, Volume},
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
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Frame {
        index: usize,
        #[serde(default)]
        output: FrameOutput,
    },
    Prefetch {
        index: usize,
    },
    Render {
        index: usize,
        #[serde(default)]
        options: RenderOptions,
    },
    Sample {
        index: usize,
        x: u32,
        y: u32,
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
    Evict,
    Stats,
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
    },
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FrameOutput {
    #[default]
    Rgba,
    Stored,
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
    volume_revision: u32,
    output_copy_bytes: u64,
    peak_output_bytes: usize,
}

impl BoundSession {
    pub fn open(bytes: Vec<u8>, options: OpenOptions) -> Result<(Self, Reply)> {
        if options.attachment.is_some() {
            return Err(Error::InvalidRequest(
                "primary source cannot be an attachment",
            ));
        }
        let session = Self::checked_source(bytes, options)?;
        let inspection = json(session.inspection())?;
        Ok((
            Self {
                session,
                active: None,
                volume_sources: Vec::new(),
                volume: None,
                volume_revision: 1,
                output_copy_bytes: 0,
                peak_output_bytes: 0,
            },
            inspection,
        ))
    }

    fn checked_source(bytes: Vec<u8>, options: OpenOptions) -> Result<Session> {
        if options
            .expected_size
            .is_some_and(|size| bytes.len() != size)
        {
            return Err(Error::Integrity("source byte length"));
        }
        let session =
            Session::open_verified(bytes, options.limits, options.expected_sha256.as_deref())?;
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

    pub fn append(&mut self, bytes: Vec<u8>, mut options: OpenOptions) -> Result<Reply> {
        if let Some(attachment) = options.attachment.take() {
            options.limits.source_bytes = options.limits.source_bytes.min(64 * 1024 * 1024);
            options.limits.inflated_bytes = options.limits.inflated_bytes.min(64 * 1024 * 1024);
            let object = Self::checked_source(bytes, options)?;
            let reply = match attachment {
                Attachment::Sr {
                    expected_source_sha256,
                } => json(
                    &self
                        .session
                        .import_distance_sr(&object, expected_source_sha256.as_deref())?,
                )?,
                Attachment::Segmentation { frame, segment } => {
                    let mut overlay = self.session.segmentation_overlay(&object, frame, segment)?;
                    let mask = std::mem::take(&mut overlay.mask);
                    binary(&overlay, mask)?
                }
                Attachment::Presentation { frame } => {
                    json(&self.session.presentation(&object, frame)?)?
                }
            };
            self.output_copy_bytes += reply.data.len() as u64;
            self.peak_output_bytes = self.peak_output_bytes.max(reply.data.capacity());
            return Ok(reply);
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
        let source = Self::checked_source(bytes, options)?;
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
            Command::Frame { index, output } => {
                let frame = self.frame(index)?;
                let (encoding, data) = match output {
                    FrameOutput::Rgba => ("rgba8", frame.render_rgba(RenderOptions::default())?),
                    FrameOutput::Stored => match &frame.samples {
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
                };
                let reply = binary(
                    &serde_json::json!({
                        "source": self.session.source_reference(index)?, "format": frame.format,
                        "geometry": frame.geometry, "display": frame.display, "encoding": encoding,
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
            Command::Render { index, options } => {
                let frame = self.frame(index)?;
                binary(
                    &serde_json::json!({"source": self.session.source_reference(index)?, "encoding": "rgba8"}),
                    frame.render_rgba(options)?,
                )?
            }
            Command::Sample { index, x, y } => json(&self.frame(index)?.sample(x, y)?)?,
            Command::Transform { index, view, point } => {
                let frame = self.frame(index)?;
                let geometry = &frame.geometry;
                let transform = view.transform(
                    frame.format.columns,
                    frame.format.rows,
                    geometry.display_spacing_xy,
                )?;
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
            Command::Evict => {
                self.active = None;
                self.session.evict_frames();
                json(&())?
            }
            Command::Stats => json(&serde_json::json!({
                "session": self.session.memory(), "output_copy_bytes": self.output_copy_bytes,
                "peak_output_bytes": self.peak_output_bytes,
                "active_pixel_bytes_upper_bound": self.active.as_ref().map_or(0, |f| f.format.pixels() * if f.format.photometric.is_monochrome() { 4 } else { 3 }),
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
                    .sample(point),
            )?,
            Command::Reslice { plane, window } => {
                let output = self
                    .volume
                    .as_ref()
                    .ok_or(Error::Geometry("volume is unavailable"))?
                    .reslice(&plane)?;
                let (encoding, bytes) = if let Some(window) = window {
                    ("rgba8", output.rgba(window)?)
                } else {
                    (
                        "modality_f32_le",
                        output.values.iter().flat_map(|v| v.to_le_bytes()).collect(),
                    )
                };
                binary(
                    &serde_json::json!({"encoding": encoding, "dimensions": output.dimensions, "plane": output.plane}),
                    bytes,
                )?
            }
        };
        self.output_copy_bytes += reply.data.len() as u64;
        self.peak_output_bytes = self.peak_output_bytes.max(reply.data.capacity());
        Ok(reply)
    }
}
