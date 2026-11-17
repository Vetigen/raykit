use std::io::Write;

pub const CR: &str = "1.2.840.10008.5.1.4.1.1.1";
pub const DX: &str = "1.2.840.10008.5.1.4.1.1.1.1";
pub const IO: &str = "1.2.840.10008.5.1.4.1.1.1.3";
pub const US: &str = "1.2.840.10008.5.1.4.1.1.6.1";
pub const US_MULTI: &str = "1.2.840.10008.5.1.4.1.1.3.1";
pub const BASELINE: &str = "1.2.840.10008.1.2.4.50";
pub const EXPLICIT_LE: &str = "1.2.840.10008.1.2.1";
pub const EXPLICIT_BE: &str = "1.2.840.10008.1.2.2";
pub const IMPLICIT_LE: &str = "1.2.840.10008.1.2";
pub const DEFLATED: &str = "1.2.840.10008.1.2.1.99";
pub const RLE: &str = "1.2.840.10008.1.2.5";
pub const CT: &str = "1.2.840.10008.5.1.4.1.1.2";
pub const MR: &str = "1.2.840.10008.5.1.4.1.1.4";
pub const ENHANCED_CT: &str = "1.2.840.10008.5.1.4.1.1.2.1";
pub const ENHANCED_MR: &str = "1.2.840.10008.5.1.4.1.1.4.1";
pub const SEG: &str = "1.2.840.10008.5.1.4.1.1.66.4";
pub const GSPS: &str = "1.2.840.10008.5.1.4.1.1.11.1";
pub const STUDY: &str = "2.25.100";
pub const XRAY_UID: &str = "2.25.101";
pub const CINE_UID: &str = "2.25.102";

pub struct Dataset {
    pub bytes: Vec<u8>,
    be: bool,
    explicit: bool,
}

impl Dataset {
    pub fn new(syntax: &str) -> Self {
        Self {
            bytes: Vec::new(),
            be: syntax == EXPLICIT_BE,
            explicit: syntax != IMPLICIT_LE,
        }
    }

    pub fn word(&self, value: u16) -> [u8; 2] {
        if self.be {
            value.to_be_bytes()
        } else {
            value.to_le_bytes()
        }
    }

    pub fn dword(&self, value: u32) -> [u8; 4] {
        if self.be {
            value.to_be_bytes()
        } else {
            value.to_le_bytes()
        }
    }

    pub fn element(&mut self, group: u16, element: u16, vr: &str, data: &[u8]) {
        let len = data.len().next_multiple_of(2);
        self.header(group, element, vr, len as u32);
        self.bytes.extend_from_slice(data);
        if len > data.len() {
            self.bytes.push(if matches!(vr, "UI" | "OB" | "OW") {
                0
            } else {
                b' '
            });
        }
    }

    fn header(&mut self, group: u16, element: u16, vr: &str, len: u32) {
        self.bytes.extend(self.word(group));
        self.bytes.extend(self.word(element));
        if !self.explicit || group == 0xfffe {
            self.bytes.extend(self.dword(len));
        } else {
            self.bytes.extend_from_slice(vr.as_bytes());
            if matches!(vr, "OB" | "OW" | "SQ" | "OV" | "UT" | "UN") {
                self.bytes.extend([0, 0]);
                self.bytes.extend(self.dword(len));
            } else {
                self.bytes
                    .extend(self.word(u16::try_from(len).expect("short VR length")));
            }
        }
    }

    pub fn text(&mut self, group: u16, element: u16, vr: &str, value: &str) {
        self.element(group, element, vr, value.as_bytes());
    }

    pub fn us(&mut self, group: u16, element: u16, value: u16) {
        self.element(group, element, "US", &self.word(value));
    }

    pub fn ul(&mut self, group: u16, element: u16, value: u32) {
        self.element(group, element, "UL", &self.dword(value));
    }

    pub fn at(&mut self, group: u16, element: u16, tag: [u16; 2]) {
        self.element(
            group,
            element,
            "AT",
            &tag.into_iter()
                .flat_map(|n| self.word(n))
                .collect::<Vec<_>>(),
        );
    }

