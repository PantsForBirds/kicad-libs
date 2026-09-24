## Component review

Reviewed **3** item(s): 0 fail, 3 warn, 0 pass.

| Component | Status | Verdict | Top findings |
|---|---|---|---|
| [`Custom_Button_Switch_SMD:SW-SMD_L3.9-W3.0-P4.45` (footprint)](https://pantsforbirds.github.io/kicad-libs/pr/11/#footprint__Custom_Button_Switch_SMD__SW-SMD_L3.9-W3.0-P4.45) | modified | ⚠️ warn | ⚠️ No datasheet URL in `descr` and the `Datasheet` property is empty. (L41)<br>⚠️ Courtyard clearance is only 0.070 mm on at least one side (KLC typical 0.25 mm; bounding-box approximation). (L117)<br>⚠️ 3D model name `SW-SMD_L3.9-W2.9-H2.0-LS4.8` does not match footprint name `SW-SMD_L3.9-W3.0-P4.45`. (L162)<br>… +7 more |
| [`Custom_Button_Switch_SMD:SW-SMD_L3.9-W3.0-P4.45_TEMP` (footprint)](https://pantsforbirds.github.io/kicad-libs/pr/11/#footprint__Custom_Button_Switch_SMD__SW-SMD_L3.9-W3.0-P4.45_TEMP) | added | ⚠️ warn | ⚠️ No datasheet URL in `descr` and the `Datasheet` property is empty. (L41)<br>⚠️ Courtyard clearance is only 0.070 mm on at least one side (KLC typical 0.25 mm; bounding-box approximation). (L117)<br>⚠️ 3D model name `SW-SMD_L3.9-W2.9-H2.0-LS4.8` does not match footprint name `SW-SMD_L3.9-W3.0-P4.45_TEMP`. (L162)<br>… +7 more |
| [`Custom_Device:Buzzer` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/11/#symbol__Custom_Device__Buzzer) | modified | ⚠️ warn | ⚠️ Symbol `Datasheet` property is empty. (L39)<br>⚠️ Pin 3 (MP) at (0.0, -3.81) is on 50 mil but not 100 mil grid. (L128) |

<sub>Checks: deterministic checks + KLC. Line numbers refer to the PR head.</sub>
