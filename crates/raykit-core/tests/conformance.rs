#[path = "../../../fixtures/support.rs"]
mod fixture;

use fixture::*;
use raykit_core::{
    Error, Limits, Sample, Session,
    geometry::PixelPoint,
    measurement::{Length, Request, Unit},
    pixel::{RenderOptions, VoiScope, VoiSelection, Window, WindowFunction},
};

fn open(bytes: Vec<u8>) -> Session {
    Session::open(bytes, Limits::default()).unwrap()
}

#[test]
fn device_views_keep_original_samples_and_registered_mr_requires_a_matching_plane() {
    let mut ct = open(comparison_ct());
    let alternatives = ct.voi_alternatives(150).unwrap();
    assert!(matches!(alternatives[0].scope, VoiScope::Shared));
    assert_eq!(
        [
            alternatives[0].label.as_str(),
            alternatives[1].label.as_str()
        ],
        ["Soft tissue", "Bone"]
    );
    let frame = ct.read_frame(150).unwrap();
    let soft = frame.render_rgba(RenderOptions::default()).unwrap();
    let selected = ct.select_voi(150, VoiSelection::Window(0)).unwrap();
    assert_eq!(
        soft,
        frame
            .render_rgba_with_voi(RenderOptions::default(), Some(&selected))
            .unwrap()
    );
    let bone = ct.select_voi(150, VoiSelection::Window(1)).unwrap();
    assert_ne!(
        soft,
        frame
            .render_rgba_with_voi(RenderOptions::default(), Some(&bone))
            .unwrap()
    );
    assert!(matches!(
        frame.sample(256, 256).unwrap(),
        Sample::Monochrome {
            stored: 474,
            modality: 448.0,
            padding: false
        }
    ));
    assert_eq!(ct.modality_unit(150).unwrap(), Some("HU"));
    assert_eq!(ct.memory().decoded_frames, 1);

    let t1 = open(mr_comparison(1));
    let mut t2 = open(mr_comparison(2));
    let shifted = open(mr_comparison(3));
    let plane = t1.geometry(0).unwrap().patient_plane.unwrap();
    let patient = plane.at(PixelPoint { x: 3.0, y: 2.0 });
    let actual_reference = t1
        .source_reference(0)
        .unwrap()
        .frame_of_reference_uid
        .unwrap();
    let (index, pixel) = t2
        .locate_patient(patient, &actual_reference, plane.normal())
        .unwrap()
        .unwrap();
    assert_eq!(index, 1);
    assert!((pixel.x - 3.0).abs() < 1e-8 && (pixel.y - 2.0).abs() < 1e-8);
    assert_eq!(
        shifted
            .locate_patient(patient, &actual_reference, plane.normal())
            .unwrap(),
        None
    );
    assert_eq!(t2.modality_unit(index).unwrap(), None);
    let scale = t2.quantitative_scale(index).unwrap();
    assert_eq!(scale.unit.value, "1/s");
    assert!(t1.quantitative_scale(0).is_none());
    let frame = t2.read_frame(index).unwrap();
    let Sample::Monochrome { stored, .. } = frame.sample(3, 2).unwrap() else {
        panic!("monochrome sample");
    };
    assert_eq!(scale.value(stored), Some(f64::from(stored) * 0.25 + 0.5));
    assert!(scale.value(1024).is_none());
    assert_ne!(
        frame.render_quantitative(&scale, false).unwrap(),
        frame.render_rgba(RenderOptions::default()).unwrap()
    );
}

