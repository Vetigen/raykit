#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/raykit-home
mkdir -p "$HOME"
export PATH="$HOME/.cargo/bin:/opt/python/cp311-cp311/bin:$PATH"
export CARGO_TARGET_DIR=/tmp/raykit-target
export CARGO_ENCODED_RUSTFLAGS=$'--remap-path-prefix=/source=/raykit\x1f--remap-path-prefix=/tmp/raykit-home/.cargo=/cargo'

curl --fail --silent --show-error --retry 3 https://sh.rustup.rs -o /tmp/rustup.sh
sh /tmp/rustup.sh -y --no-modify-path --profile minimal --default-toolchain "$RAYKIT_RUST"
cd /source
cargo build --locked --target "$RAYKIT_TARGET" --release -p raykit-cli -p raykit-ffi -p raykit-node

build="$CARGO_TARGET_DIR/$RAYKIT_TARGET/release"
cp "$build"/{raykit,libraykit_ffi.so,libraykit_ffi.a,libraykit_node.so} /out/built
cp "$build/libraykit_ffi.so" /out/python/raykit_dicom/native/
python -m pip wheel --no-deps --wheel-dir /tmp/wheel /out/python
auditwheel repair --only-plat --plat "$RAYKIT_WHEEL_PLATFORM" -w /out/built /tmp/wheel/*.whl
auditwheel show /out/built/*.whl
