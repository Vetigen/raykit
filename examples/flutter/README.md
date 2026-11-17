# RayKit Flutter example

Use the app to open a local DICOM file, navigate a synthetic ultrasound, and save or reopen landmark measurements. The Flutter package builds RayKit's Rust library as a native asset.

Run from the repository root with the [required toolchain](../../README.md#flutter-example) installed.

```sh
npm run fixtures
cd examples/flutter
flutter pub get
flutter run
```

Choose **Synthetic radiograph**, **2048px detail chart**, or **350-frame ultrasound** to use the bundled files. **Indexed ultrasound** verifies the synthetic file, derives a pinned index, and reopens the verified frames using native range reads. Use the folder button to open a file from your device. Choose **300-slice CT** or **300-slice MR** and **Volume** for axial, coronal, sagittal and oblique reformats, average and MIP slabs, and independent W/L and palette. To reopen measurements, copy the measurement JSON, reopen the same source, and select **Paste measurements**.

## Profile acceptance

Use the same physical device, display refresh setting, power mode and Flutter profile for each comparison. Record the hardware model, OS version and renderer. Keep the app visible and the screen awake for the entire cine run. The packaged source can be used as the Flutter path dependency in the same example directory structure.

```sh
# From the RayKit root.
npm run fixtures
raykit_revision=$(git rev-parse HEAD)
cd examples/flutter
flutter pub get
flutter devices
flutter run --profile -d DEVICE_ID -t lib/acceptance.dart \
  --dart-define=RAYKIT_COMMIT="$raykit_revision" \
  --dart-define=RAYKIT_DEVICE="DEVICE_MODEL" | tee raykit-device.log
```

The target runs five repetitions, a 600-second continuous source-timed cine, and a four-panel close/reclamation check. `--dart-define=RAYKIT_SOAK_SECONDS=30` is useful for a smoke run. Expected stdout contains all numbered `RAYKIT_ACCEPTANCE` JSON chunks and no `error` field. Concatenate the chunks in order to parse the report. The 2048px chart's two display modes report W/L and pose median/p95, copied bytes, and the selected renderer. The scrub finishes on the last target and the last cine sample is `[189,87,75]`. CT and MR return a 512 × 512 × 300 acquisition with the same modality value of 448 at the reference point. The first and last 60 seconds of the 600-second run report presentation intervals and frame timing. A foreground interruption fails the continuous cine scenario. Four panels finish on frames `[349,300,251,202]`.

Also execute the following with the normal viewer in a separate session. Use the same synthetic inputs when running the earlier implementation. Capture profile traces through Flutter DevTools and record the build commit, runtime, renderer, fixture SHA-256, repetitions, medians and p95. [Flutter performance profiling](https://docs.flutter.dev/perf/ui-performance)

1. Open the detail chart. Select **Window / level** and drag across the low-contrast steps and line pairs. Change palette or invert. Pan, zoom and rotate, then sample the same landmark. Compare CPU with **16-bit shader** on the current build while keeping the selected source, viewport and gestures fixed. Record the actual renderer, copied bytes and drawn frames.
2. Open **350-frame ultrasound**. Drag forward, reverse direction, and release at frame 350. Query the displayed frame before and after reopening with **Indexed ultrasound**. Record drop counts, release-to-exact-frame latency and peak memory. Play at 1× for ten foreground minutes. Use the device's system tools to record thermal state or energy if an instrument is available and note its method.
3. Open a 300-slice CT, then MR. Compare axial navigation, sagittal or coronal reslicing, oblique MIP, and W/L on the same MIP. Record the timings separately. Begin a new plane while another is preparing and confirm the display finishes on the last selection.
4. Place and reopen a measurement, then background the app and return. Confirm the same source digest, displayed frame and anatomical placement after reopening. Close the viewer and check native handles and memory. During the four-panel run, close or pause one panel and verify the other panels keep their own source and frame state.

Physical iPhone and Android profiles, including thermal, energy and screen behavior, require separate device evidence. Linux, an APK or a Rust target check can verify parts of the distribution and runtime contract. See the current [platform evidence](../../docs/support.md#platform-and-installation-evidence).

## Desktop

From the repository root prepare fixtures, then package from the host OS.

```sh
npm run fixtures
npm run package:desktop
```

Install the Flutter desktop build tools for the selected host. Linux uses CMake, Ninja, clang and GTK 3. macOS builds a native app bundle with Xcode. Windows uses Flutter's Visual Studio desktop toolchain and emits the executable with its runtime data and libraries. Extract the matching archive and run `raykit_example`, `raykit_example.exe` or `raykit_example.app`. Keep the directory contents together.

Open a local file or a study folder. Drop one file or folder on the app to use the corresponding open path. The series picker uses the actual DICOM series. Within a coherent orientation, slices sort by their patient-plane positions. Select an instance or use **Volume** to assemble the selected acquisition. **Compare same source** starts at the current original frame. **Compare study series** opens another acquisition from the same local study for independent review. Registered cross-series pointing is available to SDK hosts that supply a verified source pairing. Use **Save measurements** and **Open measurements** in the **Measurements** menu to round-trip JSON against the matching source.

Pass the path as the app's sole argument to open it automatically. The local Linux acceptance command exercises the normal app entry and exits after the requested rendered frame and sample are verified.

```sh
raykit_example --verify comparison-ct.dcm 150 256 256
```

The expected sample is 474 stored, 448 HU at patient point `[179.2, 204.8, 180.0]`. Append a previously generated measurement JSON path to reopen that record against the requested source frame and include the recomputed result. The guide's cross-language probe uses a 7 mm ruler. For a visual walkthrough, use **Synthetic cases** to open **CT with named windows**, compare the two windows, link the slice controls, sample one point and save then reopen a ruler record.
