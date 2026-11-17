use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    Error, Object, Result, Session,
    dicom::{Dataset, File, uid},
    geometry::{PatientPlane, PatientPoint, PixelPoint, add, dot, scale, sub, valid_spacing},
    measurement::SourceReference,
    pixel::{Samples, Window},
    source::{frame_geometry, groups},
};

const MAX_VOLUME_BYTES: usize = 128 * 1024 * 1024;
const MAX_MPR_WORK: usize = 32 * 1024 * 1024;
const GEOMETRY_TOLERANCE_MM: f64 = 0.001;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Acquisition {
    pub sop_class_uid: String,
    pub series_uid: String,
    pub frame_of_reference_uid: String,
    pub stack: Option<String>,
    pub temporal_position: Option<String>,
    pub echo: Option<String>,
    pub phase: Option<String>,
    pub dimensions: Vec<Dimension>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Dimension {
    pub tag: [u16; 2],
    pub value: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub acquisition: Acquisition,
    pub frames: usize,
    pub available: bool,
    pub limitation: Option<Error>,
}

struct Slice {
    source: usize,
    index: usize,
    plane: Option<PatientPlane>,
    rows: u32,
    columns: u32,
    spacing_between: Option<f64>,
    thickness: Option<f64>,
}

pub struct Volume {
    pub metadata: VolumeMetadata,
    values: Vec<f32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct VolumeMetadata {
    pub acquisition: Acquisition,
    pub frames: Vec<SourceReference>,
    pub plane: PatientPlane,
    pub slice_step_mm: [f64; 3],
    pub dimensions: [u32; 3],
    pub voxel_bytes: usize,
    pub center: PatientPoint,
}

fn candidates(sessions: &[&Session]) -> Result<BTreeMap<Acquisition, Vec<Slice>>> {
    let mut sets = BTreeMap::<Acquisition, Vec<Slice>>::new();
    for (source, session) in sessions.iter().enumerate() {
        let info = session.inspection();
        if !matches!(
            info.object,
            Object::Ct | Object::EnhancedCt | Object::Mr | Object::EnhancedMr
        ) {
            continue;
        }
        let data = &session.file.dataset;
        let file = &session.file;
        let Some(format) = info.pixel_format.filter(|_| info.capabilities.frame_access) else {
            continue;
        };
        let image_type = data.text(&file.bytes, (8, 8));
        if is_localizer(image_type) {
            continue;
        }
        let series_uid = uid(data.text(&file.bytes, (0x20, 0x0e)))?.to_owned();
        let frame_of_reference_uid = session
            .frame_of_reference()
            .ok_or(Error::Geometry("missing Frame of Reference UID"))?
            .to_owned();
        let enhanced = matches!(info.object, Object::EnhancedCt | Object::EnhancedMr);
        if !enhanced && info.frames != 1 {
            return Err(Error::Unsupported("classic CT/MR with multiple frames"));
        }
        let dimension_tags = if enhanced { tags(file)? } else { Vec::new() };
        for index in 0..info.frames {
            let ct = groups(file, index, (0x18, 0x9329));
            let mr = groups(file, index, (0x18, 0x9226));
            if is_localizer(ct.text(&file.bytes, (8, 0x9007)))
                || is_localizer(mr.text(&file.bytes, (8, 0x9007)))
            {
                continue;
            }
            let content = groups(file, index, (0x20, 0x9111));
            let spatial = groups(file, index, (0x28, 0x9110));
            let echo = groups(file, index, (0x18, 0x9114))
                .fd(file, (0x18, 0x9082))
                .map(|value| value.to_string());
            let echo = echo.or_else(|| {
                data.first_ds(file, (0x18, 0x0081))
                    .map(|val| val.to_string())
            });
            let echo_number = optional_text(file, data, (0x18, 0x0086));
            let echo = match (echo_number, echo) {
                (Some(number), Some(time)) => Some(format!("{number}/{time}")),
                (Some(number), None) => Some(number),
                (None, time) => time,
            };
            let phase = data.first_ds(file, (0x18, 0x1060)).map(|v| v.to_string());
            let (stack, temporal_position, dimensions) = if enhanced {
                if std::ptr::eq(content, data) {
                    return Err(Error::Unsupported("enhanced CT/MR requires frame content"));
                }
                let values = content
                    .bytes(&file.bytes, (0x20, 0x9157))
                    .ok_or(Error::InvalidDicom("Dimension Index Values"))?;
                if values.len() != dimension_tags.len() * 4 {
                    return Err(Error::InvalidDicom("Dimension Index Values count"));
                }
                let mut dims = Vec::new();
                for (&tag, &word) in dimension_tags.iter().zip(values.as_chunks::<4>().0) {
                    let value = file.order.u32(word);
                    if value == 0 {
                        return Err(Error::InvalidDicom("dimension index must start at one"));
                    }
                    if !matches!(tag, [0x20, 0x9057 | 0x0032]) {
                        dims.push(Dimension { tag, value });
                    }
                }
                let temporal = content.ul(file, (0x20, 0x9128)).map(|v| v.to_string());
                (optional_text(file, content, (0x20, 0x9056)), temporal, dims)
            } else {
                (None, optional_text(file, data, (0x20, 0x0100)), Vec::new())
            };
            let meta = frame_geometry(file, info.object, format, index);
            let acquisition = Acquisition {
                sop_class_uid: info.sop_class_uid.clone(),
                series_uid: series_uid.clone(),
                frame_of_reference_uid: frame_of_reference_uid.clone(),
                stack,
                temporal_position,
                echo,
                phase,
                dimensions,
            };
            let member = Slice {
                source,
                index,
                plane: meta.patient_plane,
                rows: format.rows,
                columns: format.columns,
                spacing_between: spatial.first_ds(file, (0x18, 0x0088)),
                thickness: spatial.first_ds(file, (0x18, 0x0050)),
            };
            sets.entry(acquisition).or_default().push(member);
        }
    }
    Ok(sets)
}

fn tags(file: &File) -> Result<Vec<[u16; 2]>> {
    let sequence = file
        .dataset
        .sequence((0x20, 0x9222))
        .filter(|v| !v.is_empty() && v.len() <= 16)
        .ok_or(Error::Unsupported(
            "enhanced CT/MR requires Dimension Index Sequence",
        ))?;
    let mut tags = Vec::new();
    for dimension in sequence {
        let tag = dimension
            .bytes(&file.bytes, (0x20, 0x9165))
            .filter(|v| v.len() == 4)
            .ok_or(Error::InvalidDicom("Dimension Index Pointer"))?;
        let tag = [
            file.order.u16([tag[0], tag[1]]),
            file.order.u16([tag[2], tag[3]]),
        ];
        if tags.contains(&tag) {
            return Err(Error::Unsupported("repeated dimension index pointer"));
        }
        tags.push(tag);
    }
    if !tags.contains(&[0x20, 0x9057]) && !tags.contains(&[0x20, 0x0032]) {
        return Err(Error::Unsupported(
            "enhanced CT/MR requires a spatial dimension",
        ));
    }
    Ok(tags)
}

fn optional_text(file: &File, data: &Dataset, key: (u16, u16)) -> Option<String> {
    data.text(&file.bytes, key)
        .filter(|text| !text.is_empty() && text.len() <= 32)
        .map(str::to_owned)
}

fn is_localizer(value: Option<&str>) -> bool {
    value.is_some_and(|name| {
        name.split('\\')
            .any(|part| matches!(part, "LOCALIZER" | "SCOUT"))
    })
}

fn geometric_order(slices: &mut [Slice]) -> Result<(PatientPlane, [f64; 3], usize)> {
    let dimensions = slices
        .first()
        .map(|s| (s.rows, s.columns))
        .ok_or(Error::Geometry("empty volume"))?;
    let first = slices[0]
        .plane
        .ok_or(Error::Geometry("missing patient-plane geometry"))?;
    if slices.len() < 2 {
        return Err(Error::Geometry("at least two spatial slices are required"));
    }
    let normal = first.normal();
    for slice in slices.iter() {
        let plane = slice
            .plane
            .ok_or(Error::Geometry("missing patient-plane geometry"))?;
        if (slice.rows, slice.columns) != dimensions
            || dot(plane.column_axis, first.column_axis) < 1.0 - 1e-8
            || dot(plane.row_axis, first.row_axis) < 1.0 - 1e-8
            || plane
                .spacing_xy
                .iter()
                .zip(first.spacing_xy)
                .any(|(a, b)| (a - b).abs() > b * 1e-4)
        {
            return Err(Error::Geometry(
                "volume slice orientation, spacing or dimensions differ",
            ));
        }
    }
    slices.sort_by(|a, b| {
        dot(normal, a.plane.expect("validated slice").origin.0)
            .total_cmp(&dot(normal, b.plane.expect("validated slice").origin.0))
    });
    let first = slices[0].plane.expect("validated first slice");
    let second = slices[1].plane.expect("validated second slice");
    let step = sub(second.origin.0, first.origin.0);
    let normal_step = dot(step, normal);
    if normal_step < GEOMETRY_TOLERANCE_MM {
        return Err(Error::Geometry("duplicate spatial plane"));
    }
    let tolerance = (normal_step * 0.01).max(GEOMETRY_TOLERANCE_MM);
    for (number, slice) in slices.iter().enumerate() {
        let plane = slice.plane.expect("validated slice");
        let delta = sub(
            plane.origin.0,
            add(first.origin.0, scale(step, number as f64)),
        );
        if dot(delta, delta).sqrt() > tolerance {
            return Err(Error::Geometry(
                "gap, duplicate or nonuniform slice position",
            ));
        }
        if slice
            .spacing_between
            .is_some_and(|spacing| (spacing.abs() - normal_step).abs() > tolerance)
        {
            return Err(Error::Geometry(
                "slice positions differ from declared spacing",
            ));
        }
        if slice
            .thickness
            .is_some_and(|thickness| thickness > 0.0 && normal_step - thickness > tolerance)
        {
            return Err(Error::Geometry("gap between acquired slices"));
        }
    }
    let bytes = (dimensions.0 as usize)
        .checked_mul(dimensions.1 as usize)
        .and_then(|n| n.checked_mul(slices.len()))
        .and_then(|n| n.checked_mul(size_of::<f32>()))
        .filter(|n| *n <= MAX_VOLUME_BYTES)
        .ok_or(Error::Limit("volume voxel bytes"))?;
    Ok((first, step, bytes))
}

impl Volume {
    pub fn candidates(sessions: &[&Session]) -> Result<Vec<Candidate>> {
        Ok(candidates(sessions)?
            .into_iter()
            .map(|(acquisition, mut slices)| {
                let limitation = geometric_order(&mut slices).err();
                Candidate {
                    acquisition,
                    frames: slices.len(),
                    available: limitation.is_none(),
                    limitation,
                }
            })
            .collect())
    }

    /// Open a candidate returned by `candidates` for the same sources in the same state.
    pub fn build(sessions: &mut [&mut Session], candidate: usize) -> Result<Self> {
        let inputs: Vec<&Session> = sessions.iter().map(|s| &**s).collect();
        let (acquisition, mut slices) = candidates(&inputs)?
            .into_iter()
            .nth(candidate)
            .ok_or(Error::InvalidRequest("volume candidate index"))?;
        let (plane, step, bytes) = geometric_order(&mut slices)?;
        let columns = slices[0].columns;
        let rows = slices[0].rows;
        let count = slices.len();
        let mut values = Vec::new();
        values
            .try_reserve_exact(bytes / 4)
            .map_err(|_| Error::Limit("volume voxel allocation"))?;
        let mut references = Vec::with_capacity(count);
        for slice in slices {
            let session = &mut sessions[slice.source];
            references.push(session.source_reference(slice.index)?);
            let frame = session.read_frame(slice.index)?;
            let Samples::Monochrome(pixels) = &frame.samples else {
                return Err(Error::Unsupported("color volume"));
            };
            let display = frame.display.as_ref().ok_or(Error::Internal)?;
            values.extend(pixels.iter().map(|&value| {
                if display.is_padding(value) {
                    f32::NAN
                } else {
                    display.modality.at(value) as f32
                }
            }));
            session.evict_frames();
        }
        let center = PatientPoint(add(
            plane
                .at(PixelPoint {
                    x: (f64::from(columns) - 1.0) / 2.0,
                    y: (f64::from(rows) - 1.0) / 2.0,
                })
                .0,
            scale(step, (count as f64 - 1.0) / 2.0),
        ));
        let metadata = VolumeMetadata {
            acquisition,
            plane,
            slice_step_mm: step,
            frames: references,
            dimensions: [columns, rows, count as u32],
            voxel_bytes: bytes,
            center,
        };
        Ok(Self { metadata, values })
    }

    /// Trilinear interpolation in the patient-space affine, returning modality values.
    pub fn sample(&self, point: PatientPoint) -> Option<f32> {
        let first = self.metadata.plane;
        let step = self.metadata.slice_step_mm;
        let normal = first.normal();
        let z = dot(sub(point.0, first.origin.0), normal) / dot(step, normal);
        let (xy, _) = first.project(PatientPoint(sub(point.0, scale(step, z))));
        let [columns, rows, slices] = self.metadata.dimensions;
        let locate = |v: f64, n: u32| {
            if !(-1e-6..=f64::from(n - 1) + 1e-6).contains(&v) {
                return None;
            }
            let v = v.clamp(0.0, f64::from(n - 1));
            let base = v.floor() as usize;
            let next = (base + 1).min(n as usize - 1);
            let part = v.fract();
            Some([(base, 1.0 - part), (next, part)])
        };
        let mut result = 0.0;
        for (sx, wx) in locate(xy.x, columns)? {
            for (sy, wy) in locate(xy.y, rows)? {
                for (sz, wz) in locate(z, slices)? {
                    let weight = wx * wy * wz;
                    if weight == 0.0 {
                        continue;
                    }
                    let i = (sz * rows as usize + sy) * columns as usize + sx;
                    let v = self.values[i];
                    if !v.is_finite() {
                        return None;
                    }
                    result += weight * f64::from(v);
                }
            }
        }
        Some(result as f32)
    }

    pub fn reslice(&self, request: &Reslice) -> Result<Resliced> {
        let [cols, rows] = request.dimensions;
        if !valid_spacing(request.spacing_xy) || cols == 0 || rows == 0 {
            return Err(Error::InvalidRequest("MPR size and pixel spacing"));
        }
        let count = (cols as usize)
            .checked_mul(rows as usize)
            .filter(|&n| n <= 4 * 1024 * 1024)
            .ok_or(Error::Limit("MPR output pixels"))?;
        let axes = match request.orientation {
            Orientation::Axial => [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            Orientation::Coronal => [1.0, 0.0, 0.0, 0.0, 0.0, -1.0],
            Orientation::Sagittal => [0.0, 1.0, 0.0, 0.0, 0.0, -1.0],
            Orientation::Oblique { axes } => axes,
        };
        let mut plane = PatientPlane::new(request.center.0, axes, request.spacing_xy)
            .ok_or(Error::Geometry("MPR plane axes"))?;
        plane.origin = plane.at(PixelPoint {
            x: -(f64::from(cols) - 1.0) / 2.0,
            y: -(f64::from(rows) - 1.0) / 2.0,
        });
        let normal = plane.normal();
        let offsets = match request.slab {
            Slab::Single => vec![0.0],
            Slab::Average { thickness_mm } | Slab::Maximum { thickness_mm } => {
                if !thickness_mm.is_finite() || thickness_mm <= 0.0 || thickness_mm > 500.0 {
                    return Err(Error::InvalidRequest("slab thickness"));
                }
                let [x, y] = self.metadata.plane.spacing_xy;
                let z = dot(self.metadata.slice_step_mm, self.metadata.plane.normal());
                let intervals = (thickness_mm / (0.5 * x.min(y).min(z))).ceil();
                if intervals > 1024.0 || count.saturating_mul(intervals as usize + 1) > MAX_MPR_WORK
                {
                    return Err(Error::Limit("slab sample count"));
                }
                (0..=intervals as u32)
                    .map(|i| (f64::from(i) / intervals - 0.5) * thickness_mm)
                    .collect()
            }
        };
        let mut values = Vec::with_capacity(count);
        for y in 0..rows {
            for x in 0..cols {
                let origin = plane.at(PixelPoint {
                    x: f64::from(x),
                    y: f64::from(y),
                });
                let mut max = f32::NEG_INFINITY;
                let mut sum = 0.0;
                let mut valid = 0;
                for &distance in &offsets {
                    if let Some(v) =
                        self.sample(PatientPoint(add(origin.0, scale(normal, distance))))
                    {
                        valid += 1;
                        max = max.max(v);
                        sum += f64::from(v);
                    }
                }
                let value = if valid == 0 {
                    f32::NAN
                } else if matches!(request.slab, Slab::Maximum { .. }) {
                    max
                } else {
                    (sum / f64::from(valid)) as f32
                };
                values.push(value);
            }
        }
        Ok(Resliced {
            plane,
            dimensions: request.dimensions,
            values,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Orientation {
    Axial,
    Coronal,
    Sagittal,
    Oblique { axes: [f64; 6] },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Slab {
    Single,
    Average { thickness_mm: f64 },
    Maximum { thickness_mm: f64 },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reslice {
    pub center: PatientPoint,
    pub orientation: Orientation,
    pub dimensions: [u32; 2],
    pub spacing_xy: [f64; 2],
    pub slab: Slab,
}

pub struct Resliced {
    pub plane: PatientPlane,
    pub dimensions: [u32; 2],
    pub values: Vec<f32>,
}

impl Resliced {
    pub fn rgba(&self, window: Window) -> Result<Vec<u8>> {
        let window = window.validate()?;
        Ok(self
            .values
            .iter()
            .flat_map(|&value| {
                let level = if value.is_nan() {
                    0
                } else {
                    (255.0 * window.at(f64::from(value))).round() as u8
                };
                [level, level, level, 255]
            })
            .collect())
    }
}
