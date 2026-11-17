# Developer API

## Named views and comparison

Call `session.views(frame)` or read `frameInfo(frame).views`. A device alternative carries an original index, label and scope. Select it with `{ voi: {kind: 'window', index: 1} }` or the corresponding LUT selector. Manual windows use `window`. The original VOI remains the default. When a panel moves to a frame without the selected alternative, it displays that frame's default. Direct render calls report invalid selections. [DICOM VOI LUT Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.11.2.html)

Apply panel-only display settings independently from pan, magnification and frame selection. A shared source can have one, two or four panels. Open and verify it once, then call `viewport.attach(session, {frame, render})` or use `RayKitSource.attached(session)` with `RayKitComparison`. Each panel owns a lease on the original session. A normal owner close releases one reference. `session.revoke()` invalidates all remaining panels and terminates the worker or native session. Keep leases in the original access context and open a fresh session for a new authorization or revision.

`sampleAt` includes source identity, pixel geometry and the patient point when defined. CT reports HU for a valid declared HU rescale. A verified real-world mapping provides a coded quantity and UCUM unit. The quantitative display uses the mapped range and the hot palette. Padding and values outside the declared mapping domain are masked. Ultrasound preserves the decoded RGB/YBR raster, including any embedded palette legend. Supported spectral regions expose axes from the reference pixel, delta and unit. Color pixels without a declared mapping carry their channel values. [CT transformation](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.15.3.10.html), [Real-world mapping](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.16.2.html), [US region calibration](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.5.5.html)

For cross-series MR, supply a host-verified common-space registration pinned to the two source hashes and revisions. `registerPair` on web and `RayKitComparison.registration` on Flutter check the displayed sources. `locatePatient` then requires a unique in-bounds parallel plane within 0.25 mm. Ambiguous, shifted or independently oriented acquisitions remain individually navigable. CT panels showing one source share its exact frame and pixel centers.

## Custom Worker

The `@raykit/web/worker` subpath is a dedicated module-worker entry. Import it inside the worker and pass the factory to `open`. The host can inspect, decode, render a preview, sample and measure without creating a viewport. The entry speaks the same protocol as the packaged Worker. Close the session when the worker or its source is retired.

```ts
// custom-worker.ts
import '@raykit/web/worker';

// host.ts
const session = await open(localFile, {
  signal,
  workerFactory: () => new Worker(new URL('./custom-worker.ts', import.meta.url), { type: 'module' }),
});
try {
  const frame = await session.readFrame(0, { output: 'rgba', signal });
  const point = await session.sampleAt(0, 10, 10, signal);
} finally {
  session.close();
}
```

Caller buffers remain owned by the caller. Source bytes transferred into the worker are owned copies or fresh Blob reads. Output buffers are independently owned. Abort stops delivery and cancels any active range request. Synchronous decoding can finish in the worker after one panel cancels, allowing another lease to use the result. See [the example](../examples/web/src/delivery.ts) for all five operations.

The scalar baseline engine starts with the worker. JPEG-LS, Extended 12-bit JPEG and wavelet sources load a version-matched advanced engine on demand. Failed downloads return `io` and a new open retries in a new worker. A version mismatch returns `integrity`. Serving both WASM assets and their glue from the same build preserves compatibility.

## Single-response frame proofs

Prepare a complete, verified JPEG Baseline source with `raykit frame-index SOURCE --proof-directory DIRECTORY --revision REVISION`. Each zero-based `N.rkp` contains the required DICOM metadata, original encoded frame span and Merkle proof. The source SHA-256, original byte length, revision, frame count, metadata, frame index and fragment boundaries are bound to the root. Store the returned root in an authorized catalog or deliver it over a trusted channel. Treat the packets as source data with the same access restrictions.

```ts
const source = frameProofHttp('/study/frame-proofs/', { rootSha256, revision }, { firstFrame: 0 });
const session = await viewport.load(source, { expected_sha256: fullSourceSha256 });
```

The worker fetches the first requested packet and verifies it before it can present the original. Subsequent packets are loaded on demand. `pinned_frame_proof` records this verification mode. Keep `indexedHttp` and `indexedBlob` for flat indexes. When the trusted identity consists of the full-source SHA-256, open the full source with that pin. Dependent streams retain host decoder keyframe requirements.

## Tiled projections

`raykit tiles SOURCE --frame 0 --directory DIRECTORY --revision REVISION` prepares a monochrome projection from a verified full source. It writes independent lossless stored sample tiles and a pinned manifest. The source reference, display transform and projection calibration stay attached to that representation. The manifest is written after the tiles. Pass its SHA-256 and revision to `openTiled`. Read a region, sample coordinates or measure through the returned `TiledSession`. `TiledViewport` reads the visible region plus interpolation neighbors, uses a 16 MiB tile cache, and fences fast pan/zoom updates.