    pub fn sequence(&mut self, group: u16, element: u16, items: &[Dataset]) {
        let mut bytes = Dataset {
            bytes: Vec::new(),
            be: self.be,
            explicit: self.explicit,
        };
        for item in items {
            bytes.element(0xfffe, 0xe000, "OB", &item.bytes);
        }
        self.element(group, element, "SQ", &bytes.bytes);
    }

    pub fn encapsulated(&mut self, frames: &[Vec<Vec<u8>>], offsets: Offsets) {
        let mut basic = Vec::new();
        let mut extended = Vec::new();
        let mut lengths = Vec::new();
        let mut offset = 0_u64;
        for fragments in frames {
            match offsets {
                Offsets::Empty => {}
                Offsets::Basic => basic.extend((offset as u32).to_le_bytes()),
                Offsets::Extended => {
                    assert_eq!(fragments.len(), 1);
                    extended.extend(offset.to_le_bytes());
                    lengths.extend((fragments[0].len() as u64).to_le_bytes());
                }
            }
            offset += fragments
                .iter()
                .map(|f| f.len().next_multiple_of(2) + 8)
                .sum::<usize>() as u64;
        }
        if !extended.is_empty() {
            self.element(0x7fe0, 1, "OV", &extended);
            self.element(0x7fe0, 2, "OV", &lengths);
        }
        self.header(0x7fe0, 0x10, "OB", u32::MAX);
        self.element(0xfffe, 0xe000, "OB", &basic);
        for fragment in frames.iter().flatten() {
            self.element(0xfffe, 0xe000, "OB", fragment);
        }
        self.header(0xfffe, 0xe0dd, "", 0);
    }
}

#[derive(Clone, Copy)]
pub enum Offsets {
    Empty,
    Basic,
    Extended,
}

pub fn part10(class: &str, instance: &str, syntax: &str, data: Vec<u8>) -> Vec<u8> {
    let mut meta = Dataset::new(EXPLICIT_LE);
    meta.element(2, 1, "OB", &[0, 1]);
    meta.text(2, 2, "UI", class);
    meta.text(2, 3, "UI", instance);
    meta.text(2, 0x10, "UI", syntax);
    meta.text(2, 0x12, "UI", "2.25.99");
    let mut prefix = Dataset::new(EXPLICIT_LE);
    prefix.bytes.resize(128, 0);
    prefix.bytes.extend_from_slice(b"DICM");
    prefix.element(2, 0, "UL", &(meta.bytes.len() as u32).to_le_bytes());
    prefix.bytes.extend(meta.bytes);
    if syntax == DEFLATED {
        let mut deflate =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        deflate.write_all(&data).expect("deflate dataset");
        prefix
            .bytes
            .extend(deflate.finish().expect("deflated dataset"));
        if !prefix.bytes.len().is_multiple_of(2) {
            prefix.bytes.push(0);
        }
    } else {
        prefix.bytes.extend(data);
    }
    prefix.bytes
}

pub fn identify(d: &mut Dataset, class: &str, uid: &str, modality: &str) {
    d.text(8, 0x16, "UI", class);
    d.text(8, 0x18, "UI", uid);
    d.text(8, 0x60, "CS", modality);
    d.text(0x20, 0x0d, "UI", STUDY);
    d.text(0x20, 0x0e, "UI", &format!("{uid}.1"));
}

pub fn pixel_module(
    d: &mut Dataset,
    size: [u16; 2],
    bits: [u16; 3],
    frames: usize,
    color: &str,
    signed: bool,
) {
    let mono = color.starts_with("MONOCHROME");
    d.us(0x28, 2, if mono { 1 } else { 3 });
    d.text(0x28, 4, "CS", color);
    if !mono {
        d.us(0x28, 6, 0);
    }
    if frames > 1 {
        d.text(0x28, 8, "IS", &frames.to_string());
    }
    d.us(0x28, 0x10, size[1]);
    d.us(0x28, 0x11, size[0]);
    for (i, v) in bits.into_iter().enumerate() {
        d.us(0x28, 0x100 + i as u16, v);
    }
    d.us(0x28, 0x103, u16::from(signed));
}

