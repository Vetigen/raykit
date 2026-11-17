# Imaging benchmark

The scheduled workflow exercises the packaged scalar SDK in headless Chromium.
Its artifact records first verified draw, cine seek p95 and dropped frames,
sampled renderer RSS, WASM sizes, and axial, coronal and sagittal MPR. Results
identify the commit, browser, engine, fixtures and runner image. Compare
timings as trends on the shared runner. Stored samples, rendered window
digests and calibrated measurements are exact acceptance gates.

## Standalone delivery

Use Node.js 24 or later, Python 3.11 or later, Docker for native Linux
packages, Flutter and compatible local Chromium. The examples and these probes
use generated DICOM files and loopback HTTP. Set `RAYKIT_CHROMIUM` if using a
system Chromium. Run from the checkout root.

```sh
npm ci
npm run fixtures
npm run fixtures:delivery
npm run package:local
npm run package:native
npm run build -w @raykit/example-web
mkdir -p benchmarks/results
node tests/packaged-workflows.mjs
RAYKIT_PREP_REPEATS=6 RAYKIT_NATIVE_EVIDENCE_DIR=benchmarks/results/delivery-native \
  node tests/native-delivery.mjs > benchmarks/results/native.json
node tests/web-delivery.mjs > benchmarks/results/web.json
RAYKIT_COMPARISON_REPEATS=12 node tests/web-comparison.mjs > benchmarks/results/layouts.json
RAYKIT_REMOTE_REPEATS=6 node benchmarks/remote-proof.mjs > benchmarks/results/remote.json
```

The comparison probe checks stored samples, both RGBA hashes, the recovered ruler record and a single source read and decode for each panel count. The reference comes from pydicom's independent RLE decoder, VOI computation and DICOM pixel spacing. The package probe feeds CLI and Node proof packets to the web example and compares the CT sample with NumPy and the native viewer. The live probe exercises duplicate and late events, reconnect, frozen frame identity and physically calibrated original binding. [Independent CT reference](evidence/comparison-reference.json), [Panel trials](evidence/delivery-comparison.json), [Native consumers](evidence/delivery-native.json), [Proof, tiles and live](evidence/delivery-web.json), [Desktop](evidence/delivery-desktop.json)

Set `RAYKIT_BASELINE_SDK` to the `dist` directory from a previously built `f128339` web package. `RAYKIT_WEB_DIST` defaults to the local scalar split build. Build with `npm run build:web -- --simd` and preserve that `dist` directory separately if measuring the SIMD candidate. Restore the scalar package with `npm run build:web`. Run the engine arms on the same host and renderer with otherwise idle cores. The report identifies the actual Worker, viewport and WASM artifacts by SHA-256.

```sh
RAYKIT_BASELINE_SDK=/path/to/f128339/dist RAYKIT_SIMD_DIST=/path/to/simd/dist \
  RAYKIT_DELIVERY_REPEATS=6 node benchmarks/delivery.mjs > benchmarks/results/delivery.json
npm run benchmark:build
RAYKIT_FIXTURES=benchmark-signed12.dcm RAYKIT_ENGINES=raykit,webgpu \
  RAYKIT_REPEATS=8 RAYKIT_CINE_REPEATS=1 npm run benchmark
```

For the Flutter profile runner, build the acceptance entry point on Linux. It uses source-timed cine followed by a four-panel transition. Run the separate installed-package checks for offline open, exact seek, background/resume, shared leases and references.

```sh
cd examples/flutter
flutter build linux --profile -t lib/acceptance.dart \
  --dart-define=RAYKIT_COMMIT=COMMIT_SHA --dart-define=RAYKIT_SOAK_SECONDS=600
cd ../..
node benchmarks/flutter-linux-profile.mjs > benchmarks/results/flutter-profile.json
```

RayKit reports application drawing events. These clocks exclude physical screen refresh, device capture delay, and audience interpretation. The remote run reports preparation and trusted pin acquisition separately from the requested image bodies and the first verified draw. Its 24 ms application delay and 10 MiB/s loopback are controlled conditions. Device and specialist acceptance is documented in the [support matrix](../docs/support.md) and [paired comparison protocol](../docs/clinical-comparison.md).

### Verified results

Chromium 131.0.6778.33 ran on the same Linux Ryzen 9 9900X host with a 640 × 512 drawing surface and SwiftShader. Each arm used six fresh browser processes. The table gives median and p95 in milliseconds. The first-image clock starts with a ready `File`. W/L timings include the table, output buffer and paint tick. [Timed runs and artifact hashes](evidence/delivery-imaging.json)

