"""Independent pydicom / Highdicom checks of the generated corpus."""

import json
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
                  "sr": {"value": measurement.value, "unit": measurement.unit.value}, "errors": errors}, indent=2))
assert not errors