pub fn signed_xray(syntax: &str) -> Vec<u8> {
    xray_bits(syntax, 3)
}

pub fn benchmark_xray() -> Vec<u8> {
    xray_bits(EXPLICIT_LE, 0)
}

fn xray_bits(syntax: &str, shift: u16) -> Vec<u8> {
    let mut d = Dataset::new(syntax);
    identify(&mut d, CR, XRAY_UID, "CR");
    d.text(0x10, 0x2210, "CS", "QUADRUPED");
    d.text(0x18, 0x15, "CS", "THORAX");
    d.text(0x18, 0x1164, "DS", "0.4\\0.4");
    pixel_module(
        &mut d,
        [64, 48],
        [16, 12, 11 + shift],
        1,
        "MONOCHROME1",
        true,
    );
    d.text(0x28, 0x30, "DS", "0.25\\0.5");
    d.element(0x28, 0x120, "SS", &d.word((-2048_i16) as u16));
    d.text(0x28, 0xa02, "CS", "FIDUCIAL");
    d.text(0x28, 0x1050, "DS", "-400");
    d.text(0x28, 0x1051, "DS", "6400");
    d.text(0x28, 0x1052, "DS", "-100");
    d.text(0x28, 0x1053, "DS", "2");
    let mut pixels = Vec::new();
    for y in 0..48 {
        for x in 0..64 {
            let stored = if x == 0 && y == 0 {
                -2048
            } else {
                -2000_i16 + x * 40 + y * 6
            };
            let allocated = if shift == 0 {
                stored as u16
            } else {
                ((stored as u16) & 0x0fff) << shift | ((1 << shift) - 1)
            };
            pixels.extend(d.word(allocated));
        }
    }
    d.element(0x7fe0, 0x10, "OW", &pixels);
    part10(CR, XRAY_UID, syntax, d.bytes)
}

pub fn unsigned_rle() -> Vec<u8> {
    let mut d = Dataset::new(RLE);
    identify(&mut d, CR, "2.25.103", "CR");
    pixel_module(&mut d, [2, 2], [16, 16, 15], 1, "MONOCHROME2", false);
    let mut rle = vec![0; 64];
    rle[0] = 2;
    rle[4] = 64;
    rle[8] = 70;
    rle.extend([1, 0, 0, 1, 128, 255, 1, 0, 7, 1, 0, 255]);
    d.encapsulated(&[vec![rle]], Offsets::Basic);
    part10(CR, "2.25.103", RLE, d.bytes)
}

pub fn cine_color(index: usize) -> [u8; 3] {
    [
        32 + (index % 192) as u8,
        64 + ((index * 3) % 128) as u8,
        64 + ((index * 7) % 128) as u8,
    ]
}

pub fn cine(size: [u16; 2], count: usize, offsets: Offsets, split: bool) -> Vec<u8> {
    use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
    let mut d = Dataset::new(BASELINE);
    identify(&mut d, US_MULTI, CINE_UID, "US");
    d.text(0x18, 0x1063, "DS", "28.57142857");
    pixel_module(&mut d, size, [8, 8, 7], count, "YBR_FULL_422", false);
    if count > 1 {
        d.at(0x28, 9, [0x18, 0x1063]);
    }
    let mut frames = Vec::new();
    for i in 0..count {
        let rgb = cine_color(i);
        let color = (0..usize::from(size[0]) * usize::from(size[1]))
            .flat_map(|p| {
                if p % usize::from(size[0]) < usize::from(size[0]) / 2 {
                    rgb
                } else {
                    [rgb[2], rgb[0], rgb[1]]
                }
            })
            .collect::<Vec<_>>();
        let mut bytes = Vec::new();
        let mut encoder = Encoder::new(&mut bytes, 95);
        encoder.set_sampling_factor(SamplingFactor::F_2_1);
        encoder
            .encode(&color, size[0], size[1], ColorType::Rgb)
            .expect("encode synthetic JPEG");
        if split {
            let split_at = (bytes.len() / 4) * 2;
            let tail = bytes.split_off(split_at);
            frames.push(vec![bytes, tail]);
        } else {
            frames.push(vec![bytes]);
        }
    }
    d.encapsulated(&frames, offsets);
    part10(US_MULTI, CINE_UID, BASELINE, d.bytes)
}

