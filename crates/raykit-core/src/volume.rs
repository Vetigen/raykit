use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};

use serde::{Deserialize, Serialize};

use crate::{
    Error, Object, Result, Session,
    dicom::{Dataset, File, uid},
    geometry::{PatientPlane, PatientPoint, PixelPoint, add, dot, scale, sub, valid_spacing},
    measurement::SourceReference,
    pixel::{Palette, Window, palette_rgb},
    source::{frame_geometry, groups},
};

const SLICE_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MPR_WORK: usize = 32 * 1024 * 1024;
const MAX_VOLUME_FRAMES: usize = 4096;
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
    id: Arc<()>,
    sources: Vec<Session>,
    slices: Vec<(usize, usize)>,
    cache: RefCell<SliceCache>,
}

#[derive(Default)]
struct SliceCache {
    slices: VecDeque<(usize, Vec<f32>)>,
    decoded: u64,
    hits: u64,
    peak: usize,
}

#[derive(Serialize)]
pub struct VolumeMemory {
    pub slice_cache_limit_bytes: usize,
    pub slice_cache_bytes: usize,
    pub peak_slice_cache_bytes: usize,
    pub decoded_slices: u64,
    pub slice_cache_hits: u64,
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
        if !format.photometric.is_monochrome() {
            continue;
        }
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
    if slices.len() > MAX_VOLUME_FRAMES {
        return Err(Error::Limit("volume frames"));
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
    if !normal_step.is_finite() || normal_step < GEOMETRY_TOLERANCE_MM {
        return Err(Error::Geometry("duplicate spatial plane"));
    }
    let tolerance = (normal_step * 0.01).max(GEOMETRY_TOLERANCE_MM);
    for (number, slice) in slices.iter().enumerate() {
        let plane = slice.plane.expect("validated slice");
        let delta = sub(
            plane.origin.0,
            add(first.origin.0, scale(step, number as f64)),
        );
        let distance = dot(delta, delta).sqrt();
        if !distance.is_finite() || distance > tolerance {
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
        let mut references = Vec::with_capacity(count);
        let mut reader_indices = BTreeMap::new();
        let mut sources = Vec::new();
        let mut members = Vec::with_capacity(count);
        for slice in slices {
            let session = &sessions[slice.source];
            references.push(session.source_reference(slice.index)?);
            let reader = *reader_indices.entry(slice.source).or_insert_with(|| {
                sources.push(session.volume_reader());
                sources.len() - 1
            });
            members.push((reader, slice.index));
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
        Ok(Self {
            metadata,
            id: Arc::new(()),
            sources,
            slices: members,
            cache: RefCell::default(),
        })
    }

    fn slice_bytes(&self) -> usize {
        self.metadata.voxel_bytes / self.slices.len()
    }

    fn slice_slots(&self) -> usize {
        (SLICE_CACHE_BYTES / self.slice_bytes())
            .max(2)
            .min(self.slices.len())
    }

    pub fn memory(&self) -> VolumeMemory {
        let cache = self.cache.borrow();
        let bytes = self.slice_bytes();
        VolumeMemory {
            slice_cache_limit_bytes: self.slice_slots() * bytes,
            slice_cache_bytes: cache.slices.len() * bytes,
            peak_slice_cache_bytes: cache.peak * bytes,
            decoded_slices: cache.decoded,
            slice_cache_hits: cache.hits,
        }
    }

    pub fn evict(&self) {
        self.cache.borrow_mut().slices.clear();
    }

    fn voxel_delta(&self, delta: [f64; 3]) -> [f64; 3] {
        let first = self.metadata.plane;
        let step = self.metadata.slice_step_mm;
        let normal = first.normal();
        let z = dot(delta, normal) / dot(step, normal);
        let xy = sub(delta, scale(step, z));
        [
            dot(first.column_axis, xy) / first.spacing_xy[0],
            dot(first.row_axis, xy) / first.spacing_xy[1],
            z,
        ]
    }

    /// Trilinear interpolation in the patient-space affine, returning modality values.
    pub fn sample(&self, point: PatientPoint) -> Option<f32> {
        self.try_sample(point).ok().flatten()
    }

    pub fn try_sample(&self, point: PatientPoint) -> Result<Option<f32>> {
        let delta = sub(point.0, self.metadata.plane.origin.0);
        self.sample_voxel(
            self.voxel_delta(delta),
            Sampling::Trilinear,
            &mut self.cache.borrow_mut(),
        )
    }

    fn read_slice<'a>(&self, at: usize, cache: &'a mut SliceCache) -> Result<&'a [f32]> {
        let last = cache.slices.len().checked_sub(1);
        if let Some(last) = last
            && cache.slices[last].0 == at
        {
            cache.hits += 1;
            return Ok(&cache.slices[last].1);
        }
        if let Some(pos) = cache.slices.iter().position(|(index, _)| *index == at) {
            cache.hits += 1;
            if cache.slices.len() == self.slices.len() {
                return Ok(&cache.slices[pos].1);
            }
            let hit = cache.slices.remove(pos).ok_or(Error::Internal)?;
            cache.slices.push_back(hit);
        } else {
            if cache.slices.len() == self.slice_slots() {
                cache.slices.pop_front();
            }
            let (source, frame) = self.slices[at];
            let values = self.sources[source].modality_slice(frame)?;
            cache.slices.push_back((at, values));
            cache.decoded += 1;
            cache.peak = cache.peak.max(cache.slices.len());
        }
        Ok(&cache.slices.back().ok_or(Error::Internal)?.1)
    }

    fn sample_voxel(
        &self,
        position: [f64; 3],
        sampling: Sampling,
        cache: &mut SliceCache,
    ) -> Result<Option<f32>> {
        let max = self.metadata.dimensions.map(|n| f64::from(n - 1));
        if position
            .iter()
            .zip(max)
            .any(|(&value, end)| !(-1e-6..=end + 1e-6).contains(&value))
        {
            return Ok(None);
        }
        let [x, y, z] = std::array::from_fn(|axis| position[axis].clamp(0.0, max[axis]));
        let columns = self.metadata.dimensions[0] as usize;
        if sampling == Sampling::Nearest {
            let slice = self.read_slice(z.round() as usize, cache)?;
            let v = slice[y.round() as usize * columns + x.round() as usize];
            return Ok(v.is_finite().then_some(v));
        }
        let neighbors = |v: f64| {
            [
                (v.floor() as usize, 1.0 - v.fract()),
                (v.ceil() as usize, v.fract()),
            ]
        };
        let mut result = 0.0;
        for (sz, wz) in neighbors(z) {
            if wz == 0.0 {
                continue;
            }
            let slice = self.read_slice(sz, cache)?;
            for (sx, wx) in neighbors(x) {
                for (sy, wy) in neighbors(y) {
                    let weight = wx * wy * wz;
                    if weight == 0.0 {
                        continue;
                    }
                    let v = slice[sy * columns + sx];
                    if !v.is_finite() {
                        return Ok(None);
                    }
                    result += weight * f64::from(v);
                }
            }
        }
        Ok(Some(result as f32))
    }

    pub fn reslice(&self, request: &Reslice) -> Result<Resliced> {
        let mut work = self.start_reslice(request, Sampling::Trilinear)?;
        while !self.advance_reslice(&mut work)? {}
        work.finish()
    }

    pub fn start_reslice(&self, request: &Reslice, sampling: Sampling) -> Result<ResliceWork> {
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
        let origin = self.voxel_delta(sub(plane.origin.0, self.metadata.plane.origin.0));
        let steps = [
            self.voxel_delta(scale(plane.column_axis, plane.spacing_xy[0])),
            self.voxel_delta(scale(plane.row_axis, plane.spacing_xy[1])),
            self.voxel_delta(normal),
        ];
        let lengths = [cols as usize, rows as usize, offsets.len()];
        let extent = |axis: usize| {
            steps[axis][2]
                * match axis {
                    0 | 1 => (lengths[axis] - 1) as f64,
                    _ => offsets[offsets.len() - 1] - offsets[0],
                }
        };
        let mut axes = [0, 1, 2];
        axes.sort_by(|&a, &b| {
            extent(b)
                .abs()
                .total_cmp(&extent(a).abs())
                .then(lengths[b].cmp(&lengths[a]))
        });
        let mut lower = f64::INFINITY;
        let mut upper = f64::NEG_INFINITY;
        for x in [0, lengths[0] - 1] {
            for y in [0, lengths[1] - 1] {
                for offset in [offsets[0], offsets[offsets.len() - 1]] {
                    let z = origin[2]
                        + steps[0][2] * x as f64
                        + steps[1][2] * y as f64
                        + steps[2][2] * offset;
                    if !z.is_finite() {
                        return Err(Error::Geometry("MPR plane outside finite coordinates"));
                    }
                    lower = lower.min(z);
                    upper = upper.max(z);
                }
            }
        }
        let last_slice = self.slices.len() - 1;
        let band = lower.floor().clamp(0.0, last_slice as f64) as usize;
        let end_band = if upper < -1e-6 || lower > last_slice as f64 + 1e-6 {
            band
        } else {
            upper.floor().clamp(0.0, last_slice as f64) as usize + 1
        };
        let band_width = self.slice_slots() - 1;
        let lines = lengths[axes[1]] * lengths[axes[2]];
        if end_band
            .saturating_sub(band)
            .div_ceil(band_width)
            .saturating_mul(lines)
            > MAX_MPR_WORK
        {
            return Err(Error::Limit("MPR slice traversal work"));
        }
        Ok(ResliceWork {
            id: Arc::clone(&self.id),
            plane,
            dimensions: request.dimensions,
            sampling,
            origin,
            steps,
            offsets,
            axes,
            lengths,
            band,
            end_band,
            band_width,
            line: 0,
            column: 0,
            values: vec![f32::NAN; count],
            average: matches!(request.slab, Slab::Average { .. })
                .then(|| (vec![0.0; count], vec![0; count])),
        })
    }

    pub fn advance_reslice(&self, work: &mut ResliceWork) -> Result<bool> {
        if !Arc::ptr_eq(&self.id, &work.id) {
            return Err(Error::Integrity("reslice volume"));
        }
        let mut cache = self.cache.borrow_mut();
        let mut remaining = 32_768usize;
        let start_decodes = cache.decoded;
        let [sweep, outer, inner] = work.axes;
        let lines = work.lengths[outer] * work.lengths[inner];
        while work.band < work.end_band && remaining > 0 && cache.decoded - start_decodes < 4 {
            let end = (work.band + work.band_width).min(work.end_band);
            let start_z = if work.band == 0 {
                -1e-6
            } else {
                work.band as f64
            };
            let end_z = if end == self.slices.len() {
                end as f64 - 1.0 + 2e-6
            } else {
                end as f64
            };
            let mut at = [0; 3];
            at[outer] = work.line / work.lengths[inner];
            at[inner] = work.line % work.lengths[inner];
            let (first, last) = work.span(at, start_z, end_z);
            let first = first.max(work.column);
            let stop = last.min(first + remaining - 1);
            for column in first..stop {
                at[sweep] = column;
                if let Some(value) = self.sample_voxel(work.voxel(at), work.sampling, &mut cache)? {
                    let i = at[1] * work.lengths[0] + at[0];
                    if let Some((sum, count)) = &mut work.average {
                        sum[i] += f64::from(value);
                        count[i] += 1;
                    } else {
                        work.values[i] = work.values[i].max(value);
                    }
                }
            }
            remaining -= stop.saturating_sub(first) + 1;
            if stop < last {
                work.column = stop;
                break;
            }
            work.column = 0;
            work.line += 1;
            if work.line == lines {
                work.line = 0;
                work.band = end;
            }
        }
        Ok(work.band == work.end_band)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Orientation {
    Axial,
    Coronal,
    Sagittal,
    Oblique { axes: [f64; 6] },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Slab {
    Single,
    Average { thickness_mm: f64 },
    Maximum { thickness_mm: f64 },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Reslice {
    pub center: PatientPoint,
    pub orientation: Orientation,
    pub dimensions: [u32; 2],
    pub spacing_xy: [f64; 2],
    pub slab: Slab,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Sampling {
    #[default]
    Trilinear,
    Nearest,
}

// A sweep visits each sample once and puts both z neighbors in a single cache band.
// A step yields between bounded pieces of work so callers can cancel or replace the request.
pub struct ResliceWork {
    id: Arc<()>,
    plane: PatientPlane,
    dimensions: [u32; 2],
    sampling: Sampling,
    origin: [f64; 3],
    steps: [[f64; 3]; 3],
    offsets: Vec<f64>,
    axes: [usize; 3],
    lengths: [usize; 3],
    band: usize,
    end_band: usize,
    band_width: usize,
    line: usize,
    column: usize,
    values: Vec<f32>,
    average: Option<(Vec<f64>, Vec<u16>)>,
}

impl ResliceWork {
    fn coordinate(&self, at: [usize; 3], axis: usize) -> f64 {
        self.origin[axis]
            + self.steps[0][axis] * at[0] as f64
            + self.steps[1][axis] * at[1] as f64
            + self.steps[2][axis] * self.offsets[at[2]]
    }

    fn voxel(&self, at: [usize; 3]) -> [f64; 3] {
        std::array::from_fn(|axis| self.coordinate(at, axis))
    }

    fn span(&self, mut at: [usize; 3], start: f64, end: f64) -> (usize, usize) {
        let sweep = self.axes[0];
        let count = self.lengths[sweep];
        let mut bound = |threshold: f64, descending: bool| {
            let (mut left, mut right) = (0, count);
            while left < right {
                at[sweep] = left + (right - left) / 2;
                if (self.coordinate(at, 2) < threshold) != descending {
                    left = at[sweep] + 1;
                } else {
                    right = at[sweep];
                }
            }
            left
        };
        if self.steps[sweep][2] < 0.0 {
            (bound(end, true), bound(start, true))
        } else {
            (bound(start, false), bound(end, false))
        }
    }

    pub fn bytes(&self) -> usize {
        self.values.len() * size_of::<f32>()
            + self.average.as_ref().map_or(0, |(sum, count)| {
                sum.len() * size_of::<f64>() + count.len() * size_of::<u16>()
            })
    }

    pub fn finish(mut self) -> Result<Resliced> {
        if self.band != self.end_band {
            return Err(Error::InvalidRequest("incomplete MPR plane"));
        }
        if let Some((sums, counts)) = self.average {
            for ((value, sum), count) in self.values.iter_mut().zip(sums).zip(counts) {
                if count > 0 {
                    *value = (sum / f64::from(count)) as f32;
                }
            }
        }
        Ok(Resliced {
            plane: self.plane,
            dimensions: self.dimensions,
            values: self.values,
        })
    }
}

pub struct Resliced {
    pub plane: PatientPlane,
    pub dimensions: [u32; 2],
    pub values: Vec<f32>,
}

impl Resliced {
    pub fn rgba(&self, window: Window) -> Result<Vec<u8>> {
        self.render(window, false, Palette::Gray)
    }

    pub fn render(&self, window: Window, invert: bool, palette: Palette) -> Result<Vec<u8>> {
        let window = window.validate()?;
        Ok(self
            .values
            .iter()
            .flat_map(|&value| {
                let level = if value.is_nan() {
                    0.0
                } else if invert {
                    1.0 - window.at(f64::from(value))
                } else {
                    window.at(f64::from(value))
                };
                let [r, g, b] = palette_rgb(level, palette);
                [r, g, b, 255]
            })
            .collect())
    }
}
