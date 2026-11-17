use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    Error, Object, Result, Session, TransferSyntax,
    dicom::{Dataset, File, Key, PIXEL_DATA, uid},
    geometry::{PatientPlane, PixelPoint},
    measurement::{Length, Record, Request, SourceReference, Unit},
    pixel::{Modality, Window, WindowFunction},
    source::groups,
};

const SR: &str = "1.2.840.10008.5.1.4.1.1.88.33";
const EXPLICIT_LE: &str = "1.2.840.10008.1.2.1";
const CONTENT: Key = (0x0040, 0xa730);
const REF_SOP: Key = (0x0008, 0x1199);
const REF_IMAGE: Key = (0x0008, 0x1140);
const REF_SERIES: Key = (0x0008, 0x1115);
const CONCEPT: Key = (0x0040, 0xa043);
const GRAPHIC: Key = (0x0070, 0x0022);
const TYPE: Key = (0x0040, 0xa040);
const RELATION: Key = (0x0040, 0xa010);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SrOptions {
    pub instance_uid: String,
    pub series_uid: String,
    pub tracking_uid: String,
    pub observer_name: String,
    pub content_date: String,
    pub content_time: String,
}

#[derive(Serialize)]
pub struct SegmentationOverlay {
    pub source: SourceReference,
    pub segment: u16,
    pub dimensions: [u32; 2],
    #[serde(skip)]
    pub mask: Vec<u8>,
}

#[derive(Serialize)]
pub struct Presentation {
    pub source: SourceReference,
    pub quarter_turns: u8,
    pub inverse: bool,
    pub window: Option<Window>,
}

