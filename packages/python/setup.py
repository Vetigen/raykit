from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

from setuptools import Distribution, setup
from setuptools.command.build_py import build_py
from wheel.bdist_wheel import bdist_wheel


class NativeDistribution(Distribution):
    def has_ext_modules(self):
        return True


class NativeWheel(bdist_wheel):
    def get_tag(self):
        _, _, platform = super().get_tag()
        return "py3", "none", platform


class BuildPython(build_py):
    def run(self):
        super().run()
        name = {
            "win32": "raykit_ffi.dll",
            "darwin": "libraykit_ffi.dylib",
        }.get(sys.platform, "libraykit_ffi.so")
        libdir = Path(self.build_lib) / "raykit_dicom" / "native"
        if (libdir / name).is_file():
            return
        workspace = Path(__file__).resolve().parent / "native"
        if not (workspace / "Cargo.lock").is_file():
            raise RuntimeError("RayKit wheel needs a native library or the bundled Rust sources")
        with tempfile.TemporaryDirectory(prefix="raykit-rust-") as target:
            env = os.environ.copy()
            flags = env.get("CARGO_ENCODED_RUSTFLAGS", "").split("\x1f")
            flags.append(f"--remap-path-prefix={workspace}=/raykit")
            env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(filter(None, flags))
            subprocess.run(
                ["cargo", "build", "--locked", "--release", "-p", "raykit-ffi",
                 "--target-dir", target],
                cwd=workspace, env=env, check=True,
            )
            libdir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(Path(target) / "release" / name, libdir / name)


setup(distclass=NativeDistribution, cmdclass={
    "bdist_wheel": NativeWheel,
    "build_py": BuildPython,
})
