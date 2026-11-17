# Support matrix

Each row identifies an exercised combination of SOP class, transfer syntax, pixels and runtime. The synthetic [manifest](../fixtures/manifest.json) contains fixture hashes and expected values. A dash marks a capability outside the row's profile. Physical measurements use the calibration recorded for the selected source frame.

| SOP class | Transfer syntax and tested pixel representation | Open and original frames | Cine | Physical measurement | MPR | Export or host handoff | Fixture and runtime evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CR `.1` | Explicit Little Endian, signed 12 in 16 bits, MONOCHROME1, padding and shifted High Bit | Stored samples and modality/VOI/presentation | — | Calibrated projection | — | JSON, supported SR distance | `signed12` in Rust, Chromium, Firefox and Flutter Linux |
| CR `.1` | Implicit Little Endian, Explicit Big Endian and Deflated Explicit Little Endian. Same signed MONOCHROME1 pixel profile. | Original samples and presentation | — | Calibrated projection | — | JSON | `signed12-implicit`, `signed12-big-endian`, `signed12-deflated` in Rust. Deflated in Chromium and Firefox lifecycle tests. Big Endian reopened by Flutter Linux. |
| CR `.1` | RLE Lossless `.5`, unsigned 16-bit MONOCHROME2 | Original byte planes and samples 0, 7, 32768, 65535 | — | Image-space tools | — | JSON | `unsigned16-rle` in Rust |
| DX `.1.1`, IO `.1.3` | Explicit Little Endian, unsigned monochrome with modality and VOI LUTs | Original samples and LUTs | — | Image-space tools | — | JSON | `dx-luts` and `io-luts` in Rust. The processing SOPs `.1.1.1` and `.1.3.1` use the same input path and have separate fixture coverage pending. |
| Ultrasound `.6.1` | Explicit Little Endian, 8-bit planar RGB or unsigned monochrome | Original channel order or gray samples | — | Calibrated 2D length region. Distance is unavailable for a time-axis region. | — | JSON | `us-rgb-planar` and `us-gray-time` in Rust |
| Ultrasound multiframe `.3.1` | JPEG Baseline `.4.50`, 8-bit YBR_FULL_422 → RGB | On-demand frame access | Source-timed and seekable | Image-space tools for the uncalibrated fixture | — | JSON | `cine-350` in Chromium, Firefox, Flutter Linux and pydicom. Basic, Extended and empty offset tables in Rust with `cine-extended` also exercised by the web lifecycle test. |
| Classic CT `.2`, MR `.4` | Explicit Little Endian, unsigned 16-bit MONOCHROME2 | Original slices | — | Patient plane | Consistent spatial acquisition | JSON | `classic-ct-0..2`, `classic-mr-0..2` in Rust. The CT series also opens through DICOMweb in Chromium and Firefox. |
| Enhanced CT `.2.1`, enhanced MR `.4.1` | Explicit Little Endian, unsigned 16-bit MONOCHROME2 with spatial and temporal groups | Original frames with per-frame rescale | Original frame navigation | Patient plane | Affine MPR, slab average and MIP | JSON | `enhanced-ct-oblique` and `enhanced-mr-oblique` in Rust. CT MPR also in Chromium, Firefox and Flutter Linux. |
| CR `.1` | JPEG Extended `.4.51`, unsigned 12-bit SOF1 | Original reconstructed samples | — | Image-space tools | — | JSON | `jpeg-extended-12`. All compressed monochrome rows below use Rust, Chromium, Firefox, Flutter Linux and independent pydicom decoders. |
| CR `.1` | JPEG Lossless `.4.57` and Selection Value 1 `.4.70`, signed 12-bit SOF3 | Exact reconstructed samples | — | Image-space tools | — | JSON | `jpeg-lossless`, `jpeg-lossless-sv1` |
| CR `.1` | JPEG-LS `.4.80` signed 12-bit lossless and `.4.81` unsigned 12-bit near-lossless | Exact reversible samples and error ≤2 for NEAR=2 | — | Image-space tools | — | JSON | `jpeg-ls`, `jpeg-ls-near` |
| CR `.1` | JPEG 2000 Part 1 `.4.90` and `.4.91`, signed 16-bit reversible or unsigned 16-bit irreversible grayscale | One tile and one tile part, matching SIZ representation | — | Image-space tools | — | JSON | `jpeg-2000-lossless`, `jpeg-2000` |
| CR `.1` | HTJ2K `.4.201`, `.4.202` and `.4.203`, signed 16-bit reversible, reversible RPCL and unsigned 16-bit irreversible grayscale | Same bounded wavelet profile | — | Image-space tools | — | JSON | `htj2k-lossless`, `htj2k-rpcl`, `htj2k` |
| Comprehensive SR `.88.33` | Explicit Little Endian | Recognized document and exact source-frame reference | — | Calibrated two-point distance with SCOORD | — | Import and export TID 1500 distance | `distance-sr` in Rust, Chromium, Firefox, Highdicom and Flutter Linux |
| Segmentation `.66.4` | Explicit Little Endian, native 1-bit BINARY | Segment and source-frame matching | — | — | — | Aligned display mask | `phantom-seg` in Rust, Chromium, Firefox and Flutter Linux |
| Grayscale PS `.11.1` | Explicit Little Endian | Full image area, exact source, window, polarity and quarter-turn | — | — | — | Display settings | `phantom-gsps` in Rust, Chromium, Firefox and Flutter Linux |
| Encapsulated PDF `.104.1` | Explicit Little Endian | Document identification | — | — | — | Bounded PDF bytes | `encapsulated-pdf` in Rust |

