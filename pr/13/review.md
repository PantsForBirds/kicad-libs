## Component review

Reviewed **9** item(s): 0 fail, 7 warn, 2 pass.

| Component | Status | Verdict | Top findings |
|---|---|---|---|
| [`Custom_Connector:PA-SOCKET-MSOP-8-0.65` (footprint)](https://pantsforbirds.github.io/kicad-libs/pr/13/#footprint__Custom_Connector__PA-SOCKET-MSOP-8-0.65) | added | ⚠️ warn | ⚠️ KLC F5.3: Courtyard lines are not on 0.01mm grid; - Line (-1.6,-4.275) -> (-1.6,6.225) on layer 'F.CrtYd'; - Line (-1.6,-4.275) -> (17.9,-4.275) on layer 'F.Cr… |
| [`Custom_Module:RP2040-Zero_Castellated` (footprint)](https://pantsforbirds.github.io/kicad-libs/pr/13/#footprint__Custom_Module__RP2040-Zero_Castellated) | added | ⚠️ warn | ⚠️ KLC F9.3: 3D model offset is not {'x': 0, 'y': 0, 'z': 0}. Found {'x': -8.95, 'y': -11.85, 'z': 1.1}; Model is incompatible format (must be STEP file)<br>… +1 more |
| [`Custom_Resistor_SMD:R_0603_1608Metric_Kelvin_NetTie` (footprint)](https://pantsforbirds.github.io/kicad-libs/pr/13/#footprint__Custom_Resistor_SMD__R_0603_1608Metric_Kelvin_NetTie) | added | ⚠️ warn | ⚠️ 3D model path `${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step` does not use `${KICAD_LIBS_DIR}/lib_3d/...`. (L171)<br>… +5 more |
| [`Custom_Power_Management:LM73100RPWR` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_Power_Management__LM73100RPWR) | modified | ⚠️ warn | ⚠️ Symbol `Description` property is empty. (L58)<br>⚠️ Pin 1 (EN_UVLO) at (-11.43, 1.27) is on 50 mil but not 100 mil grid. (L92)<br>⚠️ Pin 2 (OVLO) at (-11.43, -1.27) is on 50 mil but not 100 mil grid. (L110)<br>… +13 more |
| [`Custom_RF_Amplifier:AD8314` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_RF_Amplifier__AD8314) | modified | ⚠️ warn | ⚠️ Symbol has neither a default `Footprint` nor `ki_fp_filters`. (L5)<br>⚠️ Symbol `Datasheet` property is empty. (L43)<br>⚠️ Symbol `Description` property is empty. (L54)<br>… +18 more |
| [`Custom_RF_Amplifier:BLB01` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_RF_Amplifier__BLB01) | modified | ⚠️ warn | ⚠️ Pin 6 () at (-2.54, -1.27) is on 50 mil but not 100 mil grid. (L337)<br>⚠️ Pin 3 () at (-2.54, 3.81) is on 50 mil but not 100 mil grid. (L395)<br>⚠️ Pin 5 () at (-2.54, 1.27) is on 50 mil but not 100 mil grid. (L433)<br>… +6 more |
| [`Custom_RF_Amplifier:PA-SOCKET-MSOP-8-0.65_AD8313` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_RF_Amplifier__PA-SOCKET-MSOP-8-0.65_AD8313) | added | ⚠️ warn | ⚠️ KLC S6.2: Value AD8313 in PA-SOCKET-MSOP-8-0.65 does not match component name.<br>… +1 more |
| [`Custom_MCU:RP2040-Zero` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_MCU__RP2040-Zero) | added | ✅ pass | ℹ️ KLC S6.2: Symbol name should not be included in description |
| [`Custom_Power_Management:TPS22918DBV` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_Power_Management__TPS22918DBV) | added | ✅ pass | ℹ️ KLC S6.2: Found a unexpected property with the name LCSC |

<sub>Checks: deterministic checks + KLC. Line numbers refer to the PR head.</sub>