| Workload | Earlier `f128339` | Split scalar |
| --- | ---: | ---: |
| Signed first frame, WebGL2 | 33.1 / 65.2 | 25.1 / 33.2 |
| Same viewport and source reopened, WebGL2 | 32.3 / 65.3 | 27.1 / 32.0 |
| Signed first frame, CPU | 67.3 / 139.4 | 57.0 / 67.7 |
| 350-frame cine first original, WebGL2 | 43.1 / 70.3 | 41.5 / 44.7 |
| 2048px linear W/L, CPU, 72 changes | 66.6 / 90.9 | 16.6 / 16.8 |
| 2048px sigmoid W/L, CPU, 72 changes | 83.5 / 99.3 | 16.6 / 18.4 |
| Exact cine seeks, CPU, 36 selections | 33.3 / 33.4 | 16.6 / 26.0 |
| First JPEG-LS open and read, including codec startup | 14.1 / 22.2 | 24.1 / 68.9 |
| 40 mm aligned 512² nearest MIP, first 3 planes | 686.2 / 693.7 | 41.4 / 43.0 |
| 40 mm aligned 512² nearest MIP, next 12 planes | 672.7 / 848.4 | 18.7 / 19.6 |

The CPU 35 fps run drew 60 then 70 frames in two seconds at the median, with 9 then 0 skipped. The WebGL2 median drew 70 in both arms. In the scalar arm, the p95 was 4 WebGL2 skips. Exact WebGL2 seek p95 was 16.8 then 18.2 ms. The 40 mm MIP values matched byte for byte. Its active modality cache, including summary planes, stayed within 16 MiB. The general oblique and trilinear paths keep their existing sampling behavior. A separate 40-input scrub run against `dacd04d` showed 1 then 19 distinct intermediate frames at the median. Release p95 was 17 then 25 ms in that run. [Scrub and memory trials](evidence/delivery-scrub.json)

The baseline WASM was 1,817,582 bytes in the timed split build. The selected JS and WASM assets listed in the evidence total 546,433 bytes with gzip before the first advanced codec request, compared with 603,956 bytes in the earlier package. The JPEG-LS fixture triggered the separate 2,231,206-byte advanced WASM. The HTTP correctness run also checked recovery after a failed download and refusal of a mismatched engine. The scalar build remains the default. SIMD improved some of the cine timings in this profile. The WebGPU candidate's eight signed-radiograph opens had a cold median/p95 of 24.4/33.9 ms, with 26.5/33.3 on WebGL2 in that paired run. The same-page medians were 30.7 and 23.1 ms respectively. [Codec requests](evidence/delivery-web.json), [WebGPU candidate](evidence/delivery-webgpu.json)

The comparison fixture is 9,899,384 bytes. Across 12 CPU trials per layout, opening and drawing every panel took 31.8/36.8 ms for one, 31.3/48.1 for two and 38.2/47.1 for four. The reader and decoder each ran once in all 36 trials. The decoded cache held 1 MiB. Each panel got its own 1 MiB RGBA output copy. The final panel release closed the session. [Panel trials](evidence/delivery-comparison.json)

| Remote source profile | Image responses | Body bytes to first original | Verified draw median / p95 (ms) |
| --- | ---: | ---: | ---: |
| Complete file | 1 | 9,766,844 | 993.6 / 1,013.0 |
| Flat index and first range | 2 | 66,198 | 97.5 / 100.5 |
| Frame proof packet | 1 | 28,000 | 63.6 / 64.6 |

The remote timings begin with the pin ready. Each arm had six trials. The separate 201-byte pin fetch took about 26 ms at the median in this setup. Six local CLI runs measured 19.2/20.1 ms for flat index preparation and 18.6/19.0 ms for the first proof. Producing all 350 packets, including writes, took 2.25/2.91 seconds and 10,086,220 bytes. The complete tiled projection took 512.5/922.7 ms and 16,782,295 bytes to prepare. The first tested region straddled four tile boundaries and read 1,053,655 bytes including the manifest. Its output and measurement agreed with the original. [Network timings](evidence/delivery-remote.json), [Preparation trials](evidence/delivery-native.json), [Boundary tests](evidence/delivery-web.json)

The Linux Flutter development profile lasted 600.01 foreground seconds. It recorded 20,827 drawn cine frames and 172 skips, then reached exact frames 349, 300, 251 and 202 on four panels. The first and last minute draw interval p95 values were 33.8 and 34.1 ms. CPU and packed shader window p95 values were 33.9 and 17.3 ms for the same chart. Sampled RSS was 180 MiB before, 538 MiB at the sampled high point during the run, and 567 MiB immediately after panel close. The post-close process RSS includes retained allocations. Separate widget tests verify that the native handle count returns to its starting value. [Profile run](evidence/delivery-flutter-profile.json)

## Historical browser and renderer comparisons

Each repetition launches a fresh browser process and page for the cold opening. The warm opening uses the same page with a new viewport and a fresh source. The runner checks the generated Part 10 file against the fixture SHA-256 before handing a `File` to any engine. Module import and fixture preparation each have their own elapsed time. The first-original and full-series timers share the instant the `File` is ready.

```sh
npm ci
npm run fixtures
npm run build:web
npm run benchmark:build
npx playwright-core install chromium firefox
RAYKIT_REPEATS=12 RAYKIT_CINE_REPEATS=12 npm run benchmark
cp benchmarks/results/compare.json benchmarks/results/chromium.json
RAYKIT_BROWSER=firefox RAYKIT_REPEATS=5 RAYKIT_CINE_REPEATS=5 npm run benchmark
cp benchmarks/results/compare.json benchmarks/results/firefox.json
```

