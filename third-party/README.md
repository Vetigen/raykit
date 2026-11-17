# Third-party license files

The Rust dependency inventory is generated from `Cargo.lock` for the packaged entry point, target and enabled features. These files supplement published crates that omit the repository's license text.

| Crate | Upstream license files |
| --- | --- |
| `dicom-core` and `dicom-dictionary-std` 0.10.0 | [DICOM-rs v0.10.0](https://github.com/Enet4/dicom-rs/tree/2941c54cae434dd63a54d0a5546b3b0df42e9f6c) |
| `oxiarc-jpeg` 0.4.2 | [OxiArc release source](https://github.com/cool-japan/oxiarc/tree/3beef0a3bd5fbbb03d05d31df8ce4f6f6565b337) |
| `pure_jpegls` 2.1.0 | [dicos.rs release source](https://github.com/jpfielding/dicos.rs/tree/1ebf683e8620ed6b917255dc838bfcb52e7184ae) |

OpenJPH and the independent reference decoders are used to generate or verify fixtures. DWV and Cornerstone3D are used in the comparison harness. These dependencies are separate from the RayKit runtime packages.
