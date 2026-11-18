// boarddd/models: GLB + STEP loading, units/up-axis detection, STEP colour space, and matching
// meshes to reference designators.
export { loadGLB } from './glb.js';
export { loadSTEP, readStep, stepToObject, stepMaterial, terminateStepWorkers } from './step.js';
export { prepareModel, orientModel, mergeObject, disposeObject, PART_GROUP } from './prepare.js';
export {
  MATCH_MM, HOUGH_BIN_MM, naturalCompare, refFromName, toBoardFrame, houghTranslation, refineTranslation,
  matchByPosition, mapNodesToRefs, boardKindFromName, boardKindFromLook, flatness, splitBoardBodies, measureBoard,
} from './match.js';
export { UNIT_SCALE, detectUp, detectScale, stepColorToLinear } from './units.js';
