# RayKit by Vetigen — Open-source toolkit for DICOM visualization, image processing, and measurement

RayKit uses one Rust core for DICOM viewing, image processing and measurements in web, Flutter, desktop, CLI, Node.js and Python. Open local studies, compare views of one original frame, and reopen measurements against the same source. The standalone examples use generated data and run without an account or a remote service.

## Web example

Install Rust 1.97.1 or later and Node.js 24 or later. Run these commands from the checkout.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128 --locked
npm ci
npm run fixtures
npm run fixtures:delivery
npm run build:web
npm run example:web
```

Open the printed local URL. Choose a local file or a synthetic case. Drag the ultrasound slider and release at frame 350. **Open indexed ultrasound** verifies the bundled source and reopens it through its frame index. Open the 300-slice CT or MR, click **Build volume**, then choose a plane and slab. Change center, width or palette to rewindow the current plane.

For a side-by-side reading, choose **Open CT with named windows**, then **Compare same source**. Select a panel to choose its display and layers. Scroll through the slices and use **Pixel value** to place a linked pointer. **Compare T1 and T2** uses a registered synthetic pair with differently ordered frames. The delivery fixtures drive the proof-verified first-frame and tiled radiograph examples. **Follow synthetic acquisitions** and **Start synthetic live stream** exercise freeze and reconnect.

Select **Ruler**, mark two endpoints, and click **Calculate**. For a canine VHS record, select **VHS**, confirm the lateral projection and place the cardiac and vertebral landmarks shown in the tool. Export the measurements and import the JSON after reopening the same DICOM bytes. **Open local DICOMweb series** demonstrates a clearly labeled preview, verification of the original bytes and progressive series loading.

The packages expose a framework-independent session and viewport. `@vetigen/raykit-web-component` registers the ready viewer.

```ts
import { open } from '@vetigen/raykit-web';
import { registerRaykitViewer } from '@vetigen/raykit-web-component';

registerRaykitViewer();
const viewer = document.querySelector('raykit-viewer')!;
await viewer.open(file);

const session = await open(file);
try {
  const frame = await session.readFrame(0, { output: 'stored' });
  const sample = await session.sample(frame.source.frame, 10, 10);
  console.log(sample);
} finally {
  session.close();
}
```

Use a bundler that supports module workers with `new URL(..., import.meta.url)`. Serve the built assets over HTTP or HTTPS with the `application/wasm` media type. One worker owns each open source. Default single-worker operation works without COOP/COEP headers.

## Flutter example

Install Flutter 3.41 or later, Rust 1.97.1 or later with `rustup`, Node.js and the Flutter-supported toolchain for your target. Android needs the SDK and NDK. iOS needs Xcode on macOS. Prepare the synthetic assets from the checkout root, then run the example on a device you select.

```sh
npm run fixtures
cd examples/flutter
flutter pub get
flutter run
```

The Flutter example opens local files through the platform picker and native file reader. The bundled detail chart, indexed ultrasound and 300-slice CT/MR use the same synthetic inputs as web. Select **Volume** after opening a CT or MR. Copy measurement JSON and paste it after opening the original file again. The Rust native asset is built by the Flutter package hook. Each source has one owning isolate. Closing the viewer cancels delivery and releases native resources after the last call.

**Compare same source** shares the existing source isolate between panels. **Compare T1 and T2** in **Synthetic cases** opens the registered fixtures. The live examples accept a host-owned decoded preview stream or a sequence of authorized DICOM instances. Freeze a preview and use **Verify matching original** to open its calibrated source when a capture binding exists.

```dart
import 'dart:io';
import 'package:raykit/raykit.dart';