`RAYKIT_CHROMIUM` selects a local Chromium executable. `RAYKIT_REPEATS` controls radiograph repetitions and `RAYKIT_CINE_REPEATS` controls cine repetitions. `RAYKIT_ENGINES` selects a comma-separated subset. For the before run, use `packages/web/dist` built from SDK commit `5981de9` with `npm run build:web`. Build the benchmark with those artifacts and the current benchmark adapters, then run it with `RAYKIT_ENGINES=raykit`. Rebuild the SDK and benchmark with the optimized source and repeat the same browser, fixture and repetition settings. The reports include fixture and asset hashes. The checkout revision records the base at measurement time. The before and after Worker and WASM hashes identify the measured builds. The same WASM codec profile applies to both SDKs.

The adapters timestamp RayKit `presented`, Cornerstone3D `IMAGE_RENDERED` and DWV `renderend` for the selected source and requested original frame. The WebGPU candidate records its draw submission. Each adapter takes the timestamp before sampling the decoded pixels bound to that draw. A successful run checks the signed sample or RGB tolerance on the initial draw and again during frame selection. Color checks include frames 0, 175 and 349. The signed Cornerstone3D sample is converted back to its stored value when the loader has applied an affine rescale. Separate GPU reference probes use a one-level gray tolerance.

DWV reports full-series time at its `loadend` for the same input after a successful decode. The on-demand engines leave `full_series_ms` empty. Interaction and cine durations use the draw timestamps. The fast-seek test requests 20 positions and cine playback follows a separate 35 fps source cadence. The 60 Hz missed-refresh estimate is derived from intervals between observed draws. Failed openings and fixture mismatches are excluded from latency statistics and reported as failures. The events record application drawing. Physical screen refresh and GPU queue completion need device instrumentation.

Chromium on Linux records process RSS with CDP and `/proc` every 50 ms. The renderer total includes dedicated workers and is measured separately from the browser and GPU processes. A short-lived allocation can fall between samples. GPU texture sizes are estimates and WASM capacity already includes the input, decoded buffers and decoder scratch. The Firefox and WebKit reports include timing and sample checks. The Chromium RSS sampler leaves their RSS fields empty.

The DICOM fixtures are generated by `cargo run --locked --release -p raykit-core --example generate-fixtures -- fixtures/generated --long-cine`. `benchmark-signed12` uses a conventional High Bit and sign extension in the allocated word. Additional `signed12` files exercise nonstandard historical packing. No real imaging records are used.

DWV and Cornerstone3D are benchmark-only npm dependencies. The benchmark build copies DWV's published decoder worker scripts to the URL expected by its loader. The WebGPU program is a monochrome comparison candidate. Its benchmark requires a WebGPU-enabled Chromium profile. The default SDK renderer supports WebGL2 with a Rust CPU fallback.

Use `RAYKIT_BROWSER=webkit` on a host with the matching Playwright browser and system libraries. The measurements here use Playwright WebKit 18.2 with the Ubuntu 24.04 libraries in its container.

```sh
npm run build -w @raykit/example-web
mkdir -p benchmarks/results
docker run --rm --init --network none --shm-size=1g \
  --user "$(id -u):$(id -g)" --workdir /raykit \
  -v "$PWD:/raykit:ro" -v "$PWD/benchmarks/results:/raykit/benchmarks/results" \
  -e RAYKIT_BROWSER=webkit -e RAYKIT_REPEATS=5 -e RAYKIT_CINE_REPEATS=5 \
  mcr.microsoft.com/playwright:v1.49.1-noble \
  sh -c 'node tests/web-source-open.mjs && node benchmarks/compare.mjs'
cp benchmarks/results/compare.json benchmarks/results/webkit.json
```

## Codec cost and WASM variants

```sh
cargo run --release --locked -p raykit-core --example decode-memory -- \
  fixtures/generated/{cine-350,jpeg-extended-12,jpeg-lossless,jpeg-ls,jpeg-2000-lossless,htj2k-lossless}.dcm
npm run build:web -- --baseline
npm run benchmark:build
RAYKIT_WASM_VARIANT=baseline RAYKIT_ENGINES=raykit npm run benchmark
npm run build:web -- --simd
npm run benchmark:build
RAYKIT_WASM_VARIANT=simd RAYKIT_ENGINES=raykit npm run benchmark
npm run build:web
```

The baseline-only build omits JPEG Extended 12-bit, JPEG-LS and the wavelet codecs. Use `npm run build:web -- --eager` to put those codecs in the first WASM module. The default entry loads a smaller baseline engine, then imports the version-matched advanced module for files that require it. The SIMD build tests Rust compiler auto-vectorization. Each command rebuilds the generated web bindings. The final command restores the default package. `browserCapabilities()` reports browser SIMD and shared memory independently. The default web package uses one scalar worker per loaded source.

The native heap example records requested Rust heap bytes before, during and after each cold frame decode. The frame cache is cleared between samples. Peak bytes above the retained allocation estimate transient decoder work. The counters exclude allocator overhead and the operating system's allocation behavior.

