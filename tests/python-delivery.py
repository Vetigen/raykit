"""Run from a clean consumer environment with the local wheel installed."""

import json
from pathlib import Path
import sys

import numpy as np
from raykit import RaykitError, Session, inspect

source, reference_file, evidence_file, foreign = map(Path, sys.argv[1:])
ref = json.loads(reference_file.read_text())
evidence = json.loads(evidence_file.read_text())
x, y = ref["pixel"]
assert inspect(source)["frames"] == 300
with Session(source, expected_sha256=ref["sha256"]) as session:
    stored, frame = session.frame(ref["frame"])
    modality, _ = session.frame(ref["frame"], modality=True)
    assert stored.shape == modality.shape == (512, 512)
    assert stored.dtype.str == "<i4" and modality.dtype.str == "<f8"
    assert not frame["format"]["signed"] and frame["modality_unit"] == "HU"
    assert stored[y, x] == ref["stored"] and modality[y, x] == ref["modality"]
    assert np.isnan(modality[0, 0]) and not stored.flags.writeable
    at = session.sample(ref["frame"], x, y)
    np.testing.assert_allclose(at["patient"], ref["patient"], atol=1e-10, rtol=0)
    assert at == evidence["sample"]
    candidates = session.volume_candidates()
    volume = session.build_volume(0, candidates["revision"])
    slab, plane = session.reslice({
        "center": at["patient"], "dimensions": [3, 3], "orientation": {"kind": "axial"},
        "spacing_xy": [0.7, 0.8], "slab": {"kind": "single"},
    })
    assert volume["dimensions"] == [512, 512, 300]
    assert slab.shape == (3, 3) and slab.dtype.str == "<f4" and slab[1, 1] == ref["modality"]
    assert session.sample_volume(at["patient"]) == ref["modality"]
    assert session.verify_measurement(evidence["record"]) == evidence["record"]
assert stored[y, x] == ref["stored"] and modality[y, x] == ref["modality"]
with Session(foreign) as bad:
    try:
        bad.verify_measurement(evidence["record"])
    except RaykitError as error:
        assert error.code in ("integrity", "invalid_request")
    else:
        raise AssertionError("A different source accepted the measurement")
print(json.dumps({"numpy": np.__version__, "sample": at, "volume_dimensions": volume["dimensions"],
                  "plane": plane, "resolved_measurement": evidence["record"]["values"]}))