final session = await RayKitSession.open(RayKitSource.file(File(path)));
try {
  final frame = await session.readFrame(0);
  final sample = await session.sample(frame.index, 10, 10);
  print(sample);
} finally {
  await session.close();
}
```

## Desktop

Build the same standalone Flutter app on the destination operating system.

```sh
npm run fixtures
cd examples/flutter
flutter pub get
flutter build linux --release
# On macOS, run flutter build macos --release.
# On Windows, run flutter build windows --release.
```

Open or drop a DICOM file or a study folder. Choose a series and instance, compare CT/MR, play cine, and save or reopen measurement JSON. A build includes the native libraries and Flutter data alongside the executable or in the app bundle. See the [desktop build and acceptance commands](examples/flutter/README.md#desktop).

## CLI, Node.js and Python

Install the CLI with `cargo install raykit-cli --locked` once the version is available on crates.io. You can also extract the matching archive from GitHub Releases and run its `raykit` binary.

```sh
raykit inspect fixtures/generated/comparison-ct.dcm --frame 150
raykit render fixtures/generated/comparison-ct.dcm --frame 150 --window-index 1 --out bone.png
raykit sample fixtures/generated/comparison-ct.dcm --frame 150 --x 256 --y 256
raykit frame-index fixtures/generated/cine-350.dcm --out cine.rki
raykit measurements verify fixtures/generated/comparison-ct.dcm measurement.json
```

Install the Node SDK with `npm install @vetigen/raykit-node`. The loader selects the optional native addon for the current platform. Its session opens local sources and renders on Node-API's asynchronous work pool. The [Node.js proof example](examples/node/proofs.mjs) writes packets for a static host.

Install the Python SDK with `python -m pip install raykit-dicom` and import `raykit_dicom`. Run the NumPy example with `python sample.py SOURCE --frame 150 --x 256 --y 256`. NumPy views retain their owned bytes after close. [NumPy example](examples/python/sample.py)

## Local packages

Run `npm run package:local` from a build checkout. The `artifacts/` directory contains the web, Node loader and Flutter source packages. Run `npm run package:native` for the CLI, C SDK, native Node addon and Python wheel. Set `RAYKIT_ARTIFACTS` to select an empty output directory. Extract the Flutter archive and point your app's `raykit` dependency at the extracted directory. The native sources and lockfile travel with the Flutter bundle.

```sh
npm install path/to/vetigen-raykit-web-0.1.0.tgz path/to/vetigen-raykit-web-component-0.1.0.tgz
tar -xzf path/to/raykit-flutter-0.1.0.tar.gz
```

With the fixtures and archives built, run `node tests/packaged-workflows.mjs` from the checkout. It installs both web tarballs and the Flutter archive in a fresh directory and exercises the independent examples. Install a Playwright Chromium with `npx playwright-core install chromium` or set `RAYKIT_CHROMIUM` to a compatible local browser.

`node tests/native-delivery.mjs` installs the CLI, C SDK, Node and Python artifacts in a fresh consumer directory. Its optional `RAYKIT_NATIVE_EVIDENCE_DIR` output supplies the proof and tiles to `node tests/web-delivery.mjs`. See the [release guide](docs/release.md) for the runner matrix, local tools and registry setup.

## Verification and scope

Run `cargo test --workspace --locked` after changing the core. The generated corpus records SHA-256 and expected results. `tests/web-indexed.mjs` and `tests/web-imaging-quality.mjs` cover range integrity, image quality and measurement records. `packages/flutter/test/imaging_quality_test.dart` exercises the native equivalents. `npm run benchmark:build` builds the local browser comparison with DWV and Cornerstone3D. The standalone [device acceptance target](examples/flutter/README.md#profile-acceptance) uses the public viewer and session APIs.

The [support matrix](docs/support.md) lists the tested profiles. The [API notes](docs/api.md) describe ownership, layout, interchange and desktop WebView embedding. The [measurement guide](docs/measurements.md) describes the landmark methods and the external Rust example. The [benchmark guide](benchmarks/README.md) contains the measured results and reproduction steps.

The [clinical comparison protocol](docs/clinical-comparison.md) contains the paired-view exercise and scoring.

RayKit uses the [Apache License 2.0](LICENSE). The package builds include third-party licenses and notices. Geometric validation uses synthetic fixtures. See the [support matrix](docs/support.md) for specialist and physical-device acceptance.