Tile preparation decodes the source once and creates derived storage. Ordinary DICOM files continue through the full or indexed frame paths. Static hosts can serve generated tiles and frame proofs with separate authorization. Measurement records from verified tiles reopen against the original full source.

## Live sources and sharing

`ProgressiveSeries` accepts authorized instance revisions with optional acquisition times. `LiveSeries` follows new acquisitions, freezes a current original and keeps a count of unseen members. Add late events with their original identities after reconnect. Acquisition order and volume slice order use distinct inputs.

`LiveViewport` accepts host-decoded frames through an async iterable. `mediaStreamSource` adapts a supplied MediaStream, including one from a WebRTC receiver. `RayKitLiveController` accepts a Dart stream of bounded RGBA images in its monotonic arrival clock. Keep sequences monotonic across reconnects in the same live revision. The application owns and stops its transport or media tracks. Freeze records the last presented frame and survives normal end or temporary disconnect. Age is elapsed local time from arrival. The host can reconnect with missing original instance records.

Original binding needs the exact acquisition and frame identity and an authorized original file pin. A matching clock value alone leaves the preview in its preview state. When a bound file has physical calibration, RayKit can show the exact frame and enable the corresponding measurement tools. Revoke or replace a source by closing its live controller and source session.

The v1 `SharedView` envelope carries instance, frame, content hash, revision, camera and display settings. Each receiver checks its authorization callback and monotonic sequence before applying the request. Transport stays with the application. The Flutter `RayKitSharedView` accepts the same envelope.

## Sessions and ownership

`inspect` reads a Part 10 source using the same limits and parser as `open`. The inspection reports the image profile, geometry hint and available operations. Opening a source returns an opaque session. `readFrame` takes a zero-based index. `sample` returns the source sample and, for monochrome, the modality value and padding classification. `render` applies the view options to the same stored samples. The distinction affects cine, window changes and measurements.

| Input | Ownership at the package boundary |
| --- | --- |
| Local file, byte array or host reader | The SDK takes a bounded copy. Supply an expected byte length, SHA-256 and revision when the host has authoritative values. The complete digest is checked before dataset parsing. |
| TypeScript output | A caller-owned array copied from WASM. Its lifetime is independent of changes to WASM linear memory. Worker transfers avoid a second structured-clone copy. |
| Dart output | The isolate copies a C response before releasing its buffers. It sends transferable Dart memory to the caller. |
| C output | The application releases each returned pointer and length with `raykit_v1_free`. The handle is an integer token. `raykit_v1_close` retires the token, and an in-flight call keeps a reference through completion. `raykit_v1_live_sessions` and `raykit_v1_live_buffers` expose process-wide ownership counters. |

On web, opening a source checks the configured limit and any available length before starting the dedicated Worker. The Worker initializes WASM while the input is read. It computes SHA-256 through Web Crypto over the parser's owned bytes. If Web Crypto is unavailable, Rust hashes the same bytes in 16 KiB chunks. By default the expected digest is compared before dataset parsing. `prepare_first_frame` enables bounded speculative preparation of a JPEG Baseline frame while Web Crypto works. The open reply, presentation and measurement still depend on completed source verification. [Web Cryptography API](https://w3c.github.io/webcrypto/#SubtleCrypto-method-digest)

Use the package cancellation token or `AbortSignal` when selecting frames. Pending work can be removed before dispatch. One synchronous decoder invocation can finish after cancellation. The package discards its result. `close` terminates the source worker on web and queues native release after the active call on Flutter. Applications should close sessions when access expires. `presented` identifies the frame after drawing to the active canvas or Flutter rendering surface. The event is an application drawing observation. Screen refresh and GPU queue completion require separate instrumentation.

The default per-source limits are 192 MiB input, 192 MiB inflated dataset, 16 Mi pixels per frame, 4096 frames, 100,000 dataset elements and 65,536 fragments. Nested datasets are bounded at 24 levels. The default cache keeps two frames, within a 64 MiB ceiling. An active frame remains available for view changes. Encoded frames are limited to 32 MiB. The wavelet subset caps the output at 4 Mi pixels, limits tile and layer structure, and validates SIZ and COD before decoder entry. Diagnostic counters report retained source and decoded arrays, frame-index bytes, completed decode attempts, fragment copies and output copies. WASM reports its linear-memory capacity, which already includes Rust-owned allocations.