#[test]
fn separate_voi_luts_and_declared_spectral_axes_have_independent_values() {
    let mut dx = open(alternate_luts());
    let views = dx.voi_alternatives(0).unwrap();
    assert_eq!(views[0].label, "VOI LUT 1");
    assert_eq!(views[1].label, "Alternative contrast");
    let frame = dx.read_frame(0).unwrap();
    assert_eq!(
        frame.render_rgba(RenderOptions::default()).unwrap()[..4],
        [0, 0, 0, 255]
    );
    let chosen = dx.select_voi(0, VoiSelection::Lut(1)).unwrap();
    assert_eq!(
        frame
            .render_rgba_with_voi(RenderOptions::default(), Some(&chosen))
            .unwrap()[..4],
        [255; 4]
    );

    let plain = open(native_us(true, true));
    assert!(plain.doppler_point(0, 3, 2).is_none());
    let mut spectral = open(spectral_us());
    let axis = spectral.doppler_point(0, 3, 2).unwrap();
    assert_eq!(
        (axis.time, axis.time_unit, axis.spectral, axis.spectral_unit),
        (0.02, "s", 5.0, "cm/s")
    );
    assert!(spectral.doppler_point(0, 1, 2).is_none());
    assert!(matches!(
        spectral.read_frame(0).unwrap().sample(3, 2).unwrap(),
        Sample::Color {
            values: [12, 34, 56],
            ..
        }
    ));
}

#[test]
fn authenticated_proof_and_tiled_projections_preserve_source_identity() {
    use raykit_core::tiles::{Region, TiledImage};
    let mut full = open(cine([32, 24], 4, Offsets::Basic, true));
    let catalog = full.create_frame_proofs("synthetic-v1").unwrap();
    let pin = catalog.root_sha256();
    let mut wrong = catalog.packet(1).unwrap();
    *wrong.last_mut().unwrap() ^= 1;
    assert!(matches!(
        Session::open_frame_proof(wrong, &pin, "synthetic-v1", 1, Limits::default(), None),
        Err(Error::Integrity(_))
    ));
    let expected = full.inspection().content_sha256.clone();
    let mut detached = Session::open_frame_proof(
        catalog.packet(1).unwrap(),
        &pin,
        "synthetic-v1",
        1,
        Limits::default(),
        Some(&expected),
    )
    .unwrap();
    assert_eq!(
        detached.read_frame(1).unwrap().samples,
        full.read_frame(1).unwrap().samples
    );
    assert!(matches!(
        detached.stage_frame_proof(2, catalog.packet(1).unwrap()),
        Err(Error::Integrity(_))
    ));
    detached
        .stage_frame_proof(2, catalog.packet(2).unwrap())
        .unwrap();
    assert_eq!(
        detached.read_frame(2).unwrap().samples,
        full.read_frame(2).unwrap().samples
    );
    assert_eq!(detached.memory().range_reads, 2);

    let mut original = open(detail_xray());
    let tiles = original.create_tiles(0, 256, "projection-v1").unwrap();
    let (pin, manifest) = tiles.manifest().unwrap();
    let mut tiled = TiledImage::open(&manifest, &pin, "projection-v1").unwrap();
    let rect = Region {
        x: 254,
        y: 254,
        width: 8,
        height: 8,
    };
    let indices = tiled.needed(rect).unwrap();
    assert_eq!(indices.len(), 4);
    let mut damaged = tiles.tile(indices[0]).unwrap();
    damaged[0] ^= 1;
    assert!(matches!(
        tiled.stage(indices[0], damaged),
        Err(Error::Integrity(_))
    ));
    for i in indices {
        tiled.stage(i, tiles.tile(i).unwrap()).unwrap();
    }
    let options = RenderOptions::default();
    let whole = original
        .read_frame(0)
        .unwrap()
        .render_rgba(options)
        .unwrap();
    let expected: Vec<u8> = (254..262)
        .flat_map(|y| {
            whole[(y * 2048 + 254) * 4..(y * 2048 + 262) * 4]
                .iter()
                .copied()
        })
        .collect();
    assert_eq!(tiled.rgba(rect, options).unwrap(), expected);
    assert_eq!(tiled.cached_bytes(), 4 * 256 * 256 * 4);
}