impl Session {
    pub fn export_distance_sr(&mut self, record: Record, options: &SrOptions) -> Result<Vec<u8>> {
        if record.input.method != "raykit:length" || record.input.version != 1 {
            return Err(Error::Unsupported("SR supports calibrated distances"));
        }
        let record = self.reopen_measurement(record, &Length)?;
        let distance = record.values[0].value;
        if record.values[0].unit != Unit::Millimeter || distance <= 0.0 {
            return Err(Error::Unsupported(
                "SR requires a nonzero calibrated distance",
            ));
        }
        let metadata = self.inspection();
        let study = metadata
            .study_uid
            .as_deref()
            .ok_or(Error::InvalidDicom("source Study Instance UID"))?;
        let series = metadata
            .series_uid
            .as_deref()
            .ok_or(Error::InvalidDicom("source Series Instance UID"))?;
        for value in [
            &options.instance_uid,
            &options.series_uid,
            &options.tracking_uid,
        ] {
            uid(Some(value))?;
        }
        if options.instance_uid == record.source.instance_uid || options.series_uid == series {
            return Err(Error::InvalidRequest(
                "SR requires new instance and series identifiers",
            ));
        }
        if options.content_date.len() != 8
            || options.content_time.len() != 6
            || !options
                .content_date
                .bytes()
                .chain(options.content_time.bytes())
                .all(|b| b.is_ascii_digit())
            || options.observer_name.is_empty()
            || options.observer_name.len() > 64
            || !options
                .observer_name
                .bytes()
                .all(|b| (32..=126).contains(&b) && b != b'\\')
        {
            return Err(Error::InvalidRequest(
                "SR content date, time or observer name",
            ));
        }

        let mut root = item(
            None,
            "CONTAINER",
            Some(("126000", "DCM", "Imaging Measurement Report")),
        );
        root.text((0x08, 0x16), "UI", SR);
        root.text((0x08, 0x18), "UI", &options.instance_uid);
        root.text((0x08, 0x23), "DA", &options.content_date);
        root.text((0x08, 0x33), "TM", &options.content_time);
        root.text((0x08, 0x60), "CS", "SR");
        root.text((0x08, 0x70), "LO", "RayKit");
        root.text((0x20, 0x0d), "UI", study);
        root.text((0x20, 0x0e), "UI", &options.series_uid);
        root.text((0x20, 0x11), "IS", "1");
        root.text((0x20, 0x13), "IS", "1");
        root.text((0x40, 0xa491), "CS", "COMPLETE");
        root.text((0x40, 0xa493), "CS", "UNVERIFIED");
        root.text((0x40, 0xa496), "CS", "FINAL");
        root.sequence((0x40, 0xa372), Vec::new());
        for (key, vr) in [
            ((8, 0x20), "DA"),
            ((8, 0x30), "TM"),
            ((8, 0x50), "SH"),
            ((8, 0x90), "PN"),
            ((0x10, 0x10), "PN"),
            ((0x10, 0x20), "LO"),
            ((0x10, 0x30), "DA"),
            ((0x10, 0x40), "CS"),
            ((0x20, 0x10), "SH"),
        ] {
            root.text(key, vr, "");
        }
        let mut template = Writer::default();
        template.text((0x08, 0x0105), "CS", "DCMR");
        template.text((0x40, 0xdb00), "CS", "1500");
        root.sequence((0x40, 0xa504), vec![template]);

        let mut evidence_study = Writer::default();
        evidence_study.text((0x20, 0x0d), "UI", study);
        let mut evidence_series = Writer::default();
        evidence_series.text((0x20, 0x0e), "UI", series);
        evidence_series.sequence(REF_SOP, vec![image_reference(&record.source, false)]);
        evidence_study.sequence(REF_SERIES, vec![evidence_series]);
        root.sequence((0x40, 0xa375), vec![evidence_study]);

        let mut observer_type = item(
            Some("HAS OBS CONTEXT"),
            "CODE",
            Some(("121005", "DCM", "Observer Type")),
        );
        observer_type.sequence((0x40, 0xa168), vec![code("121006", "DCM", "Person")]);
        let mut observer_name = item(
            Some("HAS OBS CONTEXT"),
            "PNAME",
            Some(("121008", "DCM", "Person Observer Name")),
        );
        observer_name.text((0x40, 0xa123), "PN", &options.observer_name);

        let mut selected = item(Some("SELECTED FROM"), "IMAGE", None);
        selected.sequence(REF_SOP, vec![image_reference(&record.source, true)]);
        let mut path = item(
            Some("INFERRED FROM"),
            "SCOORD",
            Some(("121055", "DCM", "Path")),
        );
        path.text((0x70, 0x0023), "CS", "POLYLINE");
        let points = record
            .input
            .points
            .iter()
            .flat_map(|p| [p.x, p.y])
            .flat_map(|v| ((v + 0.5) as f32).to_le_bytes())
            .collect();
        path.element(GRAPHIC, "FL", points);
        path.sequence(CONTENT, vec![selected]);
        let mut numerical = item(Some("CONTAINS"), "NUM", Some(("121206", "DCM", "Distance")));
        let mut value = Writer::default();
        let mut printable = format!("{distance:.9}");
        if printable.len() > 16 {
            printable = format!("{distance:.8e}");
        }
        value.text((0x40, 0xa30a), "DS", &printable);
        value.element((0x40, 0xa161), "FD", distance.to_le_bytes().to_vec());
        value.sequence((0x40, 0x08ea), vec![code("mm", "UCUM", "millimeter")]);
        numerical.sequence((0x40, 0xa300), vec![value]);
        numerical.sequence(CONTENT, vec![path]);

        let mut tracking = item(
            Some("HAS OBS CONTEXT"),
            "TEXT",
            Some(("112039", "DCM", "Tracking Identifier")),
        );
        tracking.text((0x40, 0xa160), "UT", &record.input.id);
        let mut tracking_uid = item(
            Some("HAS OBS CONTEXT"),
            "UIDREF",
            Some(("112040", "DCM", "Tracking Unique Identifier")),
        );
        tracking_uid.text((0x40, 0xa124), "UI", &options.tracking_uid);
        let mut hash = item(
            Some("CONTAINS"),
            "TEXT",
            Some(("SOURCEHASH", "99RAYKIT", "Source SHA-256")),
        );
        hash.text((0x40, 0xa160), "UT", &record.source.content_sha256);
        let mut group = item(
            Some("CONTAINS"),
            "CONTAINER",
            Some(("125007", "DCM", "Measurement Group")),
        );
        group.sequence(CONTENT, vec![tracking, tracking_uid, numerical, hash]);
        let mut imaging = item(
            Some("CONTAINS"),
            "CONTAINER",
            Some(("126010", "DCM", "Imaging Measurements")),
        );
        imaging.sequence(CONTENT, vec![group]);
        root.sequence(CONTENT, vec![observer_type, observer_name, imaging]);
        root.text((8, 5), "CS", "ISO_IR 192");
        part10(SR, &options.instance_uid, root)
    }

