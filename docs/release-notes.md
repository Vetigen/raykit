# RayKit 0.1.0

Initial standalone RayKit release for Rust, the command line, C, web, Node.js,
Python and Flutter. It includes original DICOM pixel access, device window
selection, calibrated measurements, CT and MR volume reslicing, and indexed
JPEG cine and live review capabilities.

The package matrix verifies the same synthetic CT at frame 150 and pixel
(256, 256). The stored value is 474, the modality value is 448 HU, and the
calibrated distance is 7 mm. The release report identifies the tested targets,
runtime scope and package hashes. The support matrix lists transfer syntaxes
and platform boundaries. [Support matrix](https://github.com/Vetigen/raykit/blob/main/docs/support.md)

The installed viewer checks cover signed MONOCHROME1 windowing, color
ultrasound, full-source and indexed cine, and late results from replaced
sources. Web and Flutter panels discard source-bound measurement results
when the host revokes access. The application drawing events and repeatable
startup benchmarks are documented in the verification guide. [Verification guide](https://github.com/Vetigen/raykit/blob/main/benchmarks/README.md)