Browser and device hosts control credentials and access to files. DICOMweb requests accept explicit endpoint and header providers. The default network adapter omits cookies and declines redirects. The offline viewer operates on local inputs, and the SDK has no telemetry endpoint.

### Native files and verified frame indexes

`RayKitSource.file(File(path))` opens a regular file in Rust on the session isolate. The file length and change stamp are checked on the same open descriptor. Full open reads directly into the owned parser snapshot and closes the descriptor after reading. The byte and stream constructors remain available. `RayKitSource.descriptor(fd)` accepts a borrowed Unix descriptor. Keep it open until the open future settles. RayKit owns a duplicate, uses position-independent reads and releases the duplicate at the end of its reading lifetime. A source permission revoked by the host should close the session. Seek/read errors or a changed stamp reject new reads. Previously verified snapshot data stays bound to its original digest.

`createFrameIndex` produces an opaque manifest and its SHA-256 from a fully read JPEG Baseline source. The manifest binds the full source digest, transfer syntax, length, metadata, and ordered fragment spans and per-frame digests. It contains the source's non-pixel DICOM metadata. Store it with the same access controls as the source. Supply a pin kept by the consuming application from an earlier validated open or delivered by an authenticated publisher. A hash supplied alongside an untrusted remote manifest does not authenticate it. A full source SHA-256 supplied on its own requires reading every source byte. [DICOM encapsulated pixel data](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.4.html)

Pass `indexedBlob(file, index)` or `indexedHttp(url, index, { etag, headers })` to `open` or `RaykitViewport.load`. On Flutter, pass `RayKitSource.indexedFile(file, index)` or a descriptor with an index. `inspection.verification` reports `full_source` or `pinned_frame_index`. The indexed path verifies the requested span before decoding. Source references use the full source digest bound by the trusted index. Opening with a pin supplies proof of the indexed representation and each range that is actually read. A source revision can still carry an application-specific label alongside the immutable content digest.

HTTP reads send `Range` and `If-Match` for a strong ETag. A `206` must match the requested bounds and full source length. Cross-origin servers must allow the request headers and expose `ETag` and `Content-Range`. A `200` with the same ETag may fall back to a full read within the verified length, followed by full source hashing before presentation. A changed ETag, oversized or short body, conflicting expected hash or corrupt span rejects the operation. Each panel cancels its own pending range work. Independent JPEG frames use one span per read even when a frame has multiple fragments.

## Geometry and display

`PixelPoint` is measured from the center of the top-left source sample. `ScreenPoint` uses viewport coordinates. `PatientPoint` uses the DICOM patient space in millimeters. `transform` applies a viewport and returns the source coordinate and, when available, the patient coordinate. Detector spacing can affect display aspect. Physical projection measurements require an explicit calibration type or a corrected pixel spacing that differs from detector spacing. Ultrasound measurements require a single applicable 2D region with length units on both axes. Patient orientation labels depend on the anatomical orientation type and quadruped region. [DICOM Image Plane Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html), [Pixel spacing calibration](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_10.7.html), [Ultrasound Regions](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.5.5.html)

The monochrome CPU path applies stored bits, a modality LUT or scalar rescale, the selected device VOI or window, presentation polarity and a palette. Large integer frames with narrow stored ranges use a bounded lookup table with the same output as the direct mapper. Padding is kept outside automatic windowing. Fractional MPR samples use the continuous mapper. WebGL2 uses 16-bit integer textures and interpolates reconstructed stored samples before windowing. A viewport reuses its program across source replacement and releases the previous pixel storage before opening the next source. It reuses same-size texture storage across compatible frames. LUT display uses the CPU path. CPU drawing scales with nearest-neighbor sampling. Native YBR samples retain their color-space label. The Baseline JPEG color decoder returns decoded RGB. [DICOM VOI module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.11.2.html)

The cine controller uses the timing vector or uniform Frame Time when present. Missing timing uses a 15 fps source cadence. The viewer's speed control scales these intervals. `showFrame` on web and `seek` on Flutter request an exact frame. Continuous input uses `scrubFrame` or `scrub`, with one in-flight visible request and one replaceable target. Superseded pending futures finish with `cancelled`. `settle` stops playback and prioritizes the last target. Flutter's `play()` completes normally when this stop supersedes the active cine draw. Its controls show the active rate, including values supplied by the application. `samplePresented` and point mapping use the matching drawn frame and transform. Dependent MPEG/AVC/HEVC sources can supply a continuous recognized media container to the host decoder. The host supplies frame timing and determines its random-access cost.