#[cfg(feature = "advanced-codecs")]
pub fn codec_fixture(profile: usize) -> (String, Vec<u8>, Vec<i32>, i32) {
    use oxiarc_jpeg::{EncodeOptions, EncodeProcess, InputColor, encode_u16_to_vec_with_options};
    let names = [
        "jpeg-extended-12",
        "jpeg-lossless",
        "jpeg-lossless-sv1",
        "jpeg-ls",
        "jpeg-ls-near",
        "jpeg-2000-lossless",
        "jpeg-2000",
        "htj2k-lossless",
        "htj2k-rpcl",
        "htj2k",
    ];
    let uids = [51, 57, 70, 80, 81, 90, 91, 201, 202, 203];
    let syntax = format!("1.2.840.10008.1.2.4.{}", uids[profile]);
    let instance = format!("2.25.{}", 200 + profile);
    let mut d = Dataset::new(&syntax);
    identify(&mut d, CR, &instance, "CR");
    let signed = matches!(profile, 1 | 2 | 3 | 5 | 7 | 8);
    let bits = if matches!(profile, 5..=9) { 16 } else { 12 };
    pixel_module(
        &mut d,
        [16, 16],
        [16, bits, bits - 1],
        1,
        "MONOCHROME2",
        signed,
    );
    let pixels: Vec<i32> = (0..256)
        .map(|i| match profile {
            0 => {
                if i % 16 < 8 {
                    720
                } else {
                    2760
                }
            }
            6 | 9 => 2048,
            _ if signed => -800 + i * 5,
            _ => 220 + i * 7,
        })
        .collect();
    let encoded_unsigned: Vec<u16> = pixels
        .iter()
        .map(|&v| ((v as u32) & ((1_u32 << bits) - 1)) as u16)
        .collect();
    let (encoded, tolerance) = match profile {
        0..=2 => {
            let process = match profile {
                1 => EncodeProcess::Lossless {
                    predictor: 3,
                    point_transform: 0,
                },
                2 => EncodeProcess::Lossless {
                    predictor: 1,
                    point_transform: 0,
                },
                _ => EncodeProcess::Sequential,
            };
            let settings = EncodeOptions {
                precision: 12,
                quality: 100,
                process,
                ..Default::default()
            };
            (
                encode_u16_to_vec_with_options(
                    &encoded_unsigned,
                    16,
                    16,
                    InputColor::Luma,
                    &settings,
                )
                .unwrap(),
                if profile == 0 { 2 } else { 0 },
            )
        }
        3..=4 => {
            let mut settings = jpegls::EncodeOptions::default();
            settings.precision = Some(12);
            settings.near = if profile == 4 { 2 } else { 0 };
            let mut output = Vec::new();
            jpegls::encode_with_options(&encoded_unsigned, 16, 16, &settings, &mut output).unwrap();
            (output, i32::from(settings.near))
        }
        5..=6 => {
            let plane =
                openjp2::ImageComponent::new(16, 16, bits as u8, signed, pixels.clone()).unwrap();
            let image =
                openjp2::Image::new(16, 16, openjp2::ColorSpace::Greyscale, vec![plane]).unwrap();
            let settings = openjp2::EncodeOptions {
                num_resolutions: Some(2),
                irreversible: profile == 6,
                ..Default::default()
            };
            (
                openjp2::Encoder::encode(&image, &settings).unwrap(),
                if profile == 6 { 4 } else { 0 },
            )
        }
        7..=9 => {
            use openjph_core::{
                codestream::Codestream,
                file::MemOutfile,
                types::{Point, Size},
            };
            let mut stream = Codestream::new();
            stream.access_siz_mut().set_image_extent(Point::new(16, 16));
            stream.access_siz_mut().set_num_components(1);
            stream
                .access_siz_mut()
                .set_comp_info(0, Point::new(1, 1), u32::from(bits), signed);
            stream.access_siz_mut().set_tile_size(Size::new(16, 16));
            stream.access_cod_mut().set_num_decomposition(1);
            stream.access_cod_mut().set_reversible(profile != 9);
            stream.access_cod_mut().set_color_transform(false);
            stream
                .access_cod_mut()
                .set_progression_order(if profile == 8 { "RPCL" } else { "LRCP" })
                .unwrap();
            stream.set_planar(0);
            let mut file = MemOutfile::new();
            stream.write_headers(&mut file, &[]).unwrap();
            for row in pixels.as_chunks::<16>().0 {
                stream.exchange(row, 0).unwrap();
            }
            stream.flush(&mut file).unwrap();
            (file.get_data().to_vec(), if profile == 9 { 4 } else { 0 })
        }
        _ => unreachable!(),
    };
    d.encapsulated(&[vec![encoded]], Offsets::Empty);
    (
        names[profile].to_owned(),
        part10(CR, &instance, &syntax, d.bytes),
        pixels,
        tolerance,
    )
}

