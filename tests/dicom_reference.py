"""Independent pydicom / Highdicom checks of the generated corpus."""

import json
import hashlib
from pathlib import Path

import highdicom
import numpy as np
import pydicom
from pydicom.pixels import pixel_array

root = Path(__file__).resolve().parent.parent / "fixtures" / "generated"
manifest = json.loads((root / "manifest.json").read_text())
errors = []
codec_deltas = {}
for filename, row in manifest.items():
    expected = row["expected"]
    if not filename.startswith(("jpeg-", "htj2k")):
        continue
    try:
        values = pixel_array(root / filename).ravel().astype(np.int64)
        maximum = int(np.max(np.abs(values - np.array(expected["stored"]))))
        codec_deltas[filename] = maximum
        if maximum > expected["tolerance"]:
            errors.append(f"{filename} reference error {maximum}")
    except Exception as error:
        errors.append(f"{filename}: {type(error).__name__}: {error}")

for index in [0, 175, 349]:
    expected = manifest["cine-350.dcm"]["expected"]
    rgb = pixel_array(root / "cine-350.dcm", index=index)[0, 0].astype(np.int64)
    assert np.max(np.abs(rgb - expected["rgb_at_0_0"][str(index)])) <= expected["tolerance"]

signatures = {}
for name in ["signed12", "signed12-implicit", "signed12-big-endian", "signed12-deflated", "detail-signed12"]:
    ds = pydicom.dcmread(root / f"{name}.dcm")
    # Interpret the shifted High Bit from the independent reader's raw Pixel Data.
    endian = ">" if name.endswith("big-endian") else "<"
    words = np.frombuffer(ds.PixelData, dtype=f"{endian}u2").astype(np.int32)
    mask = (1 << ds.BitsStored) - 1
    sign = 1 << (ds.BitsStored - 1)
    stored = (words >> (ds.HighBit + 1 - ds.BitsStored)) & mask
    stored = ((stored ^ sign) - sign).reshape(ds.Rows, ds.Columns)
    if name == "detail-signed12":
        for x, y, value in manifest[f"{name}.dcm"]["expected"]["probes"]:
            assert stored[y, x] == value
        np.testing.assert_array_equal(stored, pixel_array(root / f"{name}.dcm"))
    else:
        assert stored[10, 10] == -1540 and stored[0, 0] == -2048
    modality = stored * float(ds.get("RescaleSlope", 1)) + float(ds.get("RescaleIntercept", 0))
    c, w = float(ds.WindowCenter), float(ds.WindowWidth)
    intensity = 1.0 - np.clip((modality - (c - 0.5)) / (w - 1) + 0.5, 0, 1)
    intensity[stored == ds.PixelPaddingValue] = 0
    gray = np.floor(intensity * 255 + 0.5).astype(np.uint8)
    rgba = np.stack((gray, gray, gray, np.full_like(gray, 255)), axis=-1)
    signatures[name] = {"stored_sha256": hashlib.sha256(stored.astype("<i4").tobytes()).hexdigest(),
                        "rgba_sha256": hashlib.sha256(rgba.tobytes()).hexdigest()}

np.testing.assert_array_equal(pixel_array(root / "unsigned16-rle.dcm").ravel(), [0, 7, 32768, 65535])
np.testing.assert_array_equal(pixel_array(root / "us-rgb-planar.dcm", raw=True)[0, 0], [12, 34, 56])
ybr = pixel_array(root / "us-ybr-422.dcm", raw=True)
np.testing.assert_array_equal(ybr.reshape(-1, 3), manifest["us-ybr-422.dcm"]["expected"]["stored_ybr"])
for name in ["large-enhanced-ct", "large-enhanced-mr"]:
    ds = pydicom.dcmread(root / f"{name}.dcm", stop_before_pixels=True)
    assert int(ds.NumberOfFrames) == 300
    sample = pixel_array(root / f"{name}.dcm", index=150)[256, 256]
    transform = ds.PerFrameFunctionalGroupsSequence[150].PixelValueTransformationSequence[0]
    assert sample == 474 and sample * float(transform.RescaleSlope) + float(transform.RescaleIntercept) == 448

report = highdicom.sr.ComprehensiveSR.from_dataset(pydicom.dcmread(root / "distance-sr.dcm"))
groups = report.content.get_image_measurement_groups()
assert len(groups) == 1
measurement = groups[0].get_measurements()[0]
assert measurement.value == 5.0 and measurement.unit.value == "mm"
coordinates = measurement.referenced_coordinates[0]
np.testing.assert_allclose(coordinates.value, [[3.5, 5.5], [9.5, 21.5]], atol=1e-7)
image = coordinates.ContentSequence[0].ReferencedSOPSequence[0]
assert image.ReferencedSOPInstanceUID == "2.25.101" and image.ReferencedFrameNumber == 1
print(json.dumps({"pydicom": pydicom.__version__, "highdicom": highdicom.__version__, "codec_deltas": codec_deltas,
                  "pixel_signatures": signatures, "sr": {"value": measurement.value, "unit": measurement.unit.value}, "errors": errors}, indent=2))
assert not errors
