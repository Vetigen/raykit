# RayKit release guide

The release version comes from `[workspace.package]` in `Cargo.toml`. Update
the internal crate dependency versions, npm manifests and lockfile, Python
metadata, Flutter manifests and example lockfile, Flutter changelog, and
[release notes](release-notes.md) together. Run `python3 scripts/release.py check`
before opening a change.

## Rehearsal

1. Land the release commit on `main` and wait for its push CI and `ci-required`.
2. Dispatch **Release rehearsal** from `main` with the full commit SHA.
   Download `raykit-candidate-<report-sha256>` from the successful run. Its
   `release-report.json` lists required tests, package sizes, targets and
   hashes. The run summary includes the SHA256 of the report.
3. Inspect the report and packages. Keep the run ID, commit and report SHA256
   together. The candidate and review report are retained for 30 days.
   Intermediate build and fixture artifacts are retained for three days. A
   failed matrix produces a report that identifies missing results or files.

The CLI, C SDK, Node addons and Python wheels cover Linux GNU, macOS and
Windows MSVC on x64 and arm64. Those Linux targets are built in pinned
manylinux 2.28 images. Auditwheel repairs and checks Linux wheels. Standalone Flutter
desktop archives target Linux x64, macOS Intel and Apple Silicon, and Windows
x64, for which the pinned Flutter version provides SDK archives. Desktop
checks launch the extracted app and read the synthetic CT through its viewer.
The macOS release app can read a DICOM path supplied at launch. These builds
use the runner's local signing settings. Apple Developer signing and
notarization require separate setup. [GitHub runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

The web matrix installs both npm tarballs in a fresh application for Chromium,
Firefox and Playwright WebKit. It runs the source cancellation, verified index,
independent pixels and panel revocation checks against the installed packages.
The Flutter SDK test installs the source archive outside the checkout, compiles
its native asset, draws the CT and exercises source replacement and revocation.
Android checks the compiled ARM64 APK, native library and assets. iOS checks
an unsigned device link and launches a standalone app that writes its verified
CT sample and ruler result after drawing the original frame. Physical device
and Safari acceptance are tracked in the [support matrix](support.md).

## First publication

Use the reviewed rehearsal artifacts for first-version uploads. The automated
run checks existing packages against the same candidate before proceeding.

- **crates.io.** Verify ownership of all seven names. The first version of
  each crate needs a maintainer upload. Supply a maintainer-authorized
  `CARGO_REGISTRY_TOKEN` and run
  `python3 scripts/release_registry.py publish crates CANDIDATE COMMIT REPORT_SHA256`.
  This submits the approved `.crate` files to the Cargo registry API. It
  checks index visibility and digests in dependency order through core, vet,
  protocol, then ffi, wasm, cli and node. Add a trusted publisher to each crate
  for `Vetigen/raykit`, workflow `release.yml` and environment `release`.
  [crates.io trusted publishing](https://crates.io/docs/trusted-publishing)
- **npm.** Verify the organization or account controls the `@vetigen` scope
  and all package names. The scope maintainer publishes or stages each approved
  tarball and completes any required 2FA review. Publish all six platform
  addons before `@vetigen/raykit-node`, and `@vetigen/raykit-web` before
  `@vetigen/raykit-web-component`. The publish helper routes the `@vetigen`
  scope to the public npm registry for the upload. In each package's trusted
  publisher settings, use `Vetigen/raykit`, workflow `release.yml` and
  environment `release`. Allow direct `npm publish`.
  [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- **PyPI.** For a new `raykit-dicom` project, register a pending trusted
  publisher for `Vetigen/raykit`, `release.yml` and environment `release`.
  The first workflow upload can create the project. The import is
  `raykit_dicom`. [PyPI pending publishers](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)
- **pub.dev.** An uploader must publish the first version of `raykit`.
  Extract the approved Flutter source archive and run `flutter pub publish
  --dry-run` in its `raykit` directory. Publish that directory interactively
  with `flutter pub publish`. In the package's Admin tab, enable GitHub
  Actions publishing for `Vetigen/raykit` with pattern `v{{version}}`.
  Automated publishing runs on a Git tag push.
  [pub.dev automated publishing](https://dart.dev/tools/pub/automated-publishing)

## Protect releases

Make `ci-required` a required check for `main`. Apply a tag ruleset to `v*`
that limits creation to release maintainers and prevents updates and deletion.
Create the `release` environment with required reviewers and selected tag
deployments matching `v*`. Prevent self-review and disable administrator
bypass. The release preflight checks protection on the tag, a
passing main-push CI run for its SHA, and the environment's reviewers and tag
policy. [GitHub environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

## Publish the approved candidate

After reviewing the candidate and completing the registry setup, annotate
the tag with the run ID and SHA256 of the report. Pushing this tag starts
publication.

```sh
git tag -a "$TAG" "$COMMIT" -m "RayKit $TAG" -m "RayKit-Candidate: $RUN_ID $REPORT_SHA256"
git push origin "refs/tags/$TAG"
```

Approve the protected environment jobs after preflight. Each registry job uses
its own OIDC identity. The release workflow checks the exact rehearsed package
inventory before those jobs obtain credentials. The workflow verifies registry
downloads and reruns installation checks using registry package names. GitHub
attests the approved checksums, verifies the draft assets, then exposes the
release. [GitHub build attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

If a channel fails partway through, re-run the failed jobs for the same tag.
Keep the approved rehearsal available until the release completes. Existing
files with the expected digest are verified and skipped. Missing files are
uploaded. A digest mismatch stops publication. For pub.dev the verifier uses
the registry's archive SHA256 and compares the uncompressed file paths and
digests with the approved archive. A registry can retain a published artifact
when another channel fails.

## Local verification

Use Node 24 for workspace builds, Python 3.11 or later, Rust 1.97.1 with
`wasm32-unknown-unknown` and the workspace's wasm-bindgen CLI. Flutter checks
use Flutter 3.41 or later. Building the Linux desktop archive also needs clang,
CMake, Ninja and GTK development headers.
The installed Node SDK is exercised with the consumer minimum of Node 22.14.

```sh
export RAYKIT_ARTIFACTS="$(mktemp -d)"
npm ci --ignore-scripts
python -m pip install build
npm run fixtures
npm run fixtures:delivery
node scripts/package-local.mjs --web --flutter --python-source
npm run package:native
node tests/native-delivery.mjs
node tests/python-source.mjs
cargo package --workspace --locked
python3 tests/cargo-install.py --packages target/package
python3 -m unittest discover -s tests -p test_release.py
actionlint
```

`package:native` needs Docker on Linux. Select a fresh output directory for each
rehearsal. To build a desktop archive from the packaged SDK, run
`node scripts/prepare-flutter-consumer.mjs OUTSIDE_CHECKOUT`, set
`RAYKIT_FLUTTER_APP=OUTSIDE_CHECKOUT/examples/flutter`, then run
`npm run package:desktop`. Run `node tests/desktop-delivery.mjs` with a display
server. The C SDK test uses the header and shared library or Windows import
library from the extracted archive.