const PHANTOM_SIZE: [u16; 2] = [8, 6];
const PHANTOM_AXES: &str = "0.8\\0.6\\0\\-0.48\\0.64\\0.6";
const PHANTOM_SERIES: &str = "2.25.901";
const PHANTOM_SPACE: &str = "2.25.999";

pub fn phantom_point(x: f64, y: f64, z: f64) -> [f64; 3] {
    [
        -10.0 + 0.8 * 0.7 * x - 0.48 * 1.5 * y + 0.9 * z,
        6.0 + 0.6 * 0.7 * x + 0.64 * 1.5 * y - 1.2 * z,
        12.0 + 0.6 * 1.5 * y + 2.0 * z,
    ]
}

fn position(slice: f64) -> String {
    let [x, y, z] = phantom_point(0.0, 0.0, slice);
    format!("{x:.4}\\{y:.4}\\{z:.4}")
}

fn pixels_for_slice(z: u16) -> Vec<u8> {
    let [cols, rows] = PHANTOM_SIZE;
    (0..rows)
        .flat_map(|y| (0..cols).flat_map(move |x| (10 * x + 3 * y + 100 * z).to_le_bytes()))
        .collect()
}

fn physical_metadata(d: &mut Dataset) {
    d.text(0x28, 0x30, "DS", "1.5\\0.7");
    d.text(0x18, 0x50, "DS", "2.5");
    d.text(0x18, 0x88, "DS", "2.5");
}

pub fn classic_slice(z: u16, at: f64, localizer: bool) -> Vec<u8> {
    classic_frame(z, at, localizer, CT, "CT", 911)
}

pub fn classic_mr_slice(z: u16) -> Vec<u8> {
    classic_frame(z, f64::from(z), false, MR, "MR", 961)
}

fn classic_frame(
    z: u16,
    at: f64,
    localizer: bool,
    class: &str,
    modality: &str,
    first_instance: u16,
) -> Vec<u8> {
    let instance = format!("2.25.{}", first_instance + z);
    let mut d = Dataset::new(EXPLICIT_LE);
    d.text(
        8,
        8,
        "CS",
        if localizer {
            "ORIGINAL\\PRIMARY\\LOCALIZER"
        } else {
            "ORIGINAL\\PRIMARY\\AXIAL"
        },
    );
    d.text(8, 0x16, "UI", class);
    d.text(8, 0x18, "UI", &instance);
    d.text(8, 0x60, "CS", modality);
    d.text(0x10, 0x2210, "CS", "QUADRUPED");
    d.text(0x18, 0x15, "CS", "THORAX");
    d.text(0x20, 0x0d, "UI", STUDY);
    d.text(0x20, 0x0e, "UI", PHANTOM_SERIES);
    d.text(0x20, 0x32, "DS", &position(at));
    d.text(0x20, 0x37, "DS", PHANTOM_AXES);
    d.text(0x20, 0x52, "UI", PHANTOM_SPACE);
    pixel_module(&mut d, PHANTOM_SIZE, [16, 16, 15], 1, "MONOCHROME2", false);
    physical_metadata(&mut d);
    d.element(0x7fe0, 0x10, "OW", &pixels_for_slice(z));
    part10(class, &instance, EXPLICIT_LE, d.bytes)
}

