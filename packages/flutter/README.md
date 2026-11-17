# RayKit for Flutter

RayKit opens local DICOM images and gives Flutter apps access to original samples, frame geometry and measurements. The same Rust decoder is used by the web SDK.

Use Flutter 3.41 or later and Rust 1.97.1 or later with `rustup` available. Use the Android SDK and NDK for Android, or Xcode on macOS for iOS. Flutter's native asset hook compiles the bundled Rust workspace.

Extract the distribution archive and reference its `raykit` directory as a path dependency.

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

Use `RayKitViewer(source: source)` for the interactive widget. The widget owns its session and releases it when removed. Hosts control file and network access.

The RayKit project license is pending. See `notices/inventory.json` for the dependencies included in a native build.
