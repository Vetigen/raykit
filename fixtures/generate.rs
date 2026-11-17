use std::{fs, path::PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};

mod support;
use support::*;

fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let output = PathBuf::from(
        args.next()
            .unwrap_or_else(|| "fixtures/generated".to_owned()),
    );
    let long = args.any(|arg| arg == "--long-cine");
    fs::create_dir_all(&output)?;
    let mut manifest = serde_json::Map::new();
    let mut save = |name: &str,
                    data: Vec<u8>,
                    expected: serde_json::Value|
     -> std::io::Result<()> {
        let file = format!("{name}.dcm");
        fs::write(output.join(&file), &data)?;
        manifest.insert(file, json!({"sha256": format!("{:x}", Sha256::digest(&data)), "bytes": data.len(), "expected": expected}));
        Ok(())
    };
    for (name, syntax) in [
        ("signed12", EXPLICIT_LE),
        ("signed12-implicit", IMPLICIT_LE),
        ("signed12-big-endian", EXPLICIT_BE),
        ("signed12-deflated", DEFLATED),
    ] {
        save(
            name,
            signed_xray(syntax),
            json!({"frames":1,"sample":[10,10,-1540],"padding":[0,0,-2048],"modality_at_10_10":-3180,"spacing_xy":[0.5,0.25]}),
        )?;
    }
    save(
        "benchmark-signed12",
        benchmark_xray(),
        json!({"frames":1,"sample":[10,10,-1540],"value_tolerance":0,"gray_tolerance":1}),
    )?;
    save(
        "detail-signed12",
        detail_xray(),
        json!({"dimensions":[2048,2048],
        "probes":[[0,0,-2048],[127,10,-1508],[128,10,-1507],[1000,550,-1501],
        [1001,550,-1499],[1023,1600,-1536],[1024,1600,-1472],[2047,2047,-2048]], "gray_tolerance":1}),
    )?;
    save(
        "unsigned16-rle",
        unsigned_rle(),
        json!({"frames":1,"stored":[0,7,32768,65535]}),
    )?;
    save(
        "cine-fragments",
        cine([64, 48], 5, Offsets::Empty, true),
        json!({"frames":5,"rgb_at_0_0":[cine_color(0),cine_color(1),cine_color(2),cine_color(3),cine_color(4)],"tolerance":4}),
    )?;
    save(
        "cine-extended",
        cine([64, 48], 5, Offsets::Extended, false),
        json!({"frames":5,"rgb_at_0_0":[cine_color(0),cine_color(1),cine_color(2),cine_color(3),cine_color(4)],"tolerance":4}),
    )?;
    #[cfg(feature = "advanced-codecs")]
    for profile in 0..10 {
        let (name, bytes, expected, tolerance) = codec_fixture(profile);
        save(
            &name,
            bytes,
            json!({"dimensions":[16,16], "stored": expected, "tolerance": tolerance}),
        )?;
    }
    for (name, source) in [
        ("enhanced-ct-oblique", enhanced_volume(false)),
        ("enhanced-mr-oblique", enhanced_volume(true)),
    ] {
        save(
            name,
            source,
            json!({"dimensions":[8,6,3], "frames":6, "temporal_positions":2,
            "patient_point":phantom_point(3.0, 2.0, 1.0), "modality_by_time":[136,1136], "column_spacing":0.7, "row_spacing":1.5, "slice_spacing":2.5}),
        )?;
    }
    for (name, mr) in [("large-enhanced-ct", false), ("large-enhanced-mr", true)] {
        save(
            name,
            large_volume(mr),
            json!({"dimensions":[512,512,300], "frames":300,
            "patient_point":[179.2,204.8,180.0], "stored_at_256_256_150":474,
            "modality_at_point":448, "voxel_bytes":314572800}),
        )?;
    }
    for i in 0..3 {
        save(
            &format!("classic-ct-{i}"),
            classic_slice(i, f64::from(i), false),
            json!({"slice":i,"origin":phantom_point(0.0, 0.0, f64::from(i))}),
        )?;
        save(
            &format!("classic-mr-{i}"),
            classic_mr_slice(i),
            json!({"slice":i,"origin":phantom_point(0.0, 0.0, f64::from(i))}),
        )?;
    }
    save(
        "phantom-seg",
        segmentation(),
        json!({"referenced_frame":0,"segment":1,"mask_at":[4,2,1]}),
    )?;
    save(
        "phantom-gsps",
        presentation(),
        json!({"referenced_frame":0,"quarter_turns":1,"center":250,"width":100,"inverse":true}),
    )?;
    save(
        "distance-sr",
        measured_sr(),
        json!({"template":"1500","distance":5,"unit":"mm","frame":0,"points":[[3,5],[9,21]]}),
    )?;
    save(
        "dx-luts",
        lut_projection(DX, "2.25.845", "DX"),
        json!({"stored":[0,1,2,3], "gray":[0,64,128,192]}),
    )?;
    save(
        "io-luts",
        lut_projection(IO, "2.25.846", "IO"),
        json!({"stored":[0,1,2,3], "gray":[0,64,128,192]}),
    )?;
    save(
        "us-rgb-planar",
        native_us(true, true),
        json!({"rgb":[12,34,56], "distance_mm":5}),
    )?;
    save(
        "us-ybr-422",
        native_ybr422(),
        json!({"stored_ybr":[[32,180,110],[96,180,110],[64,90,160],[200,90,160]], "rgb_tolerance":1}),
    )?;
    save(
        "us-gray-time",
        native_us(false, false),
        json!({"stored_at_4_2":20, "calibrated":false}),
    )?;
    save(
        "encapsulated-pdf",
        encapsulated_pdf(),
        json!({"media_type":"application/pdf"}),
    )?;
    if long {
        save(
            "cine-350",
            cine([1260, 910], 350, Offsets::Basic, false),
            json!({"frames":350,"dimensions":[1260,910],"rgb_at_0_0":{"0":cine_color(0),"175":cine_color(175),"349":cine_color(349)},"tolerance":4}),
        )?;
    }
    let mut preview = Vec::new();
    let pixels: Vec<u8> = (0..3)
        .flat_map(|y| (0..4).map(move |x| 20 + 20 * x + 6 * y))
        .collect();
    jpeg_encoder::Encoder::new(&mut preview, 90)
        .encode(&pixels, 4, 3, jpeg_encoder::ColorType::Luma)
        .expect("synthetic projection preview");
    fs::write(output.join("classic-ct-preview.jpg"), &preview)?;
    manifest.insert(
        "classic-ct-preview.jpg".to_owned(),
        json!({"bytes": preview.len(), "sha256": format!("{:x}", Sha256::digest(&preview)),
            "expected": {"dimensions": [4, 3], "source_instance": "2.25.913", "sample_step": 2, "window_low": 180}}),
    );
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )
}