    pub fn import_distance_sr(
        &mut self,
        sr: &Session,
        expected_source_sha256: Option<&str>,
    ) -> Result<Record> {
        let file = &sr.file;
        let root = &file.dataset;
        if sr.info.object != Object::StructuredReport
            || file.class_uid != SR
            || root
                .one((0x40, 0xa504))
                .and_then(|item| item.text(&file.bytes, (0x40, 0xdb00)))
                != Some("1500")
            || !concept(root, file, "126000", "DCM")
        {
            return Err(Error::Unsupported(
                "SR requires the TID 1500 distance subset",
            ));
        }
        let imaging = child(file, root, "126010", "DCM", "CONTAINER")?;
        let group = child(file, imaging, "125007", "DCM", "CONTAINER")?;
        let tracking = child(file, group, "112039", "DCM", "TEXT")?
            .text(&file.bytes, (0x40, 0xa160))
            .ok_or(Error::InvalidDicom("SR tracking identifier"))?;
        let num = child(file, group, "121206", "DCM", "NUM")?;
        let value = num
            .one((0x40, 0xa300))
            .ok_or(Error::InvalidDicom("SR measurement value"))?;
        if !value
            .one((0x40, 0x08ea))
            .is_some_and(|code| code_is(code, file, "mm", "UCUM"))
        {
            return Err(Error::Unsupported("SR distance units"));
        }
        let distance = value
            .fd(file, (0x40, 0xa161))
            .or_else(|| value.first_ds(file, (0x40, 0xa30a)))
            .filter(|v| *v > 0.0)
            .ok_or(Error::InvalidDicom("SR numeric distance"))?;
        let path = child(file, num, "121055", "DCM", "SCOORD")?;
        if path.text(&file.bytes, (0x70, 0x0023)) != Some("POLYLINE")
            || path.text(&file.bytes, RELATION) != Some("INFERRED FROM")
            || path
                .text(&file.bytes, (0x48, 0x0301))
                .is_some_and(|mode| mode != "FRAME")
        {
            return Err(Error::Unsupported("SR distance path"));
        }
        let points = read_points(file, path, 2)?;
        let [image] = path
            .sequence(CONTENT)
            .ok_or(Error::InvalidDicom("SR referenced image"))?
        else {
            return Err(Error::Unsupported("SR requires one referenced frame"));
        };
        if image.text(&file.bytes, TYPE) != Some("IMAGE")
            || image.text(&file.bytes, RELATION) != Some("SELECTED FROM")
        {
            return Err(Error::InvalidDicom("SR path reference relationship"));
        }
        let reference = image
            .one(REF_SOP)
            .ok_or(Error::InvalidDicom("SR reference SOP sequence"))?;
        let index = require_reference(file, reference, self, None)?;
        let hash = child(file, group, "SOURCEHASH", "99RAYKIT", "TEXT")
            .ok()
            .and_then(|item| item.text(&file.bytes, (0x40, 0xa160)));
        let expected = expected_source_sha256.or(hash).ok_or(Error::Integrity(
            "external SR requires a verified source SHA-256",
        ))?;
        if !self.info.content_sha256.eq_ignore_ascii_case(expected)
            || hash.is_some_and(|hash| !self.info.content_sha256.eq_ignore_ascii_case(hash))
        {
            return Err(Error::Integrity("SR source revision"));
        }
        let record = self.measure(
            index,
            Request {
                id: tracking.to_owned(),
                method: "raykit:length".to_owned(),
                version: 1,
                points,
                parameters: serde_json::json!({"require_mm": true}),
            },
            &Length,
        )?;
        if (record.values[0].value - distance).abs() > distance.abs().mul_add(1e-5, 1e-4) {
            return Err(Error::Integrity("SR distance differs from source geometry"));
        }
        Ok(record)
    }

