use serde::Serialize;

use crate::{
    Error, Frame, Result, Session,
    dicom::Dataset,
    pixel::{Palette, Samples, palette_rgb},
};

#[derive(Clone, Debug, Serialize)]
pub struct Code {
    pub value: String,
    pub scheme: String,
    pub meaning: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct QuantitativeScale {
    pub quantity: Code,
    pub unit: Code,
    pub stored_range: [i32; 2],
    pub value_range: [f64; 2],
    #[serde(skip)]
    transform: Transform,
}

#[derive(Clone, Debug)]
enum Transform {
    Linear { slope: f64, intercept: f64 },
    Table(Vec<f64>),
}

impl QuantitativeScale {
    pub fn value(&self, stored: i32) -> Option<f64> {
        let [first, last] = self.stored_range;
        if !(first..=last).contains(&stored) {
            return None;
        }
        Some(match &self.transform {
            Transform::Linear { slope, intercept } => f64::from(stored) * slope + intercept,
            Transform::Table(values) => values[(stored - first) as usize],
        })
    }

    pub fn rgb(&self, stored: i32, invert: bool) -> [u8; 3] {
        let Some(value) = self.value(stored) else {
            return [0; 3];
        };
        let [min, max] = self.value_range;
        let f = if max > min {
            (value - min) / (max - min)
        } else {
            0.5
        };
        palette_rgb(if invert { 1.0 - f } else { f }, Palette::Hot)
    }
}

impl Frame {
    pub fn render_quantitative(&self, scale: &QuantitativeScale, invert: bool) -> Result<Vec<u8>> {
        let Samples::Monochrome(samples) = &self.samples else {
            return Err(Error::Unsupported("quantitative color image"));
        };
        let display = self.display.as_ref().ok_or(Error::Internal)?;
        Ok(samples
            .iter()
            .flat_map(|&value| {
                let [r, g, b] = if display.is_padding(value) {
                    [0; 3]
                } else {
                    scale.rgb(value, invert)
                };
                [r, g, b, 255]
            })
            .collect())
    }
}

impl Session {
    pub fn quantitative_scale(&self, frame: usize) -> Option<QuantitativeScale> {
        let format = self.inspection().pixel_format?;
        if !format.photometric.is_monochrome() || frame >= self.inspection().frames {
            return None;
        }
        let file = &self.file;
        let root = &file.dataset;
        let key = (0x40, 0x9096);
        let group = root
            .sequence((0x5200, 0x9230))
            .and_then(|groups| groups.get(frame))
            .filter(|group| group.get(key).is_some())
            .or_else(|| {
                root.one((0x5200, 0x9229))
                    .filter(|group| group.get(key).is_some())
            })
            .unwrap_or(root);
        let item = group.one(key)?;
        let unit = code(file, item.one((0x40, 0x08ea))?)?;
        if unit.scheme != "UCUM" {
            return None;
        }
        let quantity = item.sequence((0x40, 0x9220))?.iter().find_map(|concept| {
            let name = code(file, concept.one((0x40, 0xa043))?)?;
            match (name.scheme.as_str(), name.value.as_str()) {
                ("SCT", "246205007") | ("SRT", "G-C1C6") => {
                    code(file, concept.one((0x40, 0xa168))?)
                }
                _ => None,
            }
        })?;
        let word = |key| {
            item.us(file, (0x40, key)).map(|value| {
                if format.signed {
                    i32::from(value as i16)
                } else {
                    i32::from(value)
                }
            })
        };
        let domain = [word(0x9216)?, word(0x9211)?];
        let [first, last] = domain;
        let [lower, upper] = format.stored_bounds()?;
        if first < lower || last > upper || last < first {
            return None;
        }
        let (transform, [min, max]) = if let Some(bytes) = item.bytes(&file.bytes, (0x40, 0x9212)) {
            if item.get((0x40, 0x9224)).is_some()
                || item.get((0x40, 0x9225)).is_some()
                || bytes.len() != (last - first + 1) as usize * 8
            {
                return None;
            }
            let values: Vec<_> = bytes
                .as_chunks::<8>()
                .0
                .iter()
                .map(|&word| f64::from_bits(file.order.u64(word)))
                .collect();
            if values.iter().any(|value| !value.is_finite()) {
                return None;
            }
            let min = values.iter().copied().fold(f64::INFINITY, f64::min);
            let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            (Transform::Table(values), [min, max])
        } else {
            let slope = item.fd(file, (0x40, 0x9225))?;
            let intercept = item.fd(file, (0x40, 0x9224))?;
            let a = f64::from(first) * slope + intercept;
            let b = f64::from(last) * slope + intercept;
            if slope == 0.0 || !a.is_finite() || !b.is_finite() {
                return None;
            }
            (Transform::Linear { slope, intercept }, [a.min(b), a.max(b)])
        };
        if !(max - min).is_finite() {
            return None;
        }
        Some(QuantitativeScale {
            quantity,
            unit,
            stored_range: domain,
            value_range: [min, max],
            transform,
        })
    }
}

fn code(file: &crate::dicom::File, data: &Dataset) -> Option<Code> {
    let text = |key| {
        data.text(&file.bytes, (8, key))
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    Some(Code {
        value: text(0x100).or_else(|| text(0x119))?.into(),
        scheme: text(0x102)?.into(),
        meaning: text(0x104)?.into(),
    })
}
