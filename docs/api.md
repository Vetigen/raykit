# Developer API

## Sessions and ownership

`inspect` reads a Part 10 source using the same limits and parser as `open`. The inspection reports the image profile, geometry hint and available operations. Opening a source returns an opaque session. `readFrame` takes a zero-based index. `sample` returns the source sample and, for monochrome, the modality value and padding classification. `render` applies the view options to the same stored samples. The distinction affects cine, window changes and measurements.

| Input | Ownership at the package boundary |
| --- | --- |
| Local file, byte array or host reader | The SDK takes a bounded copy. Supply an expected byte length, SHA-256 and revision when the host has authoritative values. The complete digest is checked before dataset parsing. |
| TypeScript output | A caller-owned array copied from WASM. Its lifetime is independent of changes to WASM linear memory. Worker transfers avoid a second structured-clone copy. |
| Dart output | The isolate copies a C response before releasing its buffers. It sends transferable Dart memory to the caller. |
| C output | The application releases each returned pointer and length with `raykit_v1_free`. The handle is an integer token. `raykit_v1_close` retires the token, and an in-flight call keeps a reference through completion. `raykit_v1_live_sessions` and `raykit_v1_live_buffers` expose process-wide ownership counters. |

Use the package cancellation token or `AbortSignal` when selecting frames. Pending work can be removed before dispatch. One synchronous decoder invocation can finish after cancellation. The package discards its result. `close` terminates the source worker on web and queues native release after the active call on Flutter. Applications should close sessions when access expires. `presented` identifies the frame after drawing to the active canvas or Flutter rendering surface. The event is an application drawing observation. Screen refresh and GPU queue completion require separate instrumentation.

The default per-source limits are 192 MiB input, 192 MiB inflated dataset, 16 Mi pixels per frame, 4096 frames, 100,000 dataset elements and 65,536 fragments. Nested datasets are bounded at 24 levels. The default cache keeps two frames, within a 64 MiB ceiling. An active frame remains available for view changes. Encoded frames are limited to 32 MiB. The wavelet subset caps the output at 4 Mi pixels, limits tile and layer structure, and validates SIZ and COD before decoder entry. Diagnostic counters report retained source and decoded arrays, frame-index bytes, completed decode attempts, fragment copies and output copies. WASM reports its linear-memory capacity, which already includes Rust-owned allocations.

Browser and device hosts control credentials and access to files. DICOMweb requests accept explicit endpoint and header providers. The default network adapter omits cookies and declines redirects. The offline viewer operates on local inputs, and the SDK has no telemetry endpoint.

## Geometry and display

`PixelPoint` is measured from the center of the top-left source sample. `ScreenPoint` uses viewport coordinates. `PatientPoint` uses the DICOM patient space in millimeters. `transform` applies a viewport and returns the source coordinate and, when available, the patient coordinate. Detector spacing can affect display aspect. Physical projection measurements require an explicit calibration type or a corrected pixel spacing that differs from detector spacing. Ultrasound measurements require a single applicable 2D region with length units on both axes. Patient orientation labels depend on the anatomical orientation type and quadruped region. [DICOM Image Plane Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html), [Pixel spacing calibration](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_10.7.html), [Ultrasound Regions](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.5.5.html)

The monochrome CPU path applies stored bits, modality LUT or scalar rescale, then the first supported VOI window or VOI LUT, presentation polarity and a palette. Padding is kept outside automatic windowing. WebGL2 uses signed integer textures and interpolates reconstructed stored samples before windowing. Modality and VOI LUT display uses the CPU path. CPU drawing scales with nearest-neighbor sampling. Original YBR native samples retain their color-space label; the Baseline JPEG color decoder returns decoded RGB. [DICOM VOI module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.11.2.html)

The cine controller uses the timing vector or uniform Frame Time when present. Missing timing uses a 15 fps source cadence. The viewer's speed control scales these intervals. Dependent MPEG/AVC/HEVC sources can supply a continuous recognized media container to the host decoder. The host supplies frame timing and determines its random-access cost.

## Volumes and interchange

Open a primary CT/MR source and append any additional files with `addVolumeSource`. Call `volumeCandidates`, choose an available acquisition and pass the candidate index and revision to `buildVolume`. The selection snapshots an affine ordered by patient-plane position. Repeated instance bytes are deduplicated and conflicting content under the same instance UID is rejected. Gaps, unsupported dimensions and incoherent geometry leave the ordinary frame workflow usable. The volume limit is 128 MiB of modality voxels, with a separate reslice work budget.

`reslice` accepts a patient-space center, output spacing and axial, sagittal, coronal or explicit oblique basis. It produces float32 modality values with NaN for unavailable samples, or a rendered RGBA slice when a window is supplied. Slabs support a sampled average or maximum-intensity projection. The result carries its own patient plane.

| Object | Supported subset |
| --- | --- |
| DICOMweb | QIDO-RS instance query for a known study and series. WADO-RS single-instance `application/dicom` and single-part `multipart/related`. The source's three UIDs are checked at open. |
| SR | One calibrated two-point distance in Comprehensive SR. The TID 1500/TID 1501 document carries a TID 1400-style numeric distance, UCUM millimeters and a SCOORD `POLYLINE`. RayKit stores an optional source digest extension. An external report without a digest requires an explicitly verified source hash. Other methods use portable JSON. |
| SEG | Native `BINARY` pixel data, a chosen segment, same-size display matrix, matching class/instance/frame and preserved spatial locations. When patient coordinates exist, the planes must match. Fractional and labelmap objects, registration and resampling are outside this profile. |
| Grayscale presentation state | Explicit referenced image or frame, full-frame scale-to-fit area, quarter-turn rotation, presentation polarity and a supported VOI window with an identity modality transform. Graphic annotation, shutters, cropping, flip and presentation LUT sequences are outside this profile. |
| Encapsulated PDF | The host can retrieve the bounded document and decide how to display it. |

`ProgressiveSeries` accepts ordered updates to a host-authorized manifest and reports present and expected counts. A pinned manifest requires each member's original digest and byte length. Hosts can display a preview labeled with its quality and then open the checked original for measurement. Appending an instance preserves the primary session. `SharedView` relays displayed source revision, frame and view settings across explicitly paired viewports and asks the receiving app to authorize each event. The host supplies the transport. `LiveViewport` draws bounded timestamped preview frames from a host-provided async source and drops stale or out-of-order frames.

## Desktop WebViews

Build the web example with `npm run build -w @raykit/example-web`. Keep the generated HTML and assets together. The embedded page uses the same public TypeScript entry points as a browser page.

- In WebView2, map the built folder to a dedicated application origin through `SetVirtualHostNameToFolderMapping` with cross-origin access denied. Navigate the initialized control to that origin's `/index.html`. The dedicated worker script and WASM module belong to the same origin. [Microsoft WebView2 local content](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content)
- In WKWebView, serve the build on an application-controlled HTTP origin bound to loopback or on an application-controlled HTTPS origin. Load it with a `URLRequest`. Serve JavaScript as JavaScript and WASM as `application/wasm`. [Apple WKWebView](https://developer.apple.com/documentation/webkit/wkwebview)

The host controls file access and any authenticated remote requests. Runtime evidence for each WebView and browser is listed in the [support matrix](support.md).
