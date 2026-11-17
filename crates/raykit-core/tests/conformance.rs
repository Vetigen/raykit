#[path = "../../../fixtures/support.rs"]
mod fixture;

use fixture::*;
use raykit_core::{
    Error, Limits, Sample, Session,
    geometry::PixelPoint,
    measurement::{Length, Request, Unit},
    pixel::{RenderOptions, Window, WindowFunction},
};

#[test]
fn signed_packed_samples_and_presentation_across_encodings() {
    for syntax in [EXPLICIT_LE, IMPLICIT_LE, EXPLICIT_BE, DEFLATED] {
        let mut session = Session::open(signed_xray(syntax), Limits::default()).unwrap();
        let frame = session.read_frame(0).unwrap();
        let Sample::Monochrome {
            stored,
            modality,
            padding,
        } = frame.sample(10, 10).unwrap()
        else {
            panic!()
        };
        assert_eq!((stored, modality, padding), (-1540, -3180.0, false));
        let Sample::Monochrome {
            stored, padding, ..
        } = frame.sample(0, 0).unwrap()
        else {
            panic!()
        };
        assert_eq!((stored, padding), (-2048, true));
        let window = Window {
            center: -3180.0,
            width: 2.0,
            function: WindowFunction::LinearExact,
        };
        let rgba = frame
            .render_rgba(RenderOptions {
                window: Some(window),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(&rgba[..4], &[0, 0, 0, 255]);
        assert_eq!(&rgba[4 * (10 * 64 + 10)..][..4], &[128, 128, 128, 255]);
        assert_eq!(session.memory().decoded_frames, 1);
        let length = session
            .measure(
                0,
                Request {
                    id: "synthetic-measurement".into(),
                    method: "raykit:length".into(),
                    version: 1,
                    points: vec![
                        PixelPoint { x: 0.0, y: 0.0 },
                        PixelPoint { x: 6.0, y: 16.0 },
                    ],
                    parameters: serde_json::Value::Null,
                },
                &Length,
            )
            .unwrap();
        assert_eq!(length.values[0].unit, Unit::Millimeter);
        assert_eq!(length.values[0].value, 5.0);
        let mut other = Session::open(
            signed_xray(if syntax == EXPLICIT_LE {
                EXPLICIT_BE
            } else {
                EXPLICIT_LE
            }),
            Limits::default(),
        )
        .unwrap();
        assert!(matches!(
            other.reopen_measurement(length.clone(), &Length),
            Err(Error::Integrity(_))
        ));
        assert_eq!(
            session.reopen_measurement(length.clone(), &Length).unwrap(),
            length
        );
    }
}

#[test]
fn rle_planes_preserve_full_unsigned_range() {
    let mut session = Session::open(unsigned_rle(), Limits::default()).unwrap();
    let frame = session.read_frame(0).unwrap();
    for (i, &expected) in [0, 7, 32768, 65535].iter().enumerate() {
        let Sample::Monochrome { stored, .. } = frame.sample(i as u32 % 2, i as u32 / 2).unwrap()
        else {
            panic!()
        };
        assert_eq!(stored, expected);
    }
}

#[test]
fn independently_reads_split_and_extended_offset_frames() {
    for (offsets, split) in [
        (Offsets::Basic, true),
        (Offsets::Empty, true),
        (Offsets::Extended, false),
    ] {
        let bytes = cine([64, 48], 5, offsets, split);
        let mut session = Session::open(bytes.clone(), Limits::default()).unwrap();
        assert_eq!(session.inspection().frames, 5);
        for i in [4, 0, 2, 0] {
            let frame = session.read_frame(i).unwrap();
            let Sample::Color { values, .. } = frame.sample(0, 0).unwrap() else {
                panic!()
            };
            assert!(
                values
                    .into_iter()
                    .zip(cine_color(i))
                    .all(|(a, b)| a.abs_diff(b) <= 4),
                "{i}: {values:?}"
            );
        }
        assert_eq!(session.memory().decoded_frames, 3);
        assert!(session.memory().cached_frames <= 2);
        assert_eq!(session.memory().fragment_copy_bytes > 0, split);
        session.evict_frames();
        assert_eq!(session.memory().cached_pixel_bytes, 0);
        assert!(Session::open(bytes[..bytes.len() - 8].to_vec(), Limits::default()).is_err());
    }
}

#[test]
fn bounds_input_and_inflated_source() {
    assert!(
        Session::open(benchmark_xray(), Limits::default())
            .unwrap()
            .read_frame(0)
            .is_ok()
    );
    assert!(matches!(
        Session::open(
            signed_xray(EXPLICIT_LE),
            Limits {
                source_bytes: 132,
                ..Default::default()
            }
        ),
        Err(Error::Limit(_))
    ));
    assert!(matches!(
        Session::open(
            signed_xray(DEFLATED),
            Limits {
                inflated_bytes: 256,
                ..Default::default()
            }
        ),
        Err(Error::Limit(_))
    ));
    assert!(matches!(
        Session::open(
            signed_xray(EXPLICIT_LE),
            Limits {
                frame_pixels: 32,
                ..Default::default()
            }
        ),
        Err(Error::Limit(_))
    ));
}

#[cfg(feature = "advanced-codecs")]
#[test]
fn advanced_profiles_decode_analytic_samples_at_full_precision() {
    for profile in 0..10 {
        let (name, bytes, expected, tolerance) = codec_fixture(profile);
        let mut decoded =
            Session::open(bytes, Limits::default()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let frame = decoded
            .read_frame(0)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let raykit_core::pixel::Samples::Monochrome(stored) = &frame.samples else {
            panic!("{name}")
        };
        assert_eq!(stored.len(), expected.len());
        for (i, (actual, expected)) in stored.iter().zip(expected).enumerate() {
            assert!(
                (actual - expected).abs() <= tolerance,
                "{name} pixel {i}: {actual} vs {expected} within {tolerance}"
            );
        }
    }
}

#[test]
fn oblique_classic_ct_and_enhanced_temporal_volumes_use_patient_geometry() {
    use raykit_core::{
        geometry::PatientPoint,
        volume::{Orientation, Reslice, Slab, Volume},
    };
    let open = |bytes| Session::open(bytes, Limits::default()).unwrap();
    let mut sources = [
        open(classic_slice(2, 2.0, false)),
        open(classic_slice(0, 0.0, false)),
        open(classic_slice(1, 1.0, false)),
        open(classic_slice(9, 3.0, true)),
    ];
    let mut references = sources.iter_mut().collect::<Vec<_>>();
    let volume = Volume::build(&mut references, 0).unwrap();
    assert_eq!(volume.metadata.dimensions, [8, 6, 3]);
    assert_eq!(volume.metadata.frames[0].instance_uid, "2.25.911");
    assert_eq!(volume.metadata.frames[2].instance_uid, "2.25.913");
    let p = PatientPoint(phantom_point(3.0, 2.0, 1.0));
    assert_eq!(volume.sample(p), Some(136.0));
    let oblique = Orientation::Oblique {
        axes: [0.8, 0.6, 0.0, -0.48, 0.64, 0.6],
    };
    for orientation in [
        Orientation::Axial,
        Orientation::Coronal,
        Orientation::Sagittal,
        oblique,
    ] {
        let slice = volume
            .reslice(&Reslice {
                center: p,
                orientation,
                dimensions: [3, 3],
                spacing_xy: [0.3, 0.5],
                slab: Slab::Single,
            })
            .unwrap();
        assert_eq!(slice.values[4], 136.0);
        let point = slice.plane.at(PixelPoint { x: 1.0, y: 1.0 });
        assert!(
            point
                .0
                .into_iter()
                .zip(p.0)
                .all(|(a, b)| (a - b).abs() < 1e-9)
        );
    }
    let mut request = Reslice {
        center: p,
        orientation: oblique,
        dimensions: [1, 1],
        spacing_xy: [0.3, 0.5],
        slab: Slab::Maximum { thickness_mm: 5.0 },
    };
    assert_eq!(volume.reslice(&request).unwrap().values, [236.0]);
    request.slab = Slab::Average { thickness_mm: 5.0 };
    assert_eq!(volume.reslice(&request).unwrap().values, [136.0]);
    for source in [enhanced_volume(false), enhanced_volume(true)] {
        let mut session = open(source);
        let candidates = Volume::candidates(&[&session]).unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().all(|s| s.available && s.frames == 3));
        for (i, expected) in [136.0, 1136.0].into_iter().enumerate() {
            let volume = Volume::build(&mut [&mut session], i).unwrap();
            assert_eq!(volume.sample(p), Some(expected));
        }
        let frame = session.read_frame(0).unwrap();
        assert_eq!(
            frame.geometry.increasing_row.as_ref().unwrap(),
            &["dorsal", "rostral", "right"]
        );
    }
}

#[test]
fn irregular_and_duplicate_ct_positions_keep_original_slices_available() {
    use raykit_core::volume::Volume;
    for positions in [[0.0, 1.0, 3.0], [0.0, 0.0, 2.0], [0.0, 2.0, 4.0]] {
        let mut sessions = positions
            .into_iter()
            .enumerate()
            .map(|(i, z)| {
                Session::open(classic_slice(i as u16, z, false), Limits::default()).unwrap()
            })
            .collect::<Vec<_>>();
        let refs = sessions.iter().collect::<Vec<_>>();
        let groups = Volume::candidates(&refs).unwrap();
        assert!(!groups[0].available);
        assert!(
            sessions
                .iter_mut()
                .all(|session| session.read_frame(0).is_ok())
        );
    }
}

#[test]
fn interchange_applies_exact_frame_references_and_source_geometry() {
    let open = |bytes| Session::open(bytes, Limits::default()).unwrap();
    let sr = open(measured_sr());
    let mut xray = open(signed_xray(EXPLICIT_LE));
    let distance = xray.import_distance_sr(&sr, None).unwrap();
    assert_eq!(distance.values[0].value, 5.0);
    assert_eq!(
        distance.input.points,
        [
            PixelPoint { x: 3.0, y: 5.0 },
            PixelPoint { x: 9.0, y: 21.0 }
        ]
    );
    let mut different_bytes = open(signed_xray(EXPLICIT_BE));
    assert!(matches!(
        different_bytes.import_distance_sr(&sr, None),
        Err(Error::Integrity(_))
    ));
    let mut ct = open(enhanced_volume(false));
    let seg = open(segmentation());
    let overlay = ct.segmentation_overlay(&seg, 0, 1).unwrap();
    assert_eq!(overlay.dimensions, [8, 6]);
    assert_eq!(overlay.mask.iter().position(|v| *v == 1), Some(20));
    assert_eq!(overlay.mask.iter().sum::<u8>(), 1);
    assert!(matches!(
        ct.segmentation_overlay(&seg, 2, 1),
        Err(Error::Integrity(_))
    ));
    let pr = open(presentation());
    let settings = ct.presentation(&pr, 0).unwrap();
    assert_eq!(settings.quarter_turns, 1);
    assert!(settings.inverse);
    assert_eq!(settings.window.unwrap().width, 100.0);
    assert!(ct.presentation(&pr, 4).is_err());
}

#[test]
fn projection_luts_ultrasound_units_and_document_profiles() {
    let open = |bytes| Session::open(bytes, Limits::default()).unwrap();
    for (class, modality) in [(DX, "DX"), (IO, "IO")] {
        let mut session = open(lut_projection(class, "2.25.900", modality));
        let frame = session.read_frame(0).unwrap();
        let rgba = frame.render_rgba(RenderOptions::default()).unwrap();
        assert_eq!(
            rgba.as_chunks::<4>()
                .0
                .iter()
                .map(|rgba| rgba[0])
                .collect::<Vec<_>>(),
            [0, 64, 128, 192]
        );
    }
    let request = Request {
        id: "us-distance".to_owned(),
        method: "raykit:length".to_owned(),
        version: 1,
        points: vec![PixelPoint { x: 1.0, y: 1.0 }, PixelPoint { x: 4.0, y: 3.0 }],
        parameters: serde_json::json!({"require_mm": true}),
    };
    let mut us = open(native_us(true, true));
    let frame = us.read_frame(0).unwrap();
    assert!(matches!(
        frame.sample(4, 2).unwrap(),
        Sample::Color {
            values: [12, 34, 56],
            ..
        }
    ));
    assert_eq!(
        us.measure(0, request.clone(), &Length).unwrap().values[0].value,
        5.0
    );
    let mut time = open(native_us(false, false));
    assert!(matches!(
        time.read_frame(0).unwrap().sample(4, 2).unwrap(),
        Sample::Monochrome { stored: 20, .. }
    ));
    assert!(matches!(
        time.measure(0, request, &Length),
        Err(Error::Geometry(_))
    ));
    let pdf = open(encapsulated_pdf());
    assert!(pdf.inspection().capabilities.host_document);
    assert!(pdf.pdf().unwrap().starts_with(b"%PDF-1.4"));
    assert!(pdf.pdf().unwrap().ends_with(b"%%EOF\n"));
}