    pub fn segmentation_overlay(
        &mut self,
        seg: &Session,
        frame: usize,
        segment: u16,
    ) -> Result<SegmentationOverlay> {
        let file = &seg.file;
        let root = &file.dataset;
        if seg.info.object != Object::Segmentation
            || !matches!(
                file.syntax,
                TransferSyntax::ImplicitLe | TransferSyntax::ExplicitLe
            )
            || root.text(&file.bytes, (0x62, 1)) != Some("BINARY")
            || root.us(file, (0x28, 2)) != Some(1)
            || root.text(&file.bytes, (0x28, 4)) != Some("MONOCHROME2")
            || root.us(file, (0x28, 0x100)) != Some(1)
            || root.us(file, (0x28, 0x101)) != Some(1)
            || root.us(file, (0x28, 0x102)) != Some(0)
            || root.us(file, (0x28, 0x103)) != Some(0)
        {
            return Err(Error::Unsupported("SEG requires native binary frames"));
        }
        if !root.sequence((0x62, 2)).is_some_and(|seq| {
            seq.iter()
                .filter(|i| i.us(file, (0x62, 4)) == Some(segment))
                .count()
                == 1
        }) {
            return Err(Error::InvalidRequest("SEG segment number"));
        }
        let source = self.source_reference(frame)?;
        let original = self.read_frame(frame)?;
        let width = original.format.columns;
        let height = original.format.rows;
        if root.us(file, (0x28, 0x10)).map(u32::from) != Some(height)
            || root.us(file, (0x28, 0x11)).map(u32::from) != Some(width)
        {
            return Err(Error::Geometry("SEG pixel matrix differs from source"));
        }
        if seg.frame_of_reference() != source.frame_of_reference_uid.as_deref() {
            return Err(Error::Integrity("SEG Frame of Reference"));
        }
        let items = root
            .sequence((0x5200, 0x9230))
            .ok_or(Error::InvalidDicom("SEG frame groups"))?;
        let count = root
            .text(&file.bytes, (0x28, 8))
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|&n| n != 0 && n == items.len() && n <= 4096)
            .ok_or(Error::InvalidDicom("SEG Number of Frames"))?;
        let pixels = (width * height) as usize;
        let packed = root
            .bytes(&file.bytes, PIXEL_DATA)
            .ok_or(Error::InvalidDicom("SEG Pixel Data"))?;
        if pixels
            .checked_mul(count)
            .map(|bits| bits.div_ceil(8).next_multiple_of(2))
            != Some(packed.len())
        {
            return Err(Error::InvalidDicom("SEG Pixel Data length"));
        }
        let mut matching = None;
        for index in 0..count {
            if groups(file, index, (0x62, 0x000a)).us(file, (0x62, 0x000b)) != Some(segment) {
                continue;
            }
            let derivation = groups(file, index, (8, 0x9124));
            let Some(reference) = derivation.one((8, 0x2112)) else {
                continue;
            };
            if require_reference(file, reference, self, None) != Ok(frame) {
                continue;
            }
            if reference.text(&file.bytes, (0x28, 0x135a)) != Some("YES") {
                return Err(Error::Geometry("SEG requires preserved spatial locations"));
            }
            if let Some(expected) = original.geometry.patient_plane {
                let spacing = groups(file, index, (0x28, 0x9110))
                    .ds(file, (0x28, 0x30))
                    .map(|[r, c]| [c, r])
                    .ok_or(Error::Geometry("SEG pixel spacing"))?;
                let position = groups(file, index, (0x20, 0x9113))
                    .ds(file, (0x20, 0x32))
                    .ok_or(Error::Geometry("SEG position"))?;
                let axes = groups(file, index, (0x20, 0x9116))
                    .ds(file, (0x20, 0x37))
                    .ok_or(Error::Geometry("SEG orientation"))?;
                let actual = PatientPlane::new(position, axes, spacing)
                    .ok_or(Error::Geometry("SEG patient plane"))?;
                if !same_plane(expected, actual) {
                    return Err(Error::Geometry("SEG plane differs from source"));
                }
            }
            if matching.replace(index).is_some() {
                return Err(Error::Integrity("duplicate SEG frame for source reference"));
            }
        }
        let start = matching.ok_or(Error::Integrity("SEG lacks a matching source frame"))? * pixels;
        let mask = (start..start + pixels)
            .map(|i| (packed[i / 8] >> (i % 8)) & 1)
            .collect();
        Ok(SegmentationOverlay {
            source,
            segment,
            dimensions: [width, height],
            mask,
        })
    }

    pub fn presentation(&mut self, pr: &Session, frame: usize) -> Result<Presentation> {
        let file = &pr.file;
        let root = &file.dataset;
        let source = self.source_reference(frame)?;
        let original = self.read_frame(frame)?;
        let display = original.display.as_ref().ok_or(Error::Unsupported(
            "grayscale presentation requires monochrome",
        ))?;
        if pr.info.object != Object::PresentationState
            || !matches!(
                display.modality,
                Modality::Linear {
                    slope: 1.0,
                    intercept: 0.0
                }
            )
            || root.get((0x28, 0x1053)).is_some()
            || root.get((0x28, 0x1052)).is_some()
            || root.get((0x28, 0x3000)).is_some()
            || root.get((0x2050, 0x10)).is_some()
            || root.get((0x70, 1)).is_some()
            || root.get((0x18, 0x1600)).is_some()
            || root
                .text(&file.bytes, (0x70, 0x41))
                .is_some_and(|value| value != "N")
        {
            return Err(Error::Unsupported("presentation state subset"));
        }
        let series = root
            .sequence(REF_SERIES)
            .and_then(|seq| {
                seq.iter().find(|item| {
                    item.text(&file.bytes, (0x20, 0x0e)) == self.info.series_uid.as_deref()
                })
            })
            .ok_or(Error::Integrity("presentation series reference"))?;
        if !applies(file, series, self, frame, true) {
            return Err(Error::Integrity("presentation image reference"));
        }
        let area = root
            .sequence((0x70, 0x5a))
            .and_then(|seq| {
                seq.iter()
                    .find(|item| applies(file, item, self, frame, false))
            })
            .ok_or(Error::Unsupported("full-frame displayed area is required"))?;
        let br = [original.format.columns, original.format.rows];
        if words2(file, area, (0x70, 0x52)) != Some([1, 1])
            || words2(file, area, (0x70, 0x53)) != Some(br)
            || area.text(&file.bytes, (0x70, 0x100)) != Some("SCALE TO FIT")
        {
            return Err(Error::Unsupported("presentation displayed area"));
        }
        let quarter_turns = match root.us(file, (0x70, 0x42)).unwrap_or(0) {
            n @ (0 | 90 | 180 | 270) => (n / 90) as u8,
            _ => return Err(Error::Unsupported("presentation rotation")),
        };
        let inverse = match root.text(&file.bytes, (0x2050, 0x20)) {
            Some("IDENTITY") => false,
            Some("INVERSE") => true,
            _ => return Err(Error::Unsupported("presentation LUT shape")),
        };
        let window = if let Some(items) = root.sequence((0x28, 0x3110)) {
            let item = items
                .iter()
                .find(|item| applies(file, item, self, frame, false))
                .ok_or(Error::Integrity("presentation VOI reference"))?;
            if item.get((0x28, 0x3010)).is_some() {
                return Err(Error::Unsupported("presentation VOI LUT"));
            }
            let center = item
                .first_ds(file, (0x28, 0x1050))
                .ok_or(Error::InvalidDicom("presentation window center"))?;
            let width = item
                .first_ds(file, (0x28, 0x1051))
                .ok_or(Error::InvalidDicom("presentation window width"))?;
            let function = match item.text(&file.bytes, (0x28, 0x1056)) {
                None | Some("LINEAR") => WindowFunction::Linear,
                Some("LINEAR_EXACT") => WindowFunction::LinearExact,
                Some("SIGMOID") => WindowFunction::Sigmoid,
                _ => return Err(Error::Unsupported("presentation VOI function")),
            };
            Some(
                Window {
                    center,
                    width,
                    function,
                }
                .validate()?,
            )
        } else {
            Some(display.automatic_window)
        };
        Ok(Presentation {
            source,
            quarter_turns,
            inverse,
            window,
        })
    }
}

