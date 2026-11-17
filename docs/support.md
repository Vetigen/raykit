# Support matrix

The profiles below combine the listed SOP class and pixel representation with the transfer syntax and capability tables. Every support claim is scoped to those combinations. Source parsing, individual frame access, geometry, volume creation and export are separate checks.

| SOP class | UID suffix under `1.2.840.10008.5.1.4.1.1` | Pixel profile | Capabilities |
| --- | --- | --- | --- |
| Computed radiography | `.1` | MONOCHROME1/2, signed or unsigned 8/16 allocated bits | Render and query samples. Calibrated ruler when applicable. Versioned image measurements. |
| Digital radiography | `.1.1`, `.1.1.1` | Same projection Pixel Module | `dx-luts` verifies the presentation variant, including the LUT chain. |
| Digital intra-oral radiography | `.1.3`, `.1.3.1` | Same projection Pixel Module | `io-luts` verifies the presentation variant, including the LUT chain. |
| Ultrasound and ultrasound multiframe | `.6.1`, `.3.1`, legacy `.6` and `.3` | Monochrome or 8-bit RGB, YBR_FULL, YBR_FULL_422, with syntax-specific restrictions | `us-rgb-planar`, `us-gray-time` and `cine-350` validate sample layout, region units and frame navigation for current SOP classes. |
| CT and MR | `.2`, `.4` | Monochrome 8/16-bit | Original slices. Consistent geometry and acquisition dimensions can form a volume. Classic CT fixtures validate this path. |
| Enhanced CT/MR | `.2.1`, `.4.1` | Monochrome 8/16-bit, supported functional groups and explicit spatial dimension | Original frames, acquisition grouping, MPR and slab operations. |
| PDF, SEG, PR, Comprehensive SR | `.104.1`, `.66.4`, `.11.1`, `.88.33` | Object-specific subset | Use the [interchange profiles](api.md#volumes-and-interchange). |

| Transfer syntax | Tested pixel subset | Synthetic evidence |
| --- | --- | --- |
| Implicit LE, Explicit LE, Explicit BE | Native mono and supported RGB/YBR layouts | Signed 12-bit, nonstandard High Bit, padding and rescale with the `signed12` family. |
| Deflated Explicit LE | Same native Pixel Module after bounded dataset inflation | `signed12-deflated` and limit regression. |
| RLE Lossless | Monochrome 8/16-bit, RGB/YBR_FULL 8-bit decoder path | `unsigned16-rle` validates both byte planes and full unsigned range. |
| JPEG Baseline | 8-bit DCT mono/RGB/YBR, frame-aware indexing | 350-frame YBR_FULL_422 with Basic Offset Table, small EOT and split-frame fixtures. |
| JPEG Extended | Unsigned monochrome, SOF1 12-bit and compatible 8-bit | `jpeg-extended-12`, tolerance of 2 stored levels. |
| JPEG Lossless | Monochrome, SOF3; Selection Value 1 checked for `.70` | `jpeg-lossless` and `jpeg-lossless-sv1`. |
| JPEG-LS | Monochrome T.87, lossless or unsigned near-lossless | `jpeg-ls` and `jpeg-ls-near`, tolerance of 2 levels for NEAR=2. |
| JPEG 2000 Part 1 | Monochrome raw codestream, matching signedness, one tile and one tile part | `jpeg-2000-lossless` and `jpeg-2000`, tolerance of 4 for the lossy fixture. |
| HTJ2K | Same grayscale subset, separate reversible, reversible RPCL and irreversible profiles | `htj2k-lossless`, `htj2k-rpcl`, `htj2k`. |
| Dependent video | Container handoff to host for recognized encapsulated streams | Separate live preview example. DICOM-dependent video playback and physical device protocols require separate validation. |

| Target | Evidence |
| --- | --- |
| Chromium 131.0.6778.33, Linux | Built package in a headless browser, software WebGL2 with CPU fallback. Verified original cine frame samples, ruler, advanced grayscale codecs, volume, QIDO/WADO, SR/SEG/PR, and synthetic realtime workflows. |
| Firefox 132.0, Linux | Built package in a headless browser with CPU rendering. Verified advanced codec profiles and the volume/interchange workflow. |
| Safari | Physical Apple environment required. |
| Windows WebView2 | Embed the web build using the documented host path. Engine acceptance is open. |
| macOS WKWebView | Embed the web build using the documented host path. Engine acceptance is open. |
| Flutter, Linux x64 | Native-asset build hook, actual C ABI, native sample parity, widget presentation and measurement reopening on the host. |
| iOS ARM64 | Rust cross-target type check on Linux. Xcode app link and physical iPhone checks remain open. |
| Android ARM64 | Rust cross-target type check on Linux. Android NDK app link and middle-tier physical device checks remain open. |

The synthetic corpus generates hashes and expected values. The independent check uses pydicom and Highdicom with a separate pixel decoding backend. Reproducible benchmark configurations and device evidence belong with the [benchmark results](../benchmarks/README.md).