For dependent video, use a local FFmpeg build that includes `libvpx-vp9`. The runner generates a VP9 clip with the same analytic frame colors and dimensions. It validates the host player's observed frame and samples at the requested times. MPEG/AVC/HEVC DICOM handoff is a separate profile.

```sh
RAYKIT_FFMPEG=ffmpeg node benchmarks/dependent-video.mjs
```

## Independent workflows

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run fixtures
npm run package:local
npx playwright-core install chromium firefox
npm run build -w @raykit/example-web
node tests/web-source-open.mjs
node tests/web-workflow.mjs
node tests/web-conformance.mjs
RAYKIT_BROWSER=firefox node tests/web-source-open.mjs
RAYKIT_BROWSER=firefox node tests/web-workflow.mjs
RAYKIT_BROWSER=firefox node tests/web-conformance.mjs
node tests/packaged-workflows.mjs
uv run --no-project --with pydicom==3.0.2 --with highdicom==0.29.0 \
  --with pylibjpeg --with pylibjpeg-libjpeg --with pylibjpeg-openjpeg --with pyjpegls \
  python tests/dicom_reference.py
(cd packages/flutter && flutter pub get && flutter test --concurrency=1 test/native_workflow_test.dart)
(cd examples/flutter && flutter build apk --debug --target-platform android-arm64)
cargo +1.97.1 check --locked -p raykit-ffi --target aarch64-apple-ios
```

The last two checks require their corresponding Android SDK/NDK or installed Rust target. To run the iOS app, use Xcode on macOS and the standalone Flutter example.

The source-opening test runs the normal SDK and viewer with Web Crypto enabled and with `crypto.subtle` removed in the actual Worker. It verifies source identity, original pixels, one WASM instance, initialization during a held read, input limits, digest mismatch, abort, replacement and cleanup. The original verification records also include independent DICOM reference results, native geometry extension output, local archive digests and Android binary inspection. [Workflows](evidence/workflows.json), [Package checks](evidence/package-verification.json)

## First original draw on Chromium

The before and after runs used Linux x64, Ryzen 9 9900X, headless Chromium 131.0.6778.33 and SwiftShader, with a 640 × 512 viewport and device scale 1. Each row contains 12 cold and 12 same-page openings. Latencies are median / p95 in ms. RSS is median / p95 in MiB across per-run sampled renderer peaks. A p95 uses the nearest rank. The recorded source and pixel checks passed in every run. [Chromium observations](evidence/first-original-chromium.json)

| Engine | Fixture | Cold first original | Same-page first original | Cold full series | Renderer peak RSS |
| --- | --- | ---: | ---: | ---: | ---: |
| RayKit WebGL2 before | Signed radiograph | 32.0 / 38.6 | 29.9 / 33.9 | — | 197.1 / 206.4 |
| RayKit WebGL2 after | Signed radiograph | 32.7 / 40.7 | 29.9 / 35.0 | — | 197.7 / 205.2 |
| WebGPU candidate | Signed radiograph | 20.2 / 31.6 | 29.9 / 30.9 | — | 191.9 / 192.8 |
| DWV | Signed radiograph | 7.1 / 7.8 | 1.5 / 1.7 | 7.5 / 8.1 | 193.8 / 194.7 |
| Cornerstone3D | Signed radiograph | 115.4 / 119.1 | 62.7 / 64.7 | — | 224.9 / 227.7 |
| RayKit WebGL2 before | 350-frame US | 235.0 / 243.1 | 227.0 / 235.2 | — | 330.2 / 332.0 |
| RayKit WebGL2 after | 350-frame US | 54.9 / 60.7 | 55.0 / 64.3 | — | 332.9 / 338.6 |
| DWV | 350-frame US | 101.4 / 122.5 | 148.0 / 171.9 | 1,691.4 / 1,763.6 | 2,214.9 / 2,276.5 |
| Cornerstone3D | 350-frame US | 164.0 / 172.7 | 90.7 / 104.5 | — | 966.5 / 987.4 |

Cold cine module import medians after the change were 2.8 ms for RayKit, 35.4 ms for DWV and 94.9 ms for Cornerstone3D. Preparing and verifying the input `File` took 22.6, 22.8 and 23.1 ms respectively. The first-original timings start after both phases.

RayKit's rapid cine seek p95 was 17.1 ms before and after, across 240 requests per build. DWV and Cornerstone3D recorded 41.9 ms and 33.3 ms. RayKit's initial Worker frame read and output took 12.1 ms median before the change and 11.9 ms after it. The median sampled renderer peak rose by 2.6 MiB and remained below the other tested cine engines. RayKit's Worker made one 9,766,844-byte copy into WASM, and retained two cached RGB frames totaling 6,879,600 bytes after the three frame checks. The browser's Web Crypto implementation can snapshot the input transiently. The WASM asset grew from 1,646,268 to 1,693,909 bytes and from 536,812 to 548,849 bytes with gzip.

## Firefox and Playwright WebKit

Each row contains five cold and five same-page openings. Firefox 132.0 used RayKit's CPU renderer on the Linux host. Playwright WebKit 18.2 used RayKit WebGL2 in the Ubuntu 24.04 container. First-original latencies are median / p95 in ms. The cine seek p95 uses 100 requests per build. The reports include the same draw and pixel checks for DWV and Cornerstone3D. [Firefox observations](evidence/first-original-firefox.json), [Playwright WebKit observations](evidence/first-original-webkit.json)

| RayKit profile | Fixture | Cold before | Cold after | Same-page before | Same-page after | Seek p95 before → after |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Firefox CPU | Signed radiograph | 33.0 / 36.0 | 26.0 / 48.0 | 47.0 / 48.0 | 47.0 / 47.0 | — |
| Firefox CPU | 350-frame US | 241.0 / 244.0 | 91.0 / 102.0 | 232.0 / 237.0 | 82.0 / 83.0 | 59.0 → 59.0 |
| Playwright WebKit WebGL2 | Signed radiograph | 38.0 / 72.0 | 37.0 / 73.0 | 30.0 / 31.0 | 30.0 / 31.0 | — |
| Playwright WebKit WebGL2 | 350-frame US | 107.0 / 138.0 | 76.0 / 107.0 | 94.0 / 104.0 | 61.0 / 61.0 | 17.0 → 17.0 |

## Bounded imaging and continuous input

`imaging.mjs` runs the same generated source bytes in two installed web distributions. The baseline distribution is the package built from `dacd04d94fdb06f6a3c18afe2d5d958feb403090`. The runner checks its WASM digest. Use `RAYKIT_BASELINE_SDK=/path/to/extracted/package/dist` to point to that package. It alternates the build order by repetition and opens a new browser for each trial. The 40 drag targets arrive at 8 ms intervals independently of frame completion. Forward drag and direction reversal are recorded separately. Release-to-exact-draw, unique intermediate frames, decode calls and copied pixels are measured from the same presentation events. Sequential seek and the cold and same-page first draws use the separate `compare.mjs` timing method above.

```sh
npm run fixtures
npm run build:web
npm run benchmark:build
RAYKIT_ENGINES=raykit RAYKIT_REPEATS=12 RAYKIT_CINE_REPEATS=12 node benchmarks/compare.mjs
RAYKIT_IMAGING_REPEATS=8 node benchmarks/imaging.mjs
RAYKIT_BROWSER=firefox RAYKIT_IMAGING_REPEATS=5 node benchmarks/imaging.mjs
```

To rerun the first-original method on the preserved benchmark distribution for `dacd04d`, set `RAYKIT_BENCHMARK_DIST` to that built folder and `RAYKIT_BENCHMARK_REVISION` to its commit. Both runs use the frame identity and pixel checks before accepting a timing. The independent indexed-sample run distinguishes manifest generation and bytes from source bytes read. Its HTTP source is served over local loopback with the full length and a stable strong ETag. It measures a verified first draw rather than inferring latency from the size of the range. The Web Crypto overlap arm keeps source verification as a prerequisite for every observable frame.

The reslice run compares hashes of the complete small-phantom RGBA images on both builds, including moved planes and five window changes. Axis, oblique MIP, plane move and rewindow times are recorded separately. The large phantom uses 300 RLE slices. Slice cache counters cover decoded modality arrays. The encoded source, working plane, output buffer, WASM reserve and renderer RSS have separate meanings. Renderer RSS is sampled every 50 ms on Linux Chromium. Texture and raster byte estimates cover logical uploaded resources and omit backend scratch allocations.

The Flutter [profile acceptance target](../examples/flutter/README.md#profile-acceptance) measures the same native display and session entry points, records packed shader and CPU results separately, and includes ten foreground minutes of cine. Flutter software raster and Linux profile results have their own runtime labels. The mobile profiles in the support matrix remain open until exercised on physical devices. [Support matrix](../docs/support.md#platform-and-installation-evidence)

### First original frame after the imaging work

The baseline and imaging distributions used the same Ryzen 9 9900X, Linux kernel, Chromium 131.0.6778.33 and SwiftShader profile, with the benchmark pinned to the same eight cores and their SMT siblings. The imaging distribution was built from `e204eac`. Two intervening README-only commits changed the checkout label captured by some runs. The signed-radiograph figures below use a separate alternating sequence of six three-run batches per arm after a variable startup tail in the initial sequential run. First draw timings start when the verified test `File` is available. [Chromium cold and warm observations](evidence/imaging-first-original-chromium.json), [Alternating signed-radiograph observations](evidence/imaging-signed-startup.json)

| Source | Opens per build | Cold before → after (median / p95 ms) | Same-page reopen before → after (median / p95 ms) |
| --- | ---: | ---: | ---: |
| Signed radiograph, alternating batches | 18 | 32.1 / 37.3 → 33.2 / 40.1 | 29.1 / 38.9 → 29.4 / 35.6 |
| 350-frame cine | 12 | 61.5 / 69.5 → 59.0 / 84.6 | 56.4 / 151.8 → 61.8 / 69.9 |

The imaging build stayed within the 100 ms cold cine target in this profile. Cine same-page median increased by about 5 ms in this run while its p95 decreased. Worker first-frame work stayed around 12 ms and the rapid sequential seek p95 was 17.1 ms on both builds over 240 requests each. The raw observations show additional same-page variation with similar Worker decode times. The cine renderer's sampled RSS peak median/p95 increased from 330.0 / 332.3 to 335.4 / 339.2 MiB. The WASM asset grew from 1,693,909 to 1,818,629 bytes, or 548,849 to 584,546 bytes with gzip. [Chromium observations](evidence/imaging-first-original-chromium.json)

Playwright WebKit 18.2 ran five openings per fixture in the Ubuntu 24.04 container. The imaging build's WebGL2 signed cold and reopen medians were 36 and 30 ms. Cine cold and reopen medians were 76 and 61 ms, with p95 of 108 and 64 ms. Real Safari remains a separate acceptance row. [Playwright WebKit observations](evidence/imaging-first-original-webkit.json)

### WebGL startup cost

Creating a viewport used to initialize a WebGL program and textures. Loading a source disposed those resources and the first draw built them again. With `f128339`, the first draw initializes the renderer once. The Worker and WASM digests match `e204eac`. The signed fixture's first Worker frame took 1.4 ms median in each build. [Bundled viewer recheck](evidence/imaging-webgl-recheck.json)

The existing Vite comparison measured 12 openings per source and build in four alternating batches on Chromium 131.0.6778.33, Linux and SwiftShader. The same-page run creates a new viewport. Times start at the prepared local file and end at the first verified draw event.

| Source | Cold before → after (median / p95 ms) | Same-page before → after (median / p95 ms) |
| --- | ---: | ---: |
| Small signed radiograph | 32.4 / 40.6 → 20.4 / 32.4 | 30.3 / 38.8 → 22.3 / 28.3 |
| 350-frame cine | 60.6 / 66.0 → 48.4 / 53.3 | 58.4 / 64.3 → 39.9 / 42.0 |

Cine sequential seek p95 was 16.9 → 17.0 ms across 240 requests per build. Every first draw checked the source SHA, frame index and original sample. This profile measures a local prepared file. Network time and display refresh require separate timing. [Workload and raw observations](evidence/imaging-webgl-recheck.json)

The direct distribution comparison ran 24 repetitions per source and build. It counted two WebGL context requests on the earlier cold load and one on the new load. The cold signed radiograph was 33.5 / 41.0 → 22.2 / 31.1 ms and the cold cine was 59.2 / 62.3 → 46.2 / 62.0 ms. Reopening in the **same viewport** after a 200 ms wait took 16.7 / 19.7 → 24.0 / 31.5 ms for the radiograph and 47.6 / 48.8 → 51.5 / 65.2 ms for cine. [Direct package observations](evidence/imaging-webgl-startup.json)

An instrumented repeat found the extra time in synchronous viewport closure before the next Worker factory call. Median closure was 0.9 → 11.1 ms for the signed fixture and 1.1 → 10.3 ms for cine. Preparing WebGL early during reopen or retaining the renderer program while clearing source textures both left the same-viewport medians above their controls. In a separate Firefox CPU experiment, preparing pixels before an animation callback lowered cold medians by 1.0 and 4.5 ms and raised p95 on both fixtures. [Startup experiments and phase observations](evidence/imaging-startup-experiments.json)

```sh
RAYKIT_STARTUP_BASELINE=/path/to/extracted/e204eac/package/dist \
  RAYKIT_STARTUP_SDK=/path/to/extracted/f128339/package/dist \
  RAYKIT_STARTUP_REVISION=f128339dd8facf8a36de4c2ed617cc5e75c2a76c \
  RAYKIT_REPEATS=24 node benchmarks/cold-start.mjs