The SOP suffixes are under `1.2.840.10008.5.1.4.1.1`. Transfer syntax suffixes are under `1.2.840.10008.1.2`. The image parser also recognizes older US SOP registrations. Native paths support MONOCHROME1/2 and applicable 8-bit RGB, YBR_FULL and YBR_FULL_422. Each compressed profile checks dimensions, allocated and stored bits, sample count and photometric interpretation before decode. Color JPEG-LS, color wavelet objects, unbounded wavelet layouts and unsupported SOP classes receive a profile limitation. [Interchange details](api.md#volumes-and-interchange)

Dependent MPEG/AVC/HEVC objects have a host-container path where the encapsulated stream can be recognized. The independent-frame API applies to supported native and still-image compression profiles. The VP9 benchmark measures host video seek against a generated dependent stream. Qualification of DICOM video encodings and device capture protocols remains open.

## Platform and installation evidence

| Target | Evidence |
| --- | --- |
| Chromium 131.0.6778.33, Linux x64 | Separate package installation and complete headless web workflows. Software WebGL2, checked CPU fallback after context loss, signed samples and 350-frame navigation. |
| Firefox 132.0, Linux x64 | Complete headless web workflows on the CPU renderer. Samples, 350-frame navigation, codecs, volume, interchange and shared views. |
| Playwright WebKit 18.2, Linux x64 | Headless verification in the Ubuntu 24.04 Playwright container. The SDK and viewer passed signed and cine source-opening checks with Web Crypto and the Rust fallback. |
| Safari | Safari runtime verification on an Apple host remains open. |
| Windows WebView2 | Static WebView host path documented. Windows runtime verification remains open. |
| macOS WKWebView | Static WebView host path documented. macOS runtime verification remains open. |
| Flutter, Linux x64 | Flutter 3.44.9 with the native asset build hook, C ABI, isolate and widget tests. Tested after extracting the Flutter archive into an independent directory. |
| Android ARM64 | Flutter debug APK build with Android SDK 36 and NDK 28.2.13676358. APK inspection verified the AArch64 native library, versioned ABI symbols and exact fixture hashes. Runtime verification on physical Android remains open. |
| iOS ARM64 | Rust 1.97.1 target check. App linking with Xcode and physical iPhone runtime verification remain open. |

The DICOM transfer syntax and geometry tests are synthetic. The manual veterinary methods await specialist review. Reproduce the target checks and read the browser/codec timings in the [verification guide](../benchmarks/README.md).
