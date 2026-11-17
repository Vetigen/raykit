# RayKit Flutter example

Use the app to open a local DICOM file, navigate a synthetic ultrasound, and save or reopen landmark measurements. The Flutter package builds RayKit's Rust library as a native asset.

Run from the repository root with the [required toolchain](../../README.md#flutter-example) installed.

```sh
npm run fixtures
cd examples/flutter
flutter pub get
flutter run
```

Choose **Synthetic radiograph** or **350-frame ultrasound** to use the bundled files. Use the folder button to open a file from your device. To reopen measurements, copy the measurement JSON, reopen the same source, and select **Paste measurements**.
