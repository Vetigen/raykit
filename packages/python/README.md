# RayKit by Vetigen for Python

Install with `python -m pip install raykit-dicom`. The matching wheel contains the native RayKit library and works without Rust. A source install needs rustup and a platform C linker. The package calls the versioned C ABI and uses NumPy for array views.

```python
from raykit_dicom import Session

with Session("computed-tomography.dcm") as source:
    stored, info = source.frame(0)
    modality, _ = source.frame(0, modality=True)
    print(stored[25, 40], modality[25, 40], info["modality_unit"])
    print(source.sample(0, 40, 25)["patient"])
```

Coordinates are zero-based. Arrays are `[row, column]` in little-endian int32 (signed or unsigned stored codes expressed as nonnegative int32 where appropriate), float64 modality values with NaN padding, or uint8 RGB/YBR with a final component axis. `format.signed` reports the DICOM pixel representation. `geometry.patient_plane` reports origin in patient millimeters, direction of increasing column and row, and spacing in column-row order. A missing unit or patient coordinate is represented by `None`.

The native buffer is copied once into owned Python bytes before it is freed. NumPy views those bytes without another copy and the read-only arrays survive session close. Use `.copy()` for writable arrays. Volume candidates and `reslice` expose one bounded float32 plane at a time. Append additional classic slices with `add_volume_source` before selecting a candidate revision. `verify_measurement` requires a matching source and reproduces the saved value with the applicable calibration.
