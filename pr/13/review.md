## Component review

Reviewed **6** item(s): 0 fail, 2 warn, 4 pass. 3 symbols re-encoded by KiCad, no changes (not reviewed).

| Component | Status | Verdict | Top findings |
|---|---|---|---|
| [`Custom_Module:RP2040-Zero_Castellated` (footprint)](https://pantsforbirds.github.io/kicad-libs/pr/13/#footprint__Custom_Module__RP2040-Zero_Castellated) | added | ⚠️ warn | ⚠️ KLC F9.3: 3D model offset is not {'x': 0, 'y': 0, 'z': 0}. Found {'x': -8.95, 'y': -11.85, 'z': 1.1}; Model is incompatible format (must be STEP file)<br>… +1 more |
| [`Custom_Resistor_SMD:R_0603_1608Metric_Kelvin_NetTie` (footprint)](https://pantsforbirds.github.io/kicad-libs/pr/13/#footprint__Custom_Resistor_SMD__R_0603_1608Metric_Kelvin_NetTie) | added | ⚠️ warn | ⚠️ 3D model path `${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step` does not use `${KICAD_LIBS_DIR}/lib_3d/...`. (L171)<br>… +5 more |
| [`Custom_Connector:PA-SOCKET-MSOP-8-0.65` (footprint)](https://pantsforbirds.github.io/kicad-libs/pr/13/#footprint__Custom_Connector__PA-SOCKET-MSOP-8-0.65) | added | ✅ pass | ℹ️ KLC F9.3: 3D model offset is not {'x': 0, 'y': 0, 'z': 0}. Found {'x': 8.15, 'y': -0.96, 'z': 0} |
| [`Custom_MCU:RP2040-Zero` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_MCU__RP2040-Zero) | added | ✅ pass | ℹ️ KLC S6.2: Symbol name should not be included in description |
| [`Custom_Power_Management:TPS22918DBV` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_Power_Management__TPS22918DBV) | added | ✅ pass | — |
| [`Custom_RF_Amplifier:PA-SOCKET-MSOP-8-0.65_AD8313` (symbol)](https://pantsforbirds.github.io/kicad-libs/pr/13/#symbol__Custom_RF_Amplifier__PA-SOCKET-MSOP-8-0.65_AD8313) | added | ✅ pass | ℹ️ KLC S4.4: Pin types should match pin function; - Pin VOUT (8) @ (500,100) is type output : suggested power_out |

<sub>Checks: deterministic checks + KLC. Line numbers refer to the PR head.</sub>
