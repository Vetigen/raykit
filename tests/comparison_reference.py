"""Independent reference for both views of the synthetic enhanced CT."""

import hashlib
import json
from pathlib import Path

import numpy as np
import pydicom
from pydicom import Dataset
from pydicom.pixels import apply_windowing, pixel_array

path = Path(__file__).resolve().parents[1] / "fixtures/generated/comparison-ct.dcm"
ds = pydicom.dcmread(path, stop_before_pixels=True)
index = 150
x, y = 256, 256
stored = pixel_array(path, index=index)
transform = ds.PerFrameFunctionalGroupsSequence[index].PixelValueTransformationSequence[0]
voi = ds.SharedFunctionalGroupsSequence[0].FrameVOILUTSequence[0]
windowing = Dataset()
for key in ("PhotometricInterpretation", "BitsStored", "PixelRepresentation"):
    windowing[key] = ds[key]
for key in ("RescaleSlope", "RescaleIntercept"):
    windowing[key] = transform[key]
for key in ("WindowCenter", "WindowWidth"):
    windowing[key] = voi[key]
scale, intercept = float(transform.RescaleSlope), float(transform.RescaleIntercept)
modality = stored.astype(np.float64) * scale + intercept
hashes = []
for i in range(len(voi.WindowCenter)):
    levels = (apply_windowing(modality, windowing, index=i) - intercept) / (65535 * scale)
    levels[stored == ds.PixelPaddingValue] = 0
    gray = np.floor(np.clip(levels, 0, 1) * 255 + .5).astype(np.uint8)
    rgba = np.stack((gray, gray, gray, np.full_like(gray, 255)), axis=-1)
    hashes.append(hashlib.sha256(rgba.tobytes()).hexdigest())
orientation = ds.SharedFunctionalGroupsSequence[0].PlaneOrientationSequence[0]
spacing = ds.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].PixelSpacing
origin = ds.PerFrameFunctionalGroupsSequence[index].PlanePositionSequence[0].ImagePositionPatient
axes = np.asarray(orientation.ImageOrientationPatient).reshape(2, 3)
patient = np.asarray(origin) + x * float(spacing[1]) * axes[0] + y * float(spacing[0]) * axes[1]
print(json.dumps({
    "pydicom": pydicom.__version__, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    "frame": index, "pixel": [x, y], "patient": patient.tolist(), "stored": int(stored[y, x]),
    "modality": modality[y, x], "unit": transform.RescaleType,
    "labels": list(voi.WindowCenterWidthExplanation), "rgba_sha256": hashes,
}, indent=2))