fn words2(file: &File, data: &Dataset, tag: Key) -> Option<[u32; 2]> {
    let bytes = data.bytes(&file.bytes, tag).filter(|b| b.len() == 8)?;
    Some([
        file.order.u32(bytes[..4].try_into().ok()?),
        file.order.u32(bytes[4..].try_into().ok()?),
    ])
}

fn same_plane(a: PatientPlane, b: PatientPlane) -> bool {
    a.origin
        .0
        .into_iter()
        .zip(b.origin.0)
        .chain(a.column_axis.into_iter().zip(b.column_axis))
        .chain(a.row_axis.into_iter().zip(b.row_axis))
        .chain(a.spacing_xy.into_iter().zip(b.spacing_xy))
        .all(|(a, b)| (a - b).abs() <= 0.0001)
}

fn applies(
    file: &File,
    item: &Dataset,
    target: &Session,
    frame: usize,
    require_explicit: bool,
) -> bool {
    match item.sequence(REF_IMAGE) {
        None => !require_explicit,
        Some(items) => items
            .iter()
            .any(|image| require_reference(file, image, target, Some(frame)).is_ok()),
    }
}

fn require_reference(
    file: &File,
    reference: &Dataset,
    target: &Session,
    wanted: Option<usize>,
) -> Result<usize> {
    if reference.text(&file.bytes, (8, 0x1150)) != Some(target.info.sop_class_uid.as_str())
        || reference.text(&file.bytes, (8, 0x1155)) != Some(target.info.instance_uid.as_str())
    {
        return Err(Error::Integrity("referenced DICOM instance differs"));
    }
    match reference.text(&file.bytes, (8, 0x1160)) {
        Some(value) => {
            let mut frames = value.split('\\');
            let mut accepted = None;
            for (i, n) in frames.by_ref().enumerate() {
                let index = n
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .filter(|&i| i < target.info.frames)
                    .ok_or(Error::Integrity("referenced DICOM frame"))?;
                if wanted == Some(index) || wanted.is_none() && i == 0 {
                    accepted = Some(index);
                }
                if wanted.is_none() && i > 0 {
                    return Err(Error::Unsupported(
                        "reference requires a single DICOM frame",
                    ));
                }
            }
            accepted.ok_or(Error::Integrity("referenced DICOM frame differs"))
        }
        None => wanted
            .or_else(|| (target.info.frames == 1).then_some(0))
            .filter(|&i| i < target.info.frames)
            .ok_or(Error::Unsupported("referenced DICOM frame is ambiguous")),
    }
}

