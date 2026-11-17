use serde::Serialize;

use crate::{Object, Session};

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Axis {
    pub origin_pixel: f64,
    pub origin_value: f64,
    pub delta: f64,
    pub unit: &'static str,
}

impl Axis {
    pub fn at(self, pixel: u32) -> f64 {
        self.origin_value + (f64::from(pixel) - self.origin_pixel) * self.delta
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct DopplerScale {
    pub bounds: [u32; 4],
    pub time: Axis,
    pub spectral: Axis,
}

#[derive(Serialize)]
pub struct DopplerPoint {
    pub time: f64,
    pub time_unit: &'static str,
    pub spectral: f64,
    pub spectral_unit: &'static str,
}

impl Session {
    /// The declared spectral axes describe coordinates in the trace raster.
    pub fn doppler_scales(&self, frame: usize) -> Vec<DopplerScale> {
        let info = self.inspection();
        if info.object != Object::Ultrasound || frame >= info.frames {
            return Vec::new();
        }
        let Some(format) = info.pixel_format else {
            return Vec::new();
        };
        let file = &self.file;
        file.dataset
            .sequence((0x18, 0x6011))
            .unwrap_or_default()
            .iter()
            .filter_map(|region| {
                let code = |key| region.us(file, (0x18, key));
                if code(0x6012)? != 3 || !matches!(code(0x6014)?, 3 | 4) || code(0x6024)? != 4 {
                    return None;
                }
                let unit = match code(0x6026)? {
                    5 => "Hz",
                    7 => "cm/s",
                    _ => return None,
                };
                let coordinate = |key| region.ul(file, (0x18, key));
                let [x0, y0, x1, y1] = [
                    coordinate(0x6018)?,
                    coordinate(0x601a)?,
                    coordinate(0x601c)?,
                    coordinate(0x601e)?,
                ];
                if x1 < x0 || y1 < y0 || x1 >= format.columns || y1 >= format.rows {
                    return None;
                }
                let axis = |key, first, unit| {
                    let origin = f64::from(coordinate(key)? as i32) + f64::from(first);
                    let origin_value = region.fd(file, (0x18, key + 8))?;
                    let delta = region.fd(file, (0x18, key + 12))?;
                    if delta == 0.0 || !(delta.abs() * 5e9 + origin_value.abs()).is_finite() {
                        return None;
                    }
                    Some(Axis {
                        origin_pixel: origin,
                        origin_value,
                        delta,
                        unit,
                    })
                };
                Some(DopplerScale {
                    bounds: [x0, y0, x1, y1],
                    time: axis(0x6020, x0, "s")?,
                    spectral: axis(0x6022, y0, unit)?,
                })
            })
            .collect()
    }

    pub fn doppler_point(&self, frame: usize, x: u32, y: u32) -> Option<DopplerPoint> {
        let scales = self.doppler_scales(frame);
        let mut matching = scales.iter().filter(|scale| {
            let [x0, y0, x1, y1] = scale.bounds;
            (x0..=x1).contains(&x) && (y0..=y1).contains(&y)
        });
        let scale = matching.next()?;
        if matching.next().is_some() {
            return None;
        }
        Some(DopplerPoint {
            time: scale.time.at(x),
            time_unit: scale.time.unit,
            spectral: scale.spectral.at(y),
            spectral_unit: scale.spectral.unit,
        })
    }
}