pub fn enhanced_volume(mr: bool) -> Vec<u8> {
    let (class, uid, modality) = if mr {
        (ENHANCED_MR, "2.25.951", "MR")
    } else {
        (ENHANCED_CT, "2.25.950", "CT")
    };
    let mut d = Dataset::new(EXPLICIT_LE);
    identify(&mut d, class, uid, modality);
    d.text(0x10, 0x2210, "CS", "QUADRUPED");
    d.text(0x18, 0x15, "CS", "SKULL");
    d.text(0x20, 0x52, "UI", PHANTOM_SPACE);
    let dimensions = [0x9057_u16, 0x9128_u16].map(|element| {
        let mut pointer = Dataset::new(EXPLICIT_LE);
        let at: Vec<_> = [0x20_u16, element]
            .into_iter()
            .flat_map(u16::to_le_bytes)
            .collect();
        pointer.element(0x20, 0x9165, "AT", &at);
        pointer
    });
    d.sequence(0x20, 0x9222, &dimensions);
    let frames = [(2, 1), (0, 2), (1, 1), (2, 2), (0, 1), (1, 2)];
    pixel_module(
        &mut d,
        PHANTOM_SIZE,
        [16, 16, 15],
        frames.len(),
        "MONOCHROME2",
        false,
    );
    let mut shared = Dataset::new(EXPLICIT_LE);
    let mut orientation = Dataset::new(EXPLICIT_LE);
    orientation.text(0x20, 0x37, "DS", PHANTOM_AXES);
    shared.sequence(0x20, 0x9116, &[orientation]);
    let mut metrics = Dataset::new(EXPLICIT_LE);
    physical_metadata(&mut metrics);
    shared.sequence(0x28, 0x9110, &[metrics]);
    d.sequence(0x5200, 0x9229, &[shared]);
    let mut data = Vec::new();
    let per_frame = frames.map(|(z, temporal)| {
        let mut frame = Dataset::new(EXPLICIT_LE);
        let mut location = Dataset::new(EXPLICIT_LE);
        location.text(0x20, 0x32, "DS", &position(f64::from(z)));
        frame.sequence(0x20, 0x9113, &[location]);
        let mut content = Dataset::new(EXPLICIT_LE);
        content.text(0x20, 0x9056, "SH", "A");
        content.ul(0x20, 0x9057, u32::from(z) + 1);
        content.ul(0x20, 0x9128, temporal);
        let indices = [u32::from(z) + 1, temporal]
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect::<Vec<_>>();
        content.element(0x20, 0x9157, "UL", &indices);
        frame.sequence(0x20, 0x9111, &[content]);
        let mut transformation = Dataset::new(EXPLICIT_LE);
        transformation.text(0x28, 0x1053, "DS", "1");
        transformation.text(0x28, 0x1052, "DS", if temporal == 1 { "0" } else { "1000" });
        frame.sequence(0x28, 0x9145, &[transformation]);
        data.extend(pixels_for_slice(z));
        frame
    });
    d.sequence(0x5200, 0x9230, &per_frame);
    d.element(0x7fe0, 0x10, "OW", &data);
    part10(class, uid, EXPLICIT_LE, d.bytes)
}

