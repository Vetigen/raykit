# Paired CT comparison exercise

Use this exercise with a veterinary radiologist or surgeon to compare switching displays in one panel with using linked side-by-side panels. Ask the reader to locate and mark the same anatomical landmark in each workflow. Use authorized, de-identified cases with confirmed source hashes, physical geometry and device-defined soft-tissue and bone windows.

## Prepare the cases

Choose two cases of similar difficulty and a single visible landmark in each. A reference reader records the correct frame and patient-space point before the session. Agree on acceptable localization and frame tolerances for those landmarks. Prepare a card with the landmark name, anatomical side and the clinical views required for confirmation. Keep reference coordinates separate from the cards.

Rehearse the task with the bundled `comparison-ct.dcm`. Open it in the local web or desktop example. At zero-based slice 150, the known source pixel `(256, 256)` is `(179.2, 204.8, 180.0)` mm in patient space. Its stored value is 474 and its modality value is 448 HU. The two device displays have different gray levels. A horizontal ruler from `(256, 256)` to `(266, 256)` produces 7 mm. The generated image checks operation and timing capture.

## Run a balanced comparison

Assign readers in rotating groups. Start each task at the same relative slice and scale. Provide the same practice task beforehand. The observer starts a monotonic clock when the card is shown and stops it when the reader commits the landmark. Use the app's verified source frame and patient coordinates for the recorded mark.

| Group | First task | Second task |
| --- | --- | --- |
| 1 | Case A, one panel | Case B, two linked panels |
| 2 | Case B, one panel | Case A, two linked panels |
| 3 | Case A, two linked panels | Case B, one panel |
| 4 | Case B, two linked panels | Case A, one panel |

Keep the same window definitions, monitor, input device and zoom limits in both workflows. Allow reset and exact frame step. Start with a new view for the second task.

## Record and score

| Field | Record |
| --- | --- |
| Reader and task | De-identified reader code, group, case key and task order |
| Elapsed time | Seconds from task card to saved landmark |
| Localization | Selected frame and Euclidean patient-space distance from the reference point in millimeters |
| View errors | Count of selections with a window outside the case card's requested views when confirming the landmark |
| Recovery | Resets, repeated frame selections, abandoned actions and a brief reader comment |

Compare each reader's two times and localization errors. Report individual results and median paired differences by task order. Report incomplete trials and wrong-window counts alongside the timing. Preserve reference and collected records in the approved clinical environment. The synthetic pixel and measurement runs establish technical accuracy. Specialist usability remains an external acceptance item.
