use std::{collections::VecDeque, sync::Arc};

use serde::{Deserialize, Serialize};

use crate::{
    Error, Frame, FrameGeometry, Limits, Object, Result, Sample, Session,
    dicom::source_digest,
    geometry::{Anatomy, Calibration, valid_spacing},
    measurement::{Method, Record, Request, SourceReference, measure_on_geometry},
    pixel::{Display, PixelFormat, RenderOptions, Samples},
};

const MANIFEST_LIMIT: usize = 2 * 1024 * 1024;
const CACHE_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    source: SourceReference,
    revision: String,
    format: PixelFormat,
    calibration: Calibration,
    display_spacing_xy: [f64; 2],
    display: Display,
    edge: u32,
    tiles: Vec<String>,
}

impl Manifest {
    fn grid(&self) -> [u32; 2] {
        [
            self.format.columns.div_ceil(self.edge),
            self.format.rows.div_ceil(self.edge),
        ]
    }

    fn region(&self, index: usize) -> Result<Region> {
        let [nx, ny] = self.grid();
        if index >= (nx * ny) as usize {
            return Err(Error::InvalidRequest("tile index"));
        }
        let x = index as u32 % nx * self.edge;
        let y = index as u32 / nx * self.edge;
        Ok(Region {
            x,
            y,
            width: (self.format.columns - x).min(self.edge),
            height: (self.format.rows - y).min(self.edge),
        })
    }

    fn validate(&self) -> bool {
        let [rows, columns] = [self.format.rows, self.format.columns];
        matches!(
            self.calibration,
            Calibration::None | Calibration::Projection { .. }
        ) && match self.calibration {
            Calibration::Projection { spacing_xy, .. } => valid_spacing(spacing_xy),
            _ => true,
        } && self
            .source
            .sop_class_uid
            .starts_with("1.2.840.10008.5.1.4.1.1.")
            && Object::from_uid(&self.source.sop_class_uid) == Object::Projection
            && self.source.content_sha256.len() == 64
            && self
                .source
                .content_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            && self.version == 1
            && !self.revision.is_empty()
            && self.revision.len() <= 256
            && [128, 256, 512].contains(&self.edge)
            && rows > 0
            && columns > 0
            && u64::from(rows) * u64::from(columns) <= Limits::default().frame_pixels as u64
            && self.format.stored_bounds().is_some()
            && [8, 16].contains(&self.format.bits_allocated)
            && self.format.high_bit >= self.format.bits_stored - 1
            && self.format.high_bit < self.format.bits_allocated
            && !self.format.planar
            && self.display.valid()
            && valid_spacing(self.display_spacing_xy)
            && self.tiles.len() == self.grid().into_iter().product::<u32>() as usize
            && self
                .tiles
                .iter()
                .all(|pin| pin.len() == 64 && pin.bytes().all(|b| b.is_ascii_hexdigit()))
    }
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", source_digest(bytes))
}

pub struct TileCatalog {
    manifest: Manifest,
    frame: Arc<Frame>,
}

impl Session {
    pub fn create_tiles(&mut self, index: usize, edge: u32, revision: &str) -> Result<TileCatalog> {
        if self.inspection().verification != "full_source"
            || self.inspection().object != Object::Projection
        {
            return Err(Error::Unsupported(
                "tiles require a complete monochrome projection",
            ));
        }
        if ![128, 256, 512].contains(&edge) || revision.is_empty() || revision.len() > 256 {
            return Err(Error::InvalidRequest("tile edge or revision"));
        }
        let frame = self.read_frame(index)?;
        let mut catalog = TileCatalog {
            manifest: Manifest {
                version: 1,
                source: self.source_reference(index)?,
                revision: revision.into(),
                format: frame.format,
                calibration: frame.geometry.calibration.clone(),
                display_spacing_xy: frame.geometry.display_spacing_xy,
                display: frame
                    .display
                    .clone()
                    .ok_or(Error::Unsupported("monochrome tiles"))?,
                edge,
                tiles: Vec::new(),
            },
            frame,
        };
        let count = catalog.manifest.grid().into_iter().product::<u32>() as usize;
        for i in 0..count {
            catalog.manifest.tiles.push(fingerprint(&catalog.tile(i)?));
        }
        Ok(catalog)
    }
}