The Flutter viewer sends the current W/L with the frame request and retains one raster for the displayed frame. Pan, zoom and rotation reuse it. Saved marks and draft landmarks have their own paint layers. `RayKitDisplayMode.shader` opts in to a precision-probed fragment program for supported scalar monochrome windows. It reconstructs exact stored 16-bit samples from two opaque byte channels before presentation. The active texture is reused for W/L, polarity and palette. LUT display and precision-sensitive or unsupported profiles use the Rust CPU render. The automatic policy uses that reference until physical-device qualification establishes a shader performance policy. Both Flutter raster paths use nearest-neighbor display sampling. Original sample and measurement queries run in Rust. [Flutter fragment shaders](https://docs.flutter.dev/ui/design/graphics/fragment-shaders)

## Volumes and interchange

Open a primary CT/MR source and append any additional files with `addVolumeSource`. Call `volumeCandidates`, choose an available acquisition and pass the candidate index and revision to `buildVolume`. The selection snapshots an affine ordered by patient-plane position. Repeated instance bytes are deduplicated and conflicting content under the same instance UID is rejected. Gaps, unsupported dimensions and incoherent geometry leave the ordinary frame workflow usable. `voxel_bytes` is the logical float32 size. The selected acquisition shares immutable sources and loads only the slices touched by sampling. The 512 × 512 profiles use up to 16 MiB of cached modality slices. An acquisition with wider slices can need two full slices for interpolation. The retained encoded sources, display raster, decoder workspace, reslice scratch arrays and output transfer have separate limits and diagnostics.

`reslice` accepts a patient-space center, size and spacing, and an axial, sagittal, coronal or explicit oblique basis. A sliced traversal reuses interpolation neighbors and yields to cancellation between work units. Only complete results are returned. The result contains its own patient plane and either float32 modality values with NaN for unavailable samples or RGBA for the selected window. The default interpolation is trilinear. `sampling: 'nearest'` selects nearest voxels. Slabs support a sampled average or maximum. Aligned full-grid nearest-neighbor slabs can reuse block maxima for sufficiently thick MIPs within the existing slice cache budget. One active plane per built acquisition retains unpacked modality values. Window, palette and inversion reuse it. Geometry, output dimensions and spacing, sampling, slab, changed source membership and rebuilding the candidate invalidate it. Check `plane_cache_hits`, `plane_cache_bytes`, `plane_work_bytes`, and `volume` under `stats()`.

| Object | Supported subset |
| --- | --- |
| DICOMweb | QIDO-RS instance query for a known study and series. WADO-RS single-instance `application/dicom` and single-part `multipart/related`. The source's three UIDs are checked at open. |
| SR | One calibrated two-point distance in Comprehensive SR. The TID 1500/TID 1501 document carries a TID 1400-style numeric distance, UCUM millimeters and a SCOORD `POLYLINE`. RayKit stores an optional source digest extension. An external report without a digest requires an explicitly verified source hash. Other methods use portable JSON. |
| SEG | Native `BINARY` pixel data, a chosen segment, same-size display matrix, matching class/instance/frame and preserved spatial locations. When patient coordinates exist, the planes must match. Fractional and labelmap objects, registration and resampling are outside this profile. |
| Grayscale presentation state | Explicit referenced image or frame, full-frame scale-to-fit area, quarter-turn rotation, presentation polarity and a supported VOI window with an identity modality transform. Graphic annotation, shutters, cropping, flip and presentation LUT sequences are outside this profile. |
| Encapsulated PDF | The host can retrieve the bounded document and decide how to display it. |

For adding authorized members, binding a frozen preview and relaying a checked frame selection, see [live sources and sharing](#live-sources-and-sharing).

## Desktop WebViews

Build the web example with `npm run build -w @raykit/example-web`. Keep the generated HTML and assets together. The embedded page uses the same public TypeScript entry points as a browser page.

- In WebView2, map the built folder to a dedicated application origin through `SetVirtualHostNameToFolderMapping` with cross-origin access denied. Navigate the initialized control to that origin's `/index.html`. The dedicated worker script and WASM module belong to the same origin. [Microsoft WebView2 local content](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content)
- In WKWebView, serve the build on an application-controlled HTTP origin bound to loopback or on an application-controlled HTTPS origin. Load it with a `URLRequest`. Serve JavaScript as JavaScript and WASM as `application/wasm`. [Apple WKWebView](https://developer.apple.com/documentation/webkit/wkwebview)

The host controls file access and any authenticated remote requests. Runtime evidence for each WebView and browser is listed in the [support matrix](support.md).
