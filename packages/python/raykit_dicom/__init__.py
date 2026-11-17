"""RayKit by Vetigen. Frame arrays are indexed by row, then column."""

import ctypes as _c
import json as _json
import os as _os
from pathlib import Path as _Path
import sys as _sys
from threading import Lock as _Lock

import numpy as np

__all__ = ["Session", "RaykitError", "inspect"]


class RaykitError(RuntimeError):
    def __init__(self, code, detail=None):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


class _Buffer(_c.Structure):
    _fields_ = [("data", _c.c_void_p), ("length", _c.c_size_t)]


class _Response(_c.Structure):
    _fields_ = [("handle", _c.c_uint64), ("metadata", _Buffer), ("data", _Buffer)]


def _library():
    name = ("raykit_ffi.dll" if _sys.platform == "win32" else
            "libraykit_ffi.dylib" if _sys.platform == "darwin" else "libraykit_ffi.so")
    try:
        lib = _c.CDLL(str(_Path(__file__).parent / "native" / name))
    except OSError as exc:
        raise RaykitError("unsupported", "Native RayKit library is unavailable for this platform") from exc
    span = [_c.c_char_p, _c.c_size_t]
    out = [_c.POINTER(_Response)]
    for suffix, arguments, result in (
        ("abi_version", [], _c.c_uint32),
        ("open_file", span * 4 + out, _c.c_uint32),
        ("append_file", [_c.c_uint64] + span * 2 + out, _c.c_uint32),
        ("request", [_c.c_uint64] + span + out, _c.c_uint32),
        ("close", [_c.c_uint64], None),
        ("free", [_c.c_void_p, _c.c_size_t], None),
    ):
        function = getattr(lib, f"raykit_v1_{suffix}")
        function.argtypes, function.restype = arguments, result
    if lib.raykit_v1_abi_version() != 1:
        raise RaykitError("unsupported", "Native ABI version")
    return lib


_lib = None
_library_lock = _Lock()


def _native():
    global _lib
    with _library_lock:
        if _lib is None:
            _lib = _library()
        return _lib


def _reply(call, *args):
    out = _Response()
    status = call(*args, _c.byref(out))
    try:
        info = _json.loads(_c.string_at(out.metadata.data, out.metadata.length)) if out.metadata.length else None
        if status != 0:
            raise RaykitError(**info) if info else RaykitError("internal", "Empty native error")
        return out.handle, info, _c.string_at(out.data.data, out.data.length) if out.data.length else b""
    finally:
        lib = _native()
        lib.raykit_v1_free(out.metadata.data, out.metadata.length)
        lib.raykit_v1_free(out.data.data, out.data.length)


def _json_bytes(value):
    return _json.dumps(value, allow_nan=False, separators=(",", ":")).encode()


def _path(path):
    return _os.fspath(_Path(path).absolute()).encode("utf-8")


class Session:
    """A verified snapshot. Close it explicitly or use a context manager."""

    def __init__(self, path, **options):
        self._lock = _Lock()
        self._handle = 0
        file = _path(path)
        settings = _json_bytes(options)
        self._handle, self.inspection, _ = _reply(
            _native().raykit_v1_open_file, file, len(file), None, 0, None, 0, settings, len(settings)
        )

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __del__(self):
        if getattr(self, "_handle", 0) and _lib is not None:
            _lib.raykit_v1_close(self._handle)

    def close(self):
        with self._lock:
            if self._handle:
                _native().raykit_v1_close(self._handle)
                self._handle = 0

    def _request(self, op, **values):
        encoded = _json_bytes(dict(op=op, **values))
        with self._lock:
            if not self._handle:
                raise RaykitError("closed")
            _, info, output = _reply(_native().raykit_v1_request, self._handle, encoded, len(encoded))
            return info, output

    def frame_info(self, index):
        return self._request("frame_info", index=index)[0]

    def frame(self, index, *, modality=False):
        """Return (array, metadata). RGB/YBR arrays have a final component axis."""
        info, raw = self._request("frame", index=index, output="modality" if modality else "stored")
        rows, cols = (info["format"][name] for name in ("rows", "columns"))
        encoding = info["encoding"]
        if encoding == "modality_f64_le":
            array = np.frombuffer(raw, dtype="<f8").reshape(rows, cols)
        elif encoding == "mono_i32_le":
            array = np.frombuffer(raw, dtype="<i4").reshape(rows, cols)
        else:
            array = np.frombuffer(raw, dtype="u1").reshape(rows, cols, 3)
        return array, info

    def sample(self, index, x, y):
        return self._request("sample_at", index=index, x=x, y=y)[0]

    def verify_measurement(self, record):
        return self._request("verify", record=record)[0]

    def add_volume_source(self, path, **options):
        file = _path(path)
        settings = _json_bytes(options)
        with self._lock:
            if not self._handle:
                raise RaykitError("closed")
            _, info, _ = _reply(_native().raykit_v1_append_file, self._handle, file, len(file), settings, len(settings))
            return info

    def volume_candidates(self):
        return self._request("volume_candidates")[0]

    def build_volume(self, index, revision):
        return self._request("volume_build", index=index, revision=revision)[0]

    def sample_volume(self, patient):
        return self._request("volume_sample", point=list(patient))[0]

    def reslice(self, plane, *, sampling="trilinear"):
        """Return one bounded float32 modality plane in row, column order."""
        info, raw = self._request("reslice", plane=plane, sampling=sampling)
        columns, rows = info["dimensions"]
        return np.frombuffer(raw, dtype="<f4").reshape(rows, columns), info


def inspect(path, **options):
    with Session(path, **options) as session:
        return session.inspection
