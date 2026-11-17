# RayKit for Flutter

RayKit opens local DICOM images and gives Flutter apps access to original samples, frame geometry and measurements. The same Rust decoder is used by the web SDK.

Use Flutter 3.41 or later and Rust 1.97.1 or later with `rustup` available. Use the Android SDK and NDK for Android, or Xcode on macOS for iOS. Flutter's native asset hook compiles the bundled Rust workspace.

Use `flutter pub add raykit` for the hosted SDK. For a release rehearsal, extract the source archive and reference its `raykit` directory as a path dependency.

```yaml
dependencies:
  raykit:
    path: ../raykit
```

```dart
import 'dart:io';
import 'package:raykit/raykit.dart';

final source = RayKitSource.file(File(path));
final session = await RayKitSession.open(source);
try {
  final frame = await session.readFrame(0);
  print(await session.sample(frame.index, 10, 10));
} finally {
  await session.close();
}
```

Use `RayKitViewer(source: source)` for the interactive widget. A `RayKitViewerController` supports precise `seek`, continuous `scrub`, `settle`, and `samplePresented`. Use `RayKitVolumeView(session: session)` for patient-space CT/MR planes and slabs. Its host owns the session. The image viewer owns and releases its own session when removed.

Local file sessions read through a Rust-owned descriptor. For an indexed JPEG Baseline source, use `createFrameIndex` on a fully verified session. Keep its manifest and SHA-256 under host control. Reopen with `RayKitSource.indexedFile(file, index)` to verify and read ranges. Byte and stream source constructors are also supported.

The default viewer uses the reference CPU rendering path. `RayKitDisplayMode.shader` can select the packed 16-bit path after a runtime precision probe. The standalone example exposes both modes for device A/B measurement.

RayKit uses Apache-2.0. See `LICENSE` and `notices/inventory.json` in the native package.
