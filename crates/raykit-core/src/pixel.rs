use dicom_core::VR;
use serde::{Deserialize, Serialize};

use crate::{
    Error, Result,
    dicom::{Dataset, File},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Photometric {
    Monochrome1,
    Monochrome2,
    Rgb,
    YbrFull,
    YbrFull422,
}

impl Photometric {
    pub fn is_monochrome(self) -> bool {
        matches!(self, Self::Monochrome1 | Self::Monochrome2)
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct PixelFormat {
    pub rows: u32,
    pub columns: u32,
    pub bits_allocated: u8,
    pub bits_stored: u8,
    pub high_bit: u8,
    pub signed: bool,
    pub photometric: Photometric,
    pub planar: bool,
}

impl PixelFormat {
    pub fn pixels(self) -> usize {
        self.rows as usize * self.columns as usize
    }

    pub fn components(self) -> usize {
        if self.photometric.is_monochrome() {
            1
        } else {
            3
        }
    }

    pub(crate) fn stored(self, value: u16, aligned: bool) -> i32 {
        let bits = i32::from(self.bits_stored);
        let shift = if aligned {
            0
        } else {
            self.high_bit + 1 - self.bits_stored
        };
        let value = (i32::from(value) >> shift) & ((1 << bits) - 1);
        if self.signed && value & (1 << (bits - 1)) != 0 {
            value - (1 << bits)
        } else {
            value
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorSpace {
    Rgb,
    YbrFull,
}

#[derive(Debug, PartialEq)]
pub enum Samples {
    Monochrome(Vec<i32>),
    Color { space: ColorSpace, values: Vec<u8> },
}

impl Samples {
    pub(crate) fn bytes(&self) -> usize {
        match self {
            Self::Monochrome(values) => values.capacity() * size_of::<i32>(),
            Self::Color { values, .. } => values.capacity(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Lut {
    first: i32,
    bits: u8,
    values: Vec<u16>,
}

impl Lut {
    fn at(&self, value: f64) -> f64 {
        let index = (value - f64::from(self.first)).floor().max(0.0) as usize;
        f64::from(self.values[index.min(self.values.len() - 1)])
    }

    fn maximum(&self) -> f64 {
        f64::from((1_u32 << self.bits) - 1)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Modality {
    Linear { slope: f64, intercept: f64 },
    Lut { table: Lut },
}

impl Modality {
    pub fn at(&self, stored: i32) -> f64 {
        match self {
            Self::Linear { slope, intercept } => f64::from(stored) * slope + intercept,
            Self::Lut { table } => table.at(f64::from(stored)),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowFunction {
    #[default]
    Linear,
    LinearExact,
    Sigmoid,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Window {
    pub center: f64,
    pub width: f64,
    #[serde(default)]
    pub function: WindowFunction,
}

impl Window {
    pub fn validate(self) -> Result<Self> {
        if !self.center.is_finite()
            || !self.width.is_finite()
            || self.width <= 0.0
            || (self.function == WindowFunction::Linear && self.width < 1.0)
        {
            return Err(Error::InvalidRequest("window center and width"));
        }
        Ok(self)
    }

    pub fn at(self, value: f64) -> f64 {
        match self.function {
            WindowFunction::Linear if self.width == 1.0 => f64::from(value > self.center - 0.5),
            WindowFunction::Linear => {
                ((value - (self.center - 0.5)) / (self.width - 1.0) + 0.5).clamp(0.0, 1.0)
            }
            WindowFunction::LinearExact => {
                ((value - self.center) / self.width + 0.5).clamp(0.0, 1.0)
            }
            WindowFunction::Sigmoid => {
                1.0 / (1.0 + (-4.0 * (value - self.center) / self.width).exp())
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Voi {
    Window { window: Window },
    Lut { table: Lut },
}

impl Voi {
    fn at(&self, value: f64) -> f64 {
        match self {
            Self::Window { window } => window.at(value),
            Self::Lut { table } => table.at(value) / table.maximum(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Palette {
    #[default]
    Gray,
    Hot,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct RenderOptions {
    pub window: Option<Window>,
    pub invert: bool,
    pub palette: Palette,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Display {
    pub modality: Modality,
    pub voi: Voi,
    pub automatic_window: Window,
    pub inverse: bool,
    pub padding: Option<[i32; 2]>,
}

impl Display {
    pub fn is_padding(&self, pixel: i32) -> bool {
        self.padding
            .is_some_and(|[low, high]| (low..=high).contains(&pixel))
    }

    pub fn luminance(&self, sample: i32, options: RenderOptions) -> f64 {
        if self.is_padding(sample) {
            return 0.0;
        }
        let value = self.modality.at(sample);
        let intensity = match options.window {
            Some(window) => window.at(value),
            None => self.voi.at(value),
        };
        if self.inverse ^ options.invert {
            1.0 - intensity
        } else {
            intensity
        }
    }

    pub fn rgb(&self, sample: i32, options: RenderOptions) -> [u8; 3] {
        let v = self.luminance(sample, options);
        match options.palette {
            Palette::Gray => [quantize(v); 3],
            Palette::Hot => [
                quantize(v * 3.0),
                quantize(v * 3.0 - 1.0),
                quantize(v * 3.0 - 2.0),
            ],
        }
    }
}

fn quantize(value: f64) -> u8 {
    (255.0 * value.clamp(0.0, 1.0)).round() as u8
}

pub fn color_rgb(space: ColorSpace, [a, b, c]: [u8; 3]) -> [u8; 3] {
    match space {
        ColorSpace::Rgb => [a, b, c],
        ColorSpace::YbrFull => {
            let y = f64::from(a);
            let cb = f64::from(b) - 128.0;
            let cr = f64::from(c) - 128.0;
            [
                y + 1.402 * cr,
                y - 0.344_136 * cb - 0.714_136 * cr,
                y + 1.772 * cb,
            ]
            .map(|v| v.clamp(0.0, 255.0).round() as u8)
        }
    }
}

fn read_lut(file: &File, item: &Dataset, signed: bool) -> Result<Lut> {
    let key = (0x28, 0x3002);
    let descriptor = item
        .bytes(&file.bytes, key)
        .filter(|bytes| bytes.len() == 6)
        .ok_or(Error::InvalidDicom("LUT descriptor"))?;
    let word = |b: &[u8]| file.order.u16(b.try_into().expect("LUT word"));
    let size = match word(&descriptor[..2]) {
        0 => 65536,
        n => usize::from(n),
    };
    let first = word(&descriptor[2..4]);
    let first = match item.get(key).and_then(|e| e.vr) {
        Some(VR::SS) => i32::from(first as i16),
        None if signed => i32::from(first as i16),
        _ => i32::from(first),
    };
    let bits = word(&descriptor[4..]);
    if !(8..=16).contains(&bits) {
        return Err(Error::Unsupported("LUT bit depth"));
    }
    let encoded = item
        .bytes(&file.bytes, (0x28, 0x3006))
        .ok_or(Error::InvalidDicom("LUT data"))?;
    let values: Vec<u16> = if encoded.len() == size * 2 {
        encoded
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&entry| file.order.u16(entry))
            .collect()
    } else if bits == 8 && encoded.len() == size.next_multiple_of(2) {
        encoded[..size].iter().copied().map(u16::from).collect()
    } else {
        return Err(Error::InvalidDicom("LUT entry count"));
    };
    if values.iter().any(|&v| u32::from(v) >= 1_u32 << bits) {
        return Err(Error::InvalidDicom("LUT entry out of range"));
    }
    Ok(Lut {
        first,
        bits: bits as u8,
        values,
    })
}

pub(crate) fn display(
    file: &File,
    format: PixelFormat,
    transform: &Dataset,
    voi: &Dataset,
    samples: &[i32],
) -> Result<Display> {
    let root = &file.dataset;
    let signed = format.signed;
    let padding_value = |key| {
        root.us(file, key).map(|v| {
            if signed {
                i32::from(v as i16)
            } else {
                i32::from(v)
            }
        })
    };
    let padding = padding_value((0x28, 0x0120)).map(|first| {
        let second = padding_value((0x28, 0x0121)).unwrap_or(first);
        [first.min(second), first.max(second)]
    });
    let modality = if let Some(items) = transform.sequence((0x28, 0x3000)) {
        let [item] = items else {
            return Err(Error::InvalidDicom("modality LUT count"));
        };
        Modality::Lut {
            table: read_lut(file, item, signed)?,
        }
    } else {
        let slope = (0x28, 0x1053);
        let intercept = (0x28, 0x1052);
        let (slope, intercept) = match (transform.get(slope), transform.get(intercept)) {
            (None, None) if std::ptr::eq(root, transform) => (1.0, 0.0),
            (Some(_), Some(_)) => {
                let [slope] = transform
                    .ds(file, slope)
                    .filter(|[s]| *s != 0.0)
                    .ok_or(Error::InvalidDicom("rescale slope"))?;
                let [intercept] = transform
                    .ds(file, intercept)
                    .ok_or(Error::InvalidDicom("rescale intercept"))?;
                (slope, intercept)
            }
            _ => return Err(Error::InvalidDicom("incomplete rescale")),
        };
        if (slope.abs() * 65535.0 + intercept.abs()) > f64::from(f32::MAX) / 8.0 {
            return Err(Error::Unsupported("modality value range"));
        }
        Modality::Linear { slope, intercept }
    };
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    for &sample in samples {
        if padding.is_some_and(|[a, b]| (a..=b).contains(&sample)) {
            continue;
        }
        let v = modality.at(sample);
        min = min.min(v);
        max = max.max(v);
    }
    if min > max {
        (min, max) = (0.0, 1.0);
    }
    let automatic_window = Window {
        center: (min + max + 1.0) / 2.0,
        width: max - min + 1.0,
        function: WindowFunction::Linear,
    };
    let voi = match (voi.get((0x28, 0x1050)), voi.get((0x28, 0x1051))) {
        (Some(_), Some(_)) => {
            let center = voi
                .first_ds(file, (0x28, 0x1050))
                .ok_or(Error::InvalidDicom("window center"))?;
            let width = voi
                .first_ds(file, (0x28, 0x1051))
                .ok_or(Error::InvalidDicom("window width"))?;
            let function = match voi.text(&file.bytes, (0x28, 0x1056)) {
                None | Some("" | "LINEAR") => WindowFunction::Linear,
                Some("LINEAR_EXACT") => WindowFunction::LinearExact,
                Some("SIGMOID") => WindowFunction::Sigmoid,
                _ => return Err(Error::Unsupported("VOI window function")),
            };
            Voi::Window {
                window: Window {
                    center,
                    width,
                    function,
                }
                .validate()?,
            }
        }
        (None, None) => match voi.sequence((0x28, 0x3010)).and_then(|items| items.first()) {
            Some(item) => Voi::Lut {
                table: read_lut(file, item, signed)?,
            },
            None => Voi::Window {
                window: automatic_window,
            },
        },
        _ => return Err(Error::InvalidDicom("incomplete default window")),
    };
    if root.get((0x2050, 0x0010)).is_some() {
        return Err(Error::Unsupported("Presentation LUT sequence"));
    }
    let inverse = match root.text(&file.bytes, (0x2050, 0x0020)) {
        Some("IDENTITY") => false,
        Some("INVERSE") => true,
        Some(_) => return Err(Error::Unsupported("Presentation LUT shape")),
        None => format.photometric == Photometric::Monochrome1,
    };
    Ok(Display {
        modality,
        voi,
        automatic_window,
        inverse,
        padding,
    })
}