fn read_points(file: &File, item: &Dataset, count: usize) -> Result<Vec<PixelPoint>> {
    let data = item
        .bytes(&file.bytes, GRAPHIC)
        .filter(|d| d.len() == count * 8)
        .ok_or(Error::InvalidDicom("SR graphic point count"))?;
    let number = |bytes: &[u8]| {
        f64::from(f32::from_bits(
            file.order.u32(bytes.try_into().expect("graphic number")),
        )) - 0.5
    };
    Ok(data
        .as_chunks::<8>()
        .0
        .iter()
        .map(|pair| PixelPoint {
            x: number(&pair[..4]),
            y: number(&pair[4..]),
        })
        .collect())
}

fn concept(data: &Dataset, file: &File, value: &str, scheme: &str) -> bool {
    data.one(CONCEPT)
        .is_some_and(|code| code_is(code, file, value, scheme))
}

fn code_is(data: &Dataset, file: &File, value: &str, scheme: &str) -> bool {
    data.text(&file.bytes, (8, 0x0100)) == Some(value)
        && data.text(&file.bytes, (8, 0x0102)) == Some(scheme)
}

fn child<'a>(
    file: &File,
    parent: &'a Dataset,
    value: &str,
    scheme: &str,
    ty: &str,
) -> Result<&'a Dataset> {
    let mut matching = parent
        .sequence(CONTENT)
        .unwrap_or_default()
        .iter()
        .filter(|item| {
            concept(item, file, value, scheme) && item.text(&file.bytes, TYPE) == Some(ty)
        });
    let result = matching
        .next()
        .ok_or(Error::Unsupported("SR required content item"))?;
    if matching.next().is_some() {
        return Err(Error::Unsupported(
            "SR requires a single distance measurement group",
        ));
    }
    Ok(result)
}

