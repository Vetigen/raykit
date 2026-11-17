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

Open the printed local URL. Choose a local file or a synthetic case. In the ultrasound, drag the frame slider to 350. In the oblique CT, click **Build volume**, then choose a plane or slab. Select **Ruler**, mark its two endpoints, and click **Calculate**. Export the measures and import the JSON after reopening the same DICOM bytes. To run the source adapter against a local service, choose **Open local DICOMweb series**.

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

Install Flutter 3.41 or later, Rust with `rustup`, and the Flutter-supported toolchain for your target. Android needs the SDK and NDK. iOS needs Xcode on macOS. Prepare the synthetic assets from the checkout root, then run the example on a device you select.

```sh
npm run fixtures
cd examples/flutter
flutter pub get
flutter run
```

The Flutter example opens local files through the platform picker. It can also open the same synthetic radiograph and 350-frame ultrasound as the web example. Copy measurement JSON and paste it after opening the original file again. The Rust native asset is built by the Flutter package hook. Each source has one owning isolate. Closing the viewer cancels delivery and releases native resources after the last call.

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

## Verification and scope

Run `cargo test --workspace --locked` after changing the core. The generated corpus records SHA-256 and expected results. `tests/web-workflow.mjs` and `tests/web-conformance.mjs` exercise the built web package in a local browser. `packages/flutter/test/native_workflow_test.dart` exercises the Flutter package and native ABI on its host. `npm run benchmark:build` builds the local browser comparison with DWV and Cornerstone3D.

The [support matrix](docs/support.md) lists the tested profiles. The [API notes](docs/api.md) describe byte ownership, evidence for source identity, geometry and local interchange. The [measurement guide](docs/measurements.md) describes the landmark methods and the external Rust example.

RayKit's project license is pending. The package build records the licenses and included notices of third-party components. Geometric validation is based on synthetic fixtures. Veterinary specialist review and physical-device qualification are tracked separately.