```

### Drag, reformat and indexed reads

Chromium used eight repetitions per arm. Firefox 132.0 used five and drew through the CPU path. Latency fields show median / p95 in ms. Intermediate frames and decode calls are medians. [Chromium observations](evidence/imaging-chromium.json), [Firefox observations](evidence/imaging-firefox.json)

| Profile and gesture | Intermediate frames, before → after | Decodes, before → after | Release-to-exact draw, before → after |
| --- | ---: | ---: | ---: |
| Chromium forward | 2 → 18 | 39 → 20 | 14.0 / 16.7 → 15.2 / 22.0 |
| Chromium reversal | 2 → 18 | 39 → 20 | 11.2 / 29.1 → 15.0 / 23.3 |
| Firefox forward | 0 → 5 | 9 → 7 | 88 / 94 → 63 / 73 |
| Firefox reversal | 0 → 5 | 9 → 7 | 85 / 88 → 61 / 67 |

On Chromium's forward drag the median decoded volume was 127.9 → 65.6 MiB. This counts work over all requests during the gesture. A visible in-flight frame can occupy part of one refresh interval when the precise target arrives. The release cost is listed separately from the additional frames shown during motion.

The 512 × 512 small-phantom MIP matched the previous build's RGBA digest on the first plane, moved plane and every tested window. On Chromium, the first MIP was 43.4 / 43.5 → 42.4 / 44.0 ms. Rewindowing it was 43.3 / 43.8 → 1.6 / 1.7 ms. On Firefox, rewindowing was 291 / 293 → 10 / 11 ms. Each rewindow arm measured five changes per trial. [Chromium observations](evidence/imaging-chromium.json), [Firefox observations](evidence/imaging-firefox.json)

| 512 × 512 × 300 CT, 512px output | Chromium median / p95 ms | Firefox median / p95 ms |
| --- | ---: | ---: |
| Build the acquisition | 1.1 / 1.6 | 2 / 2 |
| Axial | 9.6 / 10.5 | 44 / 45 |
| Coronal | 258.9 / 272.7 | 2,480 / 2,490 |
| Oblique MIP | 369.4 / 375.0 | 2,927 / 2,943 |
| Move the oblique MIP | 369.4 / 376.5 | 2,924 / 2,950 |
| Rewindow the same plane | 1.6 / 1.6 | 11 / 12 |

The large RLE CT kept 9,896,334 source bytes, at most 16 MiB of modality slices and 1 MiB of cached plane values in this run. Its logical `f32` volume was 300 MiB. The first axial, coronal and MIP operations differ in their required slices. The Firefox CPU profile still takes seconds to compute a new large reformatted plane. It uses the same bounded cache and yields to cancellation while working. The samples for CT and MR also agreed with pydicom at the known patient point. [Large-volume records](evidence/imaging-chromium.json), [Independent pixel reference](evidence/imaging-reference.json)

The 350-frame JPEG index was 39,124 bytes and took 18.9 / 20.3 ms to build in Chromium. With that trusted manifest available, frame 0, 175 and 349 read 27,074, 29,250 and 28,212 source bytes respectively. The original instance is 9,766,844 bytes. Chromium's first indexed draw measured 42.8 / 46.9 ms from a local Blob and 53.9 / 60.6 ms from loopback HTTP. These reads have different input costs from a pre-materialized full Blob. The full-source Web Crypto overlap experiment measured 41.3 / 47.7 → 37.3 / 45.5 ms on Chromium and 90 / 90 → 82 / 82 ms on Firefox. The overlap remains opt-in for a host that wants speculative JPEG preparation. Failed or cancelled source verification emits no original frame. [Indexed and overlap observations](evidence/imaging-chromium.json)

### Flutter copy and rendering evidence

The same viewer gesture selected W/L on the same 512px RLE CT in both Flutter build trees. Five subsequent seeks each produced two 1 MiB RGBA payloads on the baseline and one 1 MiB payload on the current build. The local-file open on the current build reported zero Dart source staging copies. The first build's Dart-copy counter is unavailable. A 2048 × 2048 RGBA frame occupies 16 MiB per payload. The Flutter test compares ownership and bytes under the same Linux software raster test. [Raw copy measurements](evidence/imaging-flutter-copy-budget.json)

```sh
# Use the same test and generated assets with the unpacked baseline or current Flutter package.
cd examples/flutter
flutter test --concurrency=1 --dart-define=RAYKIT_REVISION=COMMIT_SHA test/copy_budget_benchmark_test.dart
```

The shader checks signed and unsigned input, padding, narrow windows, the detail chart's steps, line pairs and edges, and a quarter-turn at 2×. Its pixels matched the CPU result within one output level on the checked Flutter raster backend. Browser WASM and Dart used the same independent digests for original samples and CPU RGBA. Calibrated ruler, angle, VHS, Norberg and TPLO records reopened against the same source and landmarks. [Independent pixel reference](evidence/imaging-reference.json), [Browser quality results](evidence/imaging-browser-quality.json), [Package verification](evidence/imaging-package-verification.json)

The Linux Flutter 3.44.9 profile app ran on a Ryzen 9 9900X with Xvfb and software GL. Across 60 adjustments on the 2048px chart, W/L latency was 50.2 / 67.0 ms with the CPU raster and 16.9 / 17.4 ms with the packed shader. Both display modes reused the raster for pan and zoom. Five native cine opens measured 49.6 / 50.0 ms for the full local file and 33.3 / 35.1 ms with the pinned index ready. CT and MR first oblique MIP medians were 483.4 and 482.0 ms. Rewindowing those planes took 2.1 ms median and each acquisition peaked at 16 MiB of modality slice cache plus 1 MiB for the cached plane. [Linux profile observations](evidence/imaging-flutter-linux-profile.json)

The `65ca3c4` app completed 600.02 foreground seconds. It recorded 20,999 cine frames and zero scheduler skips. The first and last minutes recorded 2,100 and 2,101 presentations, with p95 intervals of 34.2 and 33.8 ms. The display counters accumulated 96,347,817,760 image upload bytes over the run. The following transition to four panels exposed a controller detachment race. The `5fe1ffe` profile reran that transition, landed at frames `[349,300,251,202]` and closed all panels. The widget test also returned native session counts to their starting value. The separate four-panel run sampled a 639 MiB process peak and 639 MiB immediately after close. The RSS includes retained process allocations and renderer memory. [Linux profile observations](evidence/imaging-flutter-linux-profile.json)

## Historical comparison

The earlier Chromium report at `38577b6` timed the adapter's return and an additional animation tick in `first_ms`. DWV returned at `loadend` after loading the entire series. On the 350-frame cine its cold median through the additional tick was 1,659.2 ms. Its separately captured first `renderend` median was 102.0 ms from the adapter's load call. RayKit's 252.8 ms historical median also included the additional tick. The corrected before/after runs timestamp each engine's draw event and validate its original frame. [Historical raw comparison](evidence/chromium-comparison.json)

### Historical RayKit cine memory

| Quantity | Observed value |
| --- | ---: |
| Original source and worker input copy, each | 9,766,844 bytes |
| Frame index | 7,000 bytes |
| Native parse and index heap growth, with the source already allocated | 31,152 bytes |
| Active decoded RGB frame | 3,439,800 bytes |
| Two cached RGB frames | 6,879,600 bytes |
| Eight RGB frames, calculated | 27,518,400 bytes (26.24 MiB) |
| Native transient decoding heap above retained data | Up to 2,327,332 bytes |
| Peak bound output buffer | 3,439,800 bytes |
| Cumulative WASM output copies in the three-position comparison, including initial presentation | 13,759,200 bytes |
| Cross-fragment copy bytes with this Basic Offset Table fixture | 0 bytes |
| WASM capacity | 30,998,528 bytes |
| GPU texture estimate | 4,586,407 bytes |

The memory rows overlap. An active frame can share cache storage, source and decoded arrays sit inside WASM memory, and copy counters accumulate across requests. At 0, 175 and 349, the decoded values were `[32,64,63]`, `[207,77,137]` and `[189,87,75]`. On the two uncached selections the worker materialized one frame at a time. The native example measured about 2.2–3.3 ms per cold JPEG Baseline decode. The browser worker measured 7.5–8.0 ms for the uncached middle and last frames, including WASM output materialization. Renderer-backed benchmark selections include a subsequent animation-tick observation, giving 32.4 / 33.1 ms over the three positions. [Native allocations](evidence/native-allocations.json)

### Transfer size and codec choice

The historical WASM profiles used Rust 1.99.0 and wasm-bindgen 0.2.128. The latency columns use the earlier adapter-return and animation-tick method. Gzip sizes use the same Node compression settings. The benchmark's local HTTP server serves uncompressed assets.

| WASM profile | Raw bytes | Gzip bytes | Radiograph legacy open median / p95 | Cine legacy open median / p95 | First cine worker median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline scalar | 1,231,875 | 383,562 | 45.7 / 49.3 ms | 253.1 / 253.9 ms | 11.9 ms |
| Full scalar | 1,646,268 | 536,812 | 43.8 / 49.3 ms | 252.8 / 255.9 ms | 12.4 ms |
| Full SIMD experiment | 1,655,496 | 541,470 | 47.1 / 49.8 ms | 249.7 / 252.5 ms | 9.1 ms |

Bundling the advanced codecs in that build added 414,393 raw bytes, or 153,250 bytes with gzip. The historical local opening results were similar across the codec profiles. The standalone delivery above measures the split transport separately. SIMD reduced first-cine worker time in this historical run. The standard package uses the portable scalar worker. [Baseline comparison](evidence/wasm-baseline.json), [SIMD comparison](evidence/wasm-simd.json)

The measured DWV and Cornerstone3D main chunks were 876,379 and 3,304,442 bytes, or 238,446 and 929,456 bytes with gzip. Those chunks have separate worker and codec assets. The raw benchmark evidence lists the emitted chunks and the document's resource observations.

`dicom-core` and `dicom-dictionary-std` 0.10.0 provide standardized tag and value representation types. The bounded parser and frame index are RayKit code. The runtime uses `jpeg-decoder` 0.3.2 for Baseline and Lossless, `oxiarc-jpeg` 0.4.2 for Extended JPEG, `pure_jpegls` 2.1.0 for JPEG-LS and `openjpeg2-pure-rs` 0.1.1 for the bounded wavelet profiles. Those dependencies build to WASM and native targets and their notices are packaged. The independent pydicom run uses separate decoding implementations, including CharLS and OpenJPEG backends. OpenJPH generates the HTJ2K fixtures. The generated 16 × 16 codec files exercise precision, signedness and interoperation. They provide limited evidence about throughput at clinical dimensions.

### Dependent host video

The generated VP9 clip contains the same 350 analytic frames at 35 fps in a 164,974-byte WebM. FFmpeg inspection confirmed keyframes at each integer second. The browser measured first frame and seek after the clip was in a local Blob. Each accepted observation matched the frame time and the RGB tolerance of seven levels.

| Frame | Distance from previous keyframe | Host video median / p95 | Runs |
| --- | ---: | ---: | ---: |
| 0 | 0 frames | 10.8 / 13.0 ms | 5 |
| 175 | 0 frames | 13.7 / 14.1 ms | 5 |
| 349 | 34 frames | 14.6 / 16.3 ms | 5 |

The video measurements include the host media decoder and its presentation callback. The independent JPEG selections run through the DICOM frame index, Rust decoder and RayKit renderer. Seek cost for dependent video varies with keyframe spacing, decoder and the stream. The tested Chromium build selected VP9 because its media capability query reported support for that codec. [Video observations](evidence/dependent-video.json)
