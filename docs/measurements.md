# Landmark measurements

Each RayKit record includes the instance UID, SOP class, frame number, complete-source SHA-256, Frame of Reference when present, landmark coordinates, method ID and version, calibration and quantities. Pixel centers have zero-based coordinates. Landmark positions stay fixed as the view changes. Reopen an exported record against the same source and recompute it with the same method version.

| Method | View and landmark order | Output |
| --- | --- | --- |
| Ruler | One original frame, two endpoints | Millimeters when the local transform is calibrated, otherwise pixels. Set `require_mm` to require physical calibration. |
| Angle | Arm, vertex, arm on one original frame | Degrees in the image plane, with the metric recorded. |
| Canine VHS | Confirm a lateral thorax radiograph. Mark cardiac long-axis endpoints, short-axis endpoints, the cranial margin of T4, and successive cranial vertebral margins along the same axis. | The lengths are transferred to the vertebral reference. Each is interpolated between adjacent marked vertebral positions and rounded to a tenth of a vertebra. The example records the two lengths and their sum. |
| Norberg | Confirm a ventrodorsal extended-hip radiograph. Mark left and right femoral head centers and the corresponding cranial effective acetabular rims. | Two angles in degrees, each between the contralateral head-center ray and the ipsilateral rim ray. |
| TPLO geometry | Confirm a mediolateral stifle radiograph with calibrated projection millimeters. Mark the cranial and caudal medial plateau, proximal and distal mechanical axis, and proposed osteotomy center. Enter a target angle and a radius. | Signed plateau angle, rotation from the measured angle to the chosen target, chord length and radius. The radius is centered at the selected point. |

VHS uses the vertebral scale described by Buchanan and Bücheler. Manual placement and the discrete reference-margin interpolation are RayKit's version 1 implementation choices. [Buchanan and Bücheler](https://pubmed.ncbi.nlm.nih.gov/7751220/)

The Norberg method follows the FCI landmark definitions. TPLO measures the plateau against the perpendicular to the tibial mechanical axis and calculates a chord using `2r sin(|rotation|/2)`. The user supplies the target and the radius. [FCI Norberg Angle guide](https://www.fci.be/medias/SCI-DYS-HAN-CLA-en-15522.pdf), [TPLO planning geometry](https://pmc.ncbi.nlm.nih.gov/articles/PMC7273611/)

Analytic fixtures establish geometry, unit handling and reproducibility. The landmark workflows are awaiting veterinary specialist review.

Show or hide each overlay from the panel's **Layers** control. The same coordinates remain valid after an independent palette, window or camera change. The record stays with its exact instance, full-source hash and frame. A SEG overlay uses the same source check. An original opened through a frame proof or tiled projection uses its bound full-source identity.

`raykit measurements verify SOURCE RECORD.json`, Node `verifyMeasurement` and Python `verify_measurement` verify the recorded method, geometry, calibration and numerical results. The viewers' reopen path recomputes the values. A frozen preview acquires measurement tools when its host-authorized exact capture binding resolves to a physically calibrated original.

## Host-selected methods

An external Rust developer can implement `raykit_core::measurement::Method`. The method receives selected points and their geometric context. The host chooses and invokes the compiled method, including on re-open. Session access stays with the host. Run the working example from the checkout.

```sh
cargo run --locked -p raykit-core --example landmark-ratio -- fixtures/generated/signed12.dcm
```

The example calculates a unitless ratio of `1.5`, saves the record to JSON in memory, and recomputes it in a new session that uses the same original bytes.