pub fn segmentation() -> Vec<u8> {
    let mut data = Dataset::new(EXPLICIT_LE);
    identify(&mut data, SEG, "2.25.970", "SEG");
    data.text(0x20, 0x52, "UI", PHANTOM_SPACE);
    pixel_module(&mut data, PHANTOM_SIZE, [1, 1, 0], 2, "MONOCHROME2", false);
    data.text(0x62, 1, "CS", "BINARY");
    let mut segment = Dataset::new(EXPLICIT_LE);
    segment.us(0x62, 4, 1);
    segment.text(0x62, 5, "LO", "Synthetic marker");
    segment.text(0x62, 8, "CS", "MANUAL");
    data.sequence(0x62, 2, &[segment]);
    let frames = [0_u8, 2_u8].map(|z| {
        let mut frame = Dataset::new(EXPLICIT_LE);
        let mut metrics = Dataset::new(EXPLICIT_LE);
        physical_metadata(&mut metrics);
        frame.sequence(0x28, 0x9110, &[metrics]);
        let mut orientation = Dataset::new(EXPLICIT_LE);
        orientation.text(0x20, 0x37, "DS", PHANTOM_AXES);
        frame.sequence(0x20, 0x9116, &[orientation]);
        let mut location = Dataset::new(EXPLICIT_LE);
        location.text(0x20, 0x32, "DS", &position(f64::from(z)));
        frame.sequence(0x20, 0x9113, &[location]);
        let mut reference = Dataset::new(EXPLICIT_LE);
        reference.text(8, 0x1150, "UI", ENHANCED_CT);
        reference.text(8, 0x1155, "UI", "2.25.950");
        reference.text(8, 0x1160, "IS", if z == 0 { "5" } else { "1" });
        reference.text(0x28, 0x135a, "CS", "YES");
        let mut derivation = Dataset::new(EXPLICIT_LE);
        derivation.sequence(8, 0x2112, &[reference]);
        frame.sequence(8, 0x9124, &[derivation]);
        let mut seg = Dataset::new(EXPLICIT_LE);
        seg.us(0x62, 0xb, 1);
        frame.sequence(0x62, 0xa, &[seg]);
        frame
    });
    data.sequence(0x5200, 0x9230, &frames);
    let mut packed = [0_u8; 12];
    packed[2] = 1 << 3;
    packed[8] = 1 << 4;
    data.element(0x7fe0, 0x10, "OB", &packed);
    part10(SEG, "2.25.970", EXPLICIT_LE, data.bytes)
}