impl TileCatalog {
    pub fn manifest(&self) -> Result<(String, Vec<u8>)> {
        let data = serde_json::to_vec(&self.manifest).map_err(|_| Error::Internal)?;
        if data.len() > MANIFEST_LIMIT {
            return Err(Error::Limit("tile manifest bytes"));
        }
        Ok((fingerprint(&data), data))
    }

    pub fn count(&self) -> usize {
        self.manifest.tiles.len()
    }

    pub fn tile(&self, index: usize) -> Result<Vec<u8>> {
        let rect = self.manifest.region(index)?;
        let Samples::Monochrome(samples) = &self.frame.samples else {
            return Err(Error::Internal);
        };
        let columns = self.frame.format.columns;
        Ok((rect.y..rect.y + rect.height)
            .flat_map(|y| {
                let start = (y * columns + rect.x) as usize;
                samples[start..start + rect.width as usize]
                    .iter()
                    .flat_map(|n| n.to_le_bytes())
            })
            .collect())
    }
}

pub struct TiledImage {
    manifest: Manifest,
    cache: VecDeque<(usize, Vec<u8>)>,
    tile_bytes: usize,
}

impl TiledImage {
    pub fn open(data: &[u8], pin: &str, revision: &str) -> Result<Self> {
        if data.len() > MANIFEST_LIMIT {
            return Err(Error::Limit("tile manifest bytes"));
        }
        if !fingerprint(data).eq_ignore_ascii_case(pin) {
            return Err(Error::Integrity("tile manifest SHA-256"));
        }
        let manifest: Manifest =
            serde_json::from_slice(data).map_err(|_| Error::Integrity("tile manifest"))?;
        if revision != manifest.revision || !manifest.validate() {
            return Err(Error::Integrity("tile manifest revision or representation"));
        }
        Ok(Self {
            manifest,
            cache: VecDeque::new(),
            tile_bytes: 0,
        })
    }

    pub fn info(&self) -> serde_json::Value {
        serde_json::json!({"source": self.manifest.source, "format": self.manifest.format,
            "display_spacing_xy": self.manifest.display_spacing_xy, "calibration": self.manifest.calibration,
            "revision": self.manifest.revision, "edge": self.manifest.edge, "tile_count": self.manifest.tiles.len()})
    }

    pub fn cached_bytes(&self) -> usize {
        self.tile_bytes
    }

    pub fn needed(&mut self, rect: Region) -> Result<Vec<usize>> {
        let cols = self.manifest.format.columns;
        let rows = self.manifest.format.rows;
        if rect.width == 0
            || rect.height == 0
            || rect.x.saturating_add(rect.width) > cols
            || rect.y.saturating_add(rect.height) > rows
            || u64::from(rect.width) * u64::from(rect.height) > 4 * 1024 * 1024
        {
            return Err(Error::InvalidRequest("tiled image region"));
        }
        let edge = self.manifest.edge;
        let [nx, _] = self.manifest.grid();
        let indices: Vec<_> = (rect.y / edge..=(rect.y + rect.height - 1) / edge)
            .flat_map(|y| {
                (rect.x / edge..=(rect.x + rect.width - 1) / edge)
                    .map(move |x| (y * nx + x) as usize)
            })
            .collect();
        let mut bytes = 0;
        for &i in &indices {
            let part = self.manifest.region(i)?;
            bytes += (part.width * part.height * 4) as usize;
        }
        if bytes > CACHE_LIMIT {
            return Err(Error::Limit("tiled region cache size"));
        }
        let mut needed = Vec::new();
        for i in indices {
            if let Some(pos) = self.cache.iter().position(|(index, _)| *index == i) {
                let entry = self.cache.remove(pos).ok_or(Error::Internal)?;
                self.cache.push_back(entry);
            } else {
                needed.push(i);
            }
        }
        Ok(needed)
    }

