# RayKit

RayKit is a Rust-based DICOM SDK for veterinary imaging. Its TypeScript and Flutter packages open a local file, present a selected original frame, retrieve stored samples, and reopen measurements on the exact same source. The standalone examples use generated data and run without an account or a remote service.

## Web example

Install Rust 1.97.1 or later and Node.js 22.12 or later. Run these commands from the checkout.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128 --locked
npm ci
npm run fixtures
npm run build:web
npm run example:web
```

Open the printed local URL. Choose a local file or a synthetic case. Drag the ultrasound slider and release at frame 350. **Open indexed ultrasound** verifies the bundled source and reopens it through its frame index. Open the 300-slice CT or MR, click **Build volume**, then choose a plane and slab. Change center, width or palette to rewindow the current plane.

Select **Ruler**, mark two endpoints, and click **Calculate**. For a canine VHS record, select **VHS**, confirm the lateral projection and place the cardiac and vertebral landmarks shown in the tool. Export the measurements and import the JSON after reopening the same DICOM bytes. **Open local DICOMweb series** demonstrates a clearly labeled preview, verification of the original bytes and progressive series loading.

The packages expose a framework-independent session and viewport. `@raykit/web-component` registers the ready viewer.

```ts
import { open } from '@raykit/web';
import { registerRaykitViewer } from '@raykit/web-component';

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

## Local packages

Run `npm run package:local` from a build checkout. The `artifacts/` directory contains npm tarballs for both web packages and a standalone Flutter source bundle. Install both web tarballs in the same app. Extract the Flutter archive and point your app's `raykit` dependency at the extracted directory. The native sources and lockfile travel with the Flutter bundle.

```sh
npm install path/to/raykit-web-0.1.0.tgz path/to/raykit-web-component-0.1.0.tgz
tar -xzf path/to/raykit-flutter-0.1.0.tar.gz
```

With the fixtures and archives built, run `node tests/packaged-workflows.mjs` from the checkout. It installs both web tarballs and the Flutter archive in a fresh directory and exercises the independent examples. Install a Playwright Chromium with `npx playwright-core install chromium` or set `RAYKIT_CHROMIUM` to a compatible local browser.

## Verification and scope

Run `cargo test --workspace --locked` after changing the core. The generated corpus records SHA-256 and expected results. `tests/web-indexed.mjs` and `tests/web-imaging-quality.mjs` cover range integrity, image quality and measurement records. `packages/flutter/test/imaging_quality_test.dart` exercises the native equivalents. `npm run benchmark:build` builds the local browser comparison with DWV and Cornerstone3D. The standalone [device acceptance target](examples/flutter/README.md#profile-acceptance) uses the public viewer and session APIs.

The [support matrix](docs/support.md) lists the tested profiles. The [API notes](docs/api.md) describe ownership, layout, interchange and desktop WebView embedding. The [measurement guide](docs/measurements.md) describes the landmark methods and the external Rust example. The [benchmark guide](benchmarks/README.md) contains the measured results and reproduction steps.

RayKit's project license is pending. Apache-2.0 is the proposed license. The package build records the licenses and included notices of third-party components. Geometric validation is based on synthetic fixtures. Veterinary specialist review and physical-device qualification are tracked separately.