pub fn presentation() -> Vec<u8> {
    let mut data = Dataset::new(EXPLICIT_LE);
    identify(&mut data, GSPS, "2.25.971", "PR");
    let mut series = Dataset::new(EXPLICIT_LE);
    series.text(0x20, 0x0e, "UI", "2.25.950.1");
    let mut image = Dataset::new(EXPLICIT_LE);
    image.text(8, 0x1150, "UI", ENHANCED_CT);
    image.text(8, 0x1155, "UI", "2.25.950");
    image.text(8, 0x1160, "IS", "1");
    series.sequence(8, 0x1140, &[image]);
    data.sequence(8, 0x1115, &[series]);
    let mut voi = Dataset::new(EXPLICIT_LE);
    voi.text(0x28, 0x1050, "DS", "250");
    voi.text(0x28, 0x1051, "DS", "100");
    data.sequence(0x28, 0x3110, &[voi]);
    let mut area = Dataset::new(EXPLICIT_LE);
    area.element(
        0x70,
        0x52,
        "SL",
        &[1_i32, 1]
            .into_iter()
            .flat_map(i32::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    area.element(
        0x70,
        0x53,
        "SL",
        &[8_i32, 6]
            .into_iter()
            .flat_map(i32::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    area.text(0x70, 0x100, "CS", "SCALE TO FIT");
    data.sequence(0x70, 0x5a, &[area]);
    data.text(0x70, 0x41, "CS", "N");
    data.us(0x70, 0x42, 90);
    data.text(0x2050, 0x20, "CS", "INVERSE");
    part10(GSPS, "2.25.971", EXPLICIT_LE, data.bytes)
}

pub fn measured_sr() -> Vec<u8> {
    use raykit_core::{
        Limits, Session,
        geometry::PixelPoint,
        interop::SrOptions,
        measurement::{Length, Request},
    };
    let mut source = Session::open(signed_xray(EXPLICIT_LE), Limits::default()).unwrap();
    let measurement = source
        .measure(
            0,
            Request {
                id: "synthetic-ruler".to_owned(),
                method: "raykit:length".to_owned(),
                version: 1,
                points: vec![
                    PixelPoint { x: 3.0, y: 5.0 },
                    PixelPoint { x: 9.0, y: 21.0 },
                ],
                parameters: serde_json::Value::Null,
            },
            &Length,
        )
        .unwrap();
    let options = SrOptions {
        instance_uid: "2.25.975".to_owned(),
        series_uid: "2.25.976".to_owned(),
        tracking_uid: "2.25.977".to_owned(),
        observer_name: "SYNTHETIC^OBSERVER".to_owned(),
        content_date: "20260101".to_owned(),
        content_time: "120000".to_owned(),
    };
    source.export_distance_sr(measurement, &options).unwrap()
}

pub fn native_us(color: bool, spatial: bool) -> Vec<u8> {
    let instance = if color {
        "2.25.840"
    } else if spatial {
        "2.25.841"
    } else {
        "2.25.842"
    };
    let mut data = Dataset::new(EXPLICIT_LE);
    identify(&mut data, US, instance, "US");
    if color {
        data.us(0x28, 2, 3);
        data.text(0x28, 4, "CS", "RGB");
        data.us(0x28, 6, 1);
        data.us(0x28, 0x10, 6);
        data.us(0x28, 0x11, 8);
        data.us(0x28, 0x100, 8);
        data.us(0x28, 0x101, 8);
        data.us(0x28, 0x102, 7);
        data.us(0x28, 0x103, 0);
    } else {
        pixel_module(&mut data, [8, 6], [8, 8, 7], 1, "MONOCHROME2", false);
    }
    let mut region = Dataset::new(EXPLICIT_LE);
    region.us(0x18, 0x6012, if spatial { 1 } else { 2 });
    region.ul(0x18, 0x6018, 0);
    region.ul(0x18, 0x601a, 0);
    region.ul(0x18, 0x601c, 7);
    region.ul(0x18, 0x601e, 5);
    region.us(0x18, 0x6024, if spatial { 3 } else { 4 });
    region.us(0x18, 0x6026, 3);
    region.element(0x18, 0x602c, "FD", &0.1_f64.to_le_bytes());
    region.element(0x18, 0x602e, "FD", &(-0.2_f64).to_le_bytes());
    data.sequence(0x18, 0x6011, &[region]);
    let pixels = if color {
        [vec![12; 48], vec![34; 48], vec![56; 48]].concat()
    } else {
        (0..48).collect()
    };
    data.element(0x7fe0, 0x10, "OB", &pixels);
    part10(US, instance, EXPLICIT_LE, data.bytes)
}

pub fn lut_projection(class: &str, instance: &str, modality: &str) -> Vec<u8> {
    let mut data = Dataset::new(EXPLICIT_LE);
    identify(&mut data, class, instance, modality);
    pixel_module(&mut data, [2, 2], [8, 8, 7], 1, "MONOCHROME1", false);
    let table = |values: &[u16]| {
        let mut item = Dataset::new(EXPLICIT_LE);
        let descriptor = [values.len() as u16, 0, 8]
            .into_iter()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        item.element(0x28, 0x3002, "US", &descriptor);
        item.element(
            0x28,
            0x3006,
            "OW",
            &values
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        );
        item
    };
    data.sequence(0x28, 0x3000, &[table(&[0, 4, 8, 12])]);
    data.sequence(
        0x28,
        0x3010,
        &[table(&(0..16).map(|n| n * 16).collect::<Vec<_>>())],
    );
    data.text(0x2050, 0x20, "CS", "IDENTITY");
    data.element(0x7fe0, 0x10, "OB", &[0, 1, 2, 3]);
    part10(class, instance, EXPLICIT_LE, data.bytes)
}

pub fn encapsulated_pdf() -> Vec<u8> {
    let class = "1.2.840.10008.5.1.4.1.1.104.1";
    let mut data = Dataset::new(EXPLICIT_LE);
    identify(&mut data, class, "2.25.844", "DOC");
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>",
    ];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n{object}\nendobj\n", index + 1).into_bytes());
    }
    let start = pdf.len();
    pdf.extend(b"xref\n0 4\n0000000000 65535 f \n");
    for offset in offsets {
        pdf.extend(format!("{offset:010} 00000 n \n").into_bytes());
    }
    pdf.extend(
        format!("trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n").into_bytes(),
    );
    data.element(0x42, 0x11, "OB", &pdf);
    data.text(0x42, 0x12, "LO", "application/pdf");
    data.ul(0x42, 0x15, pdf.len() as u32);
    part10(class, "2.25.844", EXPLICIT_LE, data.bytes)
}