    pub fn stage(&mut self, index: usize, data: Vec<u8>) -> Result<()> {
        let rect = self.manifest.region(index)?;
        if data.len() != (rect.width * rect.height * 4) as usize
            || !fingerprint(&data).eq_ignore_ascii_case(&self.manifest.tiles[index])
        {
            return Err(Error::Integrity("tile bytes or identity"));
        }
        let [min, max] = self
            .manifest
            .format
            .stored_bounds()
            .ok_or(Error::Internal)?;
        if data
            .as_chunks::<4>()
            .0
            .iter()
            .any(|&word| !(min..=max).contains(&i32::from_le_bytes(word)))
        {
            return Err(Error::Integrity("tile stored sample range"));
        }
        if self.cache.iter().any(|(id, _)| *id == index) {
            return Ok(());
        }
        while self.tile_bytes + data.len() > CACHE_LIMIT {
            self.tile_bytes -= self.cache.pop_front().ok_or(Error::Internal)?.1.len();
        }
        self.tile_bytes += data.len();
        self.cache.push_back((index, data));
        Ok(())
    }

    fn stored(&self, x: u32, y: u32) -> Result<i32> {
        if x >= self.manifest.format.columns || y >= self.manifest.format.rows {
            return Err(Error::InvalidRequest("tile pixel index"));
        }
        let edge = self.manifest.edge;
        let index = (y / edge * self.manifest.grid()[0] + x / edge) as usize;
        let bytes = self
            .cache
            .iter()
            .find(|(id, _)| *id == index)
            .ok_or(Error::FrameRange(index))?;
        let part = self.manifest.region(index)?;
        let offset = ((y - part.y) * part.width + x - part.x) as usize * 4;
        let value = i32::from_le_bytes(
            bytes.1[offset..offset + 4]
                .try_into()
                .map_err(|_| Error::Internal)?,
        );
        Ok(value)
    }

    pub fn sample(&self, x: u32, y: u32) -> Result<Sample> {
        let stored = self.stored(x, y)?;
        let display = &self.manifest.display;
        Ok(Sample::Monochrome {
            stored,
            modality: display.modality.at(stored),
            padding: display.is_padding(stored),
        })
    }

    pub fn rgba(&mut self, rect: Region, options: RenderOptions) -> Result<Vec<u8>> {
        if let Some(window) = options.window {
            window.validate()?;
        }
        if !self.needed(rect)?.is_empty() {
            return Err(Error::Integrity("tile region is incomplete"));
        }
        let display = &self.manifest.display;
        let map = display.rgba_mapper(
            self.manifest.format,
            options,
            &display.voi,
            (rect.width * rect.height) as usize,
        );
        let mut rgba = Vec::with_capacity((rect.width * rect.height * 4) as usize);
        let stride = self.manifest.grid()[0];
        let edge = self.manifest.edge;
        let end = rect.x + rect.width;
        for y in rect.y..rect.y + rect.height {
            let mut x = rect.x;
            while x < end {
                let index = (y / edge * stride + x / edge) as usize;
                let tile = self.manifest.region(index)?;
                let (_, bytes) = self
                    .cache
                    .iter()
                    .find(|(id, _)| *id == index)
                    .ok_or(Error::Internal)?;
                let offset = ((y - tile.y) * tile.width + x - tile.x) as usize * 4;
                let last = end.min(tile.x + tile.width);
                let span = &bytes[offset..offset + (last - x) as usize * 4];
                rgba.extend(
                    span.as_chunks::<4>()
                        .0
                        .iter()
                        .flat_map(|&word| map(i32::from_le_bytes(word))),
                );
                x = last;
            }
        }
        Ok(rgba)
    }

    pub fn measure(&self, request: Request, method: &dyn Method) -> Result<Record> {
        let geometry = FrameGeometry {
            calibration: self.manifest.calibration.clone(),
            detector_spacing_xy: None,
            display_spacing_xy: self.manifest.display_spacing_xy,
            patient_plane: None,
            anatomy: Anatomy::Unknown,
            increasing_column: None,
            increasing_row: None,
        };
        measure_on_geometry(
            Object::Projection,
            self.manifest.source.clone(),
            &geometry,
            [self.manifest.format.columns, self.manifest.format.rows],
            request,
            method,
        )
    }
}