#[cfg(unix)]
#[test]
fn borrowed_file_descriptor_reads_position_independently_and_checks_changes() {
    use raykit_core::NativeFile;
    use std::{
        fs::OpenOptions,
        io::{Seek, SeekFrom, Write},
        os::fd::AsRawFd,
    };
    let path = std::env::temp_dir().join(format!("raykit-source-test-{}", std::process::id()));
    let bytes = signed_xray(EXPLICIT_LE);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.write_all(&bytes).unwrap();
    file.seek(SeekFrom::Start(20)).unwrap();
    let reader = NativeFile::duplicate_descriptor(file.as_raw_fd()).unwrap();
    assert_eq!(reader.read(0, bytes.len()).unwrap(), bytes);
    assert_eq!(file.stream_position().unwrap(), 20);
    // The reader continues to own only its duplicate after the original is closed.
    drop(file);
    assert_eq!(reader.read(128, 4).unwrap(), b"DICM");
    let mut changed = OpenOptions::new().append(true).open(&path).unwrap();
    changed.write_all(&[0]).unwrap();
    assert_eq!(
        reader.read(128, 4).unwrap_err(),
        Error::Integrity("source file changed")
    );
    drop(reader);
    drop(changed);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn detail_phantom_and_shared_chroma_preserve_original_samples() {
    let mut detail = Session::open(detail_xray(), Limits::default()).unwrap();
    let frame = detail.read_frame(0).unwrap();
    for (x, y, expected) in [
        (0, 0, -2048),
        (127, 10, -1508),
        (128, 10, -1507),
        (1000, 550, -1501),
        (1001, 550, -1499),
        (1023, 1600, -1536),
        (1024, 1600, -1472),
    ] {
        let Sample::Monochrome { stored, .. } = frame.sample(x, y).unwrap() else {
            panic!()
        };
        assert_eq!(stored, expected);
    }
    let mut color = Session::open(native_ybr422(), Limits::default()).unwrap();
    let frame = color.read_frame(0).unwrap();
    let expected = [
        [32, 180, 110],
        [96, 180, 110],
        [64, 90, 160],
        [200, 90, 160],
    ];
    for (i, expected) in expected.into_iter().enumerate() {
        let Sample::Color { space, values } = frame.sample((i % 2) as u32, (i / 2) as u32).unwrap()
        else {
            panic!()
        };
        assert_eq!(space, raykit_core::pixel::ColorSpace::YbrFull);
        assert_eq!(values, expected);
    }
}

#[test]
fn pinned_cine_index_authenticates_each_frame_with_all_offset_table_shapes() {
    for (offsets, split) in [
        (Offsets::Basic, false),
        (Offsets::Basic, true),
        (Offsets::Extended, false),
        (Offsets::Empty, true),
    ] {
        let bytes = cine([64, 48], 5, offsets, split);
        let mut full = Session::open(bytes.clone(), Limits::default()).unwrap();
        let manifest = full.create_frame_index().unwrap();
        assert!(
            Session::open_index(&manifest.bytes, &"0".repeat(64), Limits::default(), None).is_err()
        );
        assert!(
            Session::open_index(
                &manifest.bytes,
                &manifest.sha256,
                Limits::default(),
                Some(&"0".repeat(64))
            )
            .is_err()
        );
        let mut partial = Session::open_index(
            &manifest.bytes,
            &manifest.sha256,
            Limits::default(),
            Some(&full.inspection().content_sha256),
        )
        .unwrap();
        assert_eq!(partial.inspection().verification, "pinned_frame_index");
        assert_eq!(
            partial.inspection().frame_durations_ms,
            full.inspection().frame_durations_ms
        );
        assert_eq!(partial.memory().source_read_bytes, 0);
        for index in [0, 2, 4] {
            assert_eq!(
                partial.read_frame(index).unwrap_err(),
                Error::FrameRange(index)
            );
            let span = partial.frame_range(index).unwrap();
            let original = &bytes[span.start..span.end];
            assert!(
                partial
                    .stage_range(index, original[..original.len() - 1].to_vec())
                    .is_err()
            );
            let mut changed = original.to_vec();
            changed[0] ^= 1;
            assert!(partial.stage_range(index, changed).is_err());
            assert_eq!(
                partial.read_frame(index).unwrap_err(),
                Error::FrameRange(index)
            );
            partial.stage_range(index, original.to_vec()).unwrap();
            let checked = partial.read_frame(index).unwrap();
            let expected = full.read_frame(index).unwrap();
            assert_eq!(
                partial.source_reference(index).unwrap(),
                full.source_reference(index).unwrap()
            );
            assert_eq!(
                checked.render_rgba(RenderOptions::default()).unwrap(),
                expected.render_rgba(RenderOptions::default()).unwrap()
            );
        }
    }
}

#[test]
fn large_ct_and_mr_use_the_same_budgeted_patient_coordinate_path() {
    use raykit_core::{
        geometry::PatientPoint,
        volume::{Orientation, Reslice, Slab, Volume},
    };
    for mr in [false, true] {
        let mut source = Session::open(large_volume(mr), Limits::default()).unwrap();
        let volume = Volume::build(&mut [&mut source], 0).unwrap();
        assert_eq!(volume.metadata.dimensions, [512, 512, 300]);
        assert_eq!(volume.metadata.voxel_bytes, 300 * 1024 * 1024);
        assert_eq!(volume.memory().decoded_slices, 0);
        let center = PatientPoint([179.2, 204.8, 180.0]);
        assert_eq!(volume.try_sample(center).unwrap(), Some(448.0));
        assert_eq!(
            volume
                .try_sample(PatientPoint([0.7, 204.8, 180.0]))
                .unwrap(),
            None
        );
        let mut request = Reslice {
            center,
            orientation: Orientation::Axial,
            dimensions: [3, 3],
            spacing_xy: [0.7, 0.8],
            slab: Slab::Single,
        };
        let axial = volume.reslice(&request).unwrap();
        assert_eq!(axial.values[4], 448.0);
        request.orientation = Orientation::Coronal;
        assert_eq!(volume.reslice(&request).unwrap().values[4], 448.0);
        request.orientation = Orientation::Oblique {
            axes: [
                1.0,
                0.0,
                0.0,
                0.0,
                std::f64::consts::FRAC_1_SQRT_2,
                std::f64::consts::FRAC_1_SQRT_2,
            ],
        };
        request.slab = Slab::Average { thickness_mm: 12.0 };
        let avg = volume.reslice(&request).unwrap();
        request.slab = Slab::Maximum { thickness_mm: 12.0 };
        let mip = volume.reslice(&request).unwrap();
        assert!((440.0..456.0).contains(&avg.values[4]));
        assert!(mip.values[4] > avg.values[4] + 15.0);
        assert!(volume.memory().peak_slice_cache_bytes <= 16 * 1024 * 1024);
    }
}

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

#[test]
fn rejects_excessive_sequences_and_fragment_indexes() {
    let mut item = Dataset::new(EXPLICIT_LE);
    for _ in 0..25 {
        let mut parent = Dataset::new(EXPLICIT_LE);
        parent.sequence(8, 0x1140, &[item]);
        item = parent;
    }
    assert!(matches!(
        Session::open(
            part10(CR, XRAY_UID, EXPLICIT_LE, item.bytes),
            Limits::default()
        ),
        Err(Error::Limit("dataset nesting depth"))
    ));
    assert!(matches!(
        Session::open(
            cine([64, 48], 5, Offsets::Empty, true),
            Limits {
                fragments: 1,
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
fn classic_mr_forms_a_patient_space_volume() {
    use raykit_core::{geometry::PatientPoint, volume::Volume};

    let mut sources =
        [2, 0, 1].map(|slice| Session::open(classic_mr_slice(slice), Limits::default()).unwrap());
    let mut references = sources.iter_mut().collect::<Vec<_>>();
    let volume = Volume::build(&mut references, 0).unwrap();
    assert_eq!(volume.metadata.frames[0].instance_uid, "2.25.961");
    assert_eq!(
        volume.sample(PatientPoint(phantom_point(3.0, 2.0, 1.0))),
        Some(136.0)
    );
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
