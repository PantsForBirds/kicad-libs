// boarddd/view2d: the shared 2D board stage. Pan / zoom over board mm (y up), side by side panes
// with one view, a layer stack from boarddd/gerber, compare modes, ink diff, measure, overlays for
// app markers, hit-testing and view state. No app chrome: toolbars, lists and routes stay in the apps.

export { createStage, svgEl, measureText, STAGE_CSS } from './stage.js';
export { createCompare, defaultDiff, COMPARE_MODES } from './compare.js';
export { face, layers, repeat, diff, image, inkdiff, draw, renderContent, outlineRings, holesPath, decodeImage, isEmptySource, contentRect, inTurn } from './content.js';
export { layerStack, layerColor, layerRank, sortLayers, defaultVisible, faceBoard, LAYER_ALPHA } from './layers.js';
export { createHitIndex, segmentShape, rectShape, circleShape, polygonShape } from './hit.js';
export { formatRegion, parseRegion, sameRegion, formatSlider, parseSlider, formatViewState, parseViewState } from './viewstate.js';
export { inkMask, alphaMask, dilate, diffMasks, paintDiff, regions, orMask, inkDiff, DIFF_COLORS } from './inkdiff.js';
export * from './math.js';