fn code(value: &str, scheme: &str, meaning: &str) -> Writer {
    let mut code = Writer::default();
    code.text((8, 0x0100), "SH", value);
    code.text((8, 0x0102), "SH", scheme);
    code.text((8, 0x0104), "LO", meaning);
    code
}

fn item(relation: Option<&str>, ty: &str, concept: Option<(&str, &str, &str)>) -> Writer {
    let mut out = Writer::default();
    if let Some(relation) = relation {
        out.text(RELATION, "CS", relation);
    }
    out.text(TYPE, "CS", ty);
    if let Some((value, scheme, meaning)) = concept {
        out.sequence(CONCEPT, vec![code(value, scheme, meaning)]);
    }
    if ty == "CONTAINER" {
        out.text((0x40, 0xa050), "CS", "SEPARATE");
    }
    out
}

fn image_reference(reference: &SourceReference, frame: bool) -> Writer {
    let mut out = Writer::default();
    out.text((8, 0x1150), "UI", &reference.sop_class_uid);
    out.text((8, 0x1155), "UI", &reference.instance_uid);
    if frame {
        out.text((8, 0x1160), "IS", &(reference.frame + 1).to_string());
    }
    out
}

#[derive(Default)]
struct Writer(BTreeMap<Key, (&'static str, Vec<u8>)>);

impl Writer {
    fn text(&mut self, key: Key, vr: &'static str, text: &str) {
        self.element(key, vr, text.as_bytes().to_vec());
    }

    fn element(&mut self, key: Key, vr: &'static str, mut value: Vec<u8>) {
        if !value.len().is_multiple_of(2) {
            value.push(if matches!(vr, "UI" | "OB") { 0 } else { b' ' });
        }
        self.0.insert(key, (vr, value));
    }

    fn sequence(&mut self, key: Key, items: Vec<Self>) {
        let mut value = Vec::new();
        for item in items {
            let dataset = item.bytes();
            value.extend_from_slice(&[0xfe, 0xff, 0, 0xe0]);
            value.extend((dataset.len() as u32).to_le_bytes());
            value.extend(dataset);
        }
        self.element(key, "SQ", value);
    }

    fn bytes(self) -> Vec<u8> {
        let mut out = Vec::new();
        for ((group, tag), (vr, value)) in self.0 {
            out.extend(group.to_le_bytes());
            out.extend(tag.to_le_bytes());
            out.extend(vr.as_bytes());
            if matches!(vr, "OB" | "SQ" | "UT") {
                out.extend([0, 0]);
                out.extend((value.len() as u32).to_le_bytes());
            } else {
                out.extend((value.len() as u16).to_le_bytes());
            }
            out.extend(value);
        }
        out
    }
}

fn part10(class: &str, instance: &str, dataset: Writer) -> Result<Vec<u8>> {
    let mut meta = Writer::default();
    meta.element((2, 1), "OB", vec![0, 1]);
    meta.text((2, 2), "UI", class);
    meta.text((2, 3), "UI", instance);
    meta.text((2, 0x10), "UI", EXPLICIT_LE);
    meta.text(
        (2, 0x12),
        "UI",
        "2.25.219391019963272876653221624700652299465",
    );
    let bytes = meta.bytes();
    let mut length = Writer::default();
    length.element((2, 0), "UL", (bytes.len() as u32).to_le_bytes().to_vec());
    let mut out = vec![0; 128];
    out.extend_from_slice(b"DICM");
    out.extend(length.bytes());
    out.extend(bytes);
    out.extend(dataset.bytes());
    Ok(out)
}
