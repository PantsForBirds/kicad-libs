// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/contour.js at 92976b5
// (earlier history lives there).
/**
 * Turning a raster of a layer back into shapes: outlines with holes.
 *
 * The renderer is a rasterizer; it reports which pixels are ink, not the
 * apertures that made them. Anything that needs a layer as geometry --
 * extruding solder paste off a 3D board, say -- recovers outlines from the
 * image. At typical resolutions (tens of microns per pixel) the staircase is
 * far below anything visible.
 *
 * Holes are traced as well as outlines (a shield-can paste aperture is a ring).
 * Enclosed background is found box by box -- background inside a shape's
 * bounding box that cannot reach the box edge without crossing the shape --
 * rather than by flooding the whole image, because ink is usually a few
 * percent of the raster.
 *
 * Pure: pixels in, polygons out; no DOM, no WebGL, no three.js. Worker-safe
 * (see contour-worker.js).
 */

// Alpha at or above this is the layer; below it is background. The rasterizer antialiases,
// so the edge pixels are partly lit and the threshold decides where the edge falls -- halfway
// is the honest answer and puts it within half a pixel of where the aperture was.
const SOLID = 128;

// How far a traced point may be moved to drop it, in pixels. The boundary follower emits one
// point per boundary pixel, so a half-millimeter pad arrives with a couple of hundred of
// them; at this tolerance a straight edge collapses to its two ends and a curve keeps enough
// to stay a curve.
const SIMPLIFY_PX = 0.75;

/* The eight neighbors, clockwise from due east. */
const AROUND = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * The outlines of everything drawn in an image.
 *
 * Each entry is `{outer, holes}`: one boundary and any number of enclosed ones, all as arrays
 * of `[x, y]` in pixel coordinates.
 *
 * @param {Uint8ClampedArray} rgba - the image, four bytes per pixel
 * @param {number} width
 * @param {number} height
 * @param {number} [minArea] - drop blobs smaller than this many pixels; rasterizer grit
 */
export function traceLayer(rgba, width, height, minArea = 12) {
    const solid = new Uint8Array(width * height);
    for (let i = 0, at = 0; i < rgba.length; i += 4, at += 1) {
        solid[at] = rgba[i + 3] >= SOLID ? 1 : 0;
    }
    return traceMask(solid, width, height, minArea);
}

/**
 * The same, given a binary mask. Separated so it can be exercised with a hand-written grid.
 */
export function traceMask(solid, width, height, minArea = 12) {
    const isSolid = (x, y) =>
        x >= 0 && y >= 0 && x < width && y < height && solid[y * width + x] === 1;

    // Which blob each pixel belongs to. Every blob gets a label, kept or not: a label that
    // was reused after a speck was dropped would make the speck part of the next shape.
    const owner = new Int32Array(width * height).fill(-1);
    const shapes = [];
    let label = 0;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const at = y * width + x;
            if (!solid[at] || owner[at] !== -1) continue;
            // The first solid pixel of a shape, scanning top to bottom: the pixel above it is
            // background by construction, so this is on the outer boundary rather than
            // somewhere inside.
            const outline = followBoundary(isSolid, width, height, x, y);
            const box = { minX: x, maxX: x, minY: y, maxY: y };
            const area = fill(isSolid, owner, label, width, height, x, y, box);
            label += 1;
            if (area < minArea || outline.length < 3) continue;
            shapes.push({ outer: simplify(outline, SIMPLIFY_PX), holes: [],
                          label: label - 1, box: box, area: area });
        }
    }

    shapes.forEach((shape) => findHoles(solid, owner, shape, width, height, minArea));
    return shapes.map(({ outer, holes }) => ({ outer, holes }));
}

/*
 * Background inside a shape's box that cannot get out of the box without crossing the shape
 * is a hole in it.
 *
 * The distinction has to be made this way round. Locally a hole and the space around the board
 * look identical -- both are background with solid on one side -- and the only thing that tells
 * them apart is whether you can walk out from there. The box is enough of a world to ask in:
 * a hole lies inside its shape's outline, so inside its box, and any way out of the box is a
 * way out to the edge of the picture. Other shapes inside the box are walkable -- a pad
 * sitting inside a ring's hole does not seal the ring's opening -- and a shape that fills its
 * box, which is most pads, is answered without looking.
 *
 * Everything here is local to the box: one byte per box pixel, marked 1 when the outside can
 * reach it and 2 once a hole has claimed it. Nothing the size of the image is allocated.
 */
function findHoles(solid, owner, shape, width, height, minArea) {
    const { box, label } = shape;
    const boxWidth = box.maxX - box.minX + 1;
    const boxHeight = box.maxY - box.minY + 1;
    if (boxWidth < 3 || boxHeight < 3 || shape.area === boxWidth * boxHeight) return;

    const mark = new Uint8Array(boxWidth * boxHeight);
    const local = (x, y) => (y - box.minY) * boxWidth + (x - box.minX);
    const inBox = (x, y) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
    const passable = (x, y) => inBox(x, y) && owner[y * width + x] !== label;

    // The outside floods in from every passable pixel along the box's edge.
    const stack = [];
    const reach = (x, y) => {
        if (!passable(x, y) || mark[local(x, y)] === 1) return;
        mark[local(x, y)] = 1;
        stack.push(x, y);
    };
    for (let x = box.minX; x <= box.maxX; x += 1) { reach(x, box.minY); reach(x, box.maxY); }
    for (let y = box.minY; y <= box.maxY; y += 1) { reach(box.minX, y); reach(box.maxX, y); }
    while (stack.length) {
        const y = stack.pop();
        const x = stack.pop();
        for (let i = 0; i < 8; i += 1) reach(x + AROUND[i][0], y + AROUND[i][1]);
    }

    // What is background and was never reached is enclosed.
    const isHole = (x, y) => inBox(x, y) && solid[y * width + x] === 0 && mark[local(x, y)] !== 1;

    for (let y = box.minY; y <= box.maxY; y += 1) {
        for (let x = box.minX; x <= box.maxX; x += 1) {
            if (!isHole(x, y) || mark[local(x, y)] === 2) continue;
            // Scanning downwards, the pixel above the first one of a hole is solid, and the
            // shape it belongs to is the shape this hole is in. Not always this one: a ring
            // inside a ring's hole has a hole of its own, enclosed by both, and it belongs
            // to the inner ring alone -- given to the outer one too, it would be a hole
            // inside a hole, which the extruder makes nonsense of. Claimed either way, so
            // it is walked once.
            const ours = owner[(y - 1) * width + x] === label;
            const outline = ours ? followBoundary(isHole, width, height, x, y) : null;
            // Claim the whole hole so it is started once, counting its pixels as it goes.
            let area = 0;
            mark[local(x, y)] = 2;
            stack.push(x, y);
            while (stack.length) {
                const cy = stack.pop();
                const cx = stack.pop();
                area += 1;
                for (let i = 0; i < 8; i += 1) {
                    const nx = cx + AROUND[i][0];
                    const ny = cy + AROUND[i][1];
                    if (isHole(nx, ny) && mark[local(nx, ny)] !== 2) {
                        mark[local(nx, ny)] = 2;
                        stack.push(nx, ny);
                    }
                }
            }
            if (outline && area >= minArea && outline.length >= 3) {
                shape.holes.push(simplify(outline, SIMPLIFY_PX));
            }
        }
    }
}

/*
 * Moore-neighbourhood boundary following: walk the edge of a shape, keeping it on one side,
 * until arriving back where the walk started facing the way it first faced.
 *
 * The direction is carried between steps rather than restarted -- the classic bug here is a
 * tracer that begins each search from due east, which walks into a one-pixel-wide neck and
 * comes out the way it went in, tracing half the shape forever.
 */
function followBoundary(inside, width, height, startX, startY) {
    const points = [];
    let x = startX, y = startY;
    let heading = 6;                            // due north: where the background is, above
    let firstStep = null;

    for (let step = 0; step < width * height * 4 + 8; step += 1) {
        points.push([x, y]);

        // Start looking one step anticlockwise of where the last background was, which keeps
        // the search against the edge instead of sweeping the whole neighbourhood. Carrying
        // the heading between steps is what makes that work: a tracer that restarts from due
        // east each time walks into a one-pixel neck and comes back out the way it went in.
        let found = -1;
        for (let turn = 0; turn < 8; turn += 1) {
            const at = (heading + 6 + turn) % 8;
            if (inside(x + AROUND[at][0], y + AROUND[at][1])) { found = at; break; }
        }
        if (found === -1) break;                // a lone pixel with nothing around it

        const nx = x + AROUND[found][0];
        const ny = y + AROUND[found][1];

        // Jacob's criterion: the walk is done when it takes the same step it took first --
        // same pixel, same direction. Position alone is not enough, because a boundary
        // legitimately passes through a pixel twice where the shape is one pixel wide.
        if (firstStep === null) {
            firstStep = { x: nx, y: ny, heading: found };
        } else if (nx === firstStep.x && ny === firstStep.y && found === firstStep.heading) {
            break;
        }

        x = nx;
        y = ny;
        heading = found;
    }
    return points;
}

/*
 * Claim a region so it is not started again, stamping it with a label, and say how big it was
 * -- and, given a box, how far it reached.
 *
 * Eight-connected, matching the boundary follower: a region the tracer walks around in one
 * loop has to be one region here too, or a shape joined only at a corner would be traced once
 * and filled twice.
 */
function fill(inside, labels, label, width, height, startX, startY, box = null) {
    const queue = [startY * width + startX];
    labels[queue[0]] = label;
    let area = 0;

    while (queue.length) {
        const at = queue.pop();
        area += 1;
        const x = at % width;
        const y = (at - x) / width;
        if (box) {
            if (x < box.minX) box.minX = x;
            if (x > box.maxX) box.maxX = x;
            if (y < box.minY) box.minY = y;
            if (y > box.maxY) box.maxY = y;
        }
        for (let i = 0; i < 8; i += 1) {
            const nx = x + AROUND[i][0];
            const ny = y + AROUND[i][1];
            const next = ny * width + nx;
            if (inside(nx, ny) && labels[next] === -1) {
                labels[next] = label;
                queue.push(next);
            }
        }
    }
    return area;
}

/*
 * Ramer-Douglas-Peucker: keep the points that carry the shape and drop the ones on the way.
 *
 * Iterative rather than recursive. A boundary can be tens of thousands of points long and the
 * recursion depth follows the shape, so an awkward one overflows the stack -- on a board with
 * a ground-plane-sized paste opening, which is a real thing on a shield.
 */
function simplify(points, tolerance) {
    if (points.length < 4) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;

    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop();
        let worst = 0, at = -1;
        for (let i = first + 1; i < last; i += 1) {
            const distance = perpendicular(points[i], points[first], points[last]);
            if (distance > worst) { worst = distance; at = i; }
        }
        if (at !== -1 && worst > tolerance) {
            keep[at] = 1;
            stack.push([first, at], [at, last]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

function perpendicular(point, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return Math.hypot(point[0] - a[0], point[1] - a[1]);
    return Math.abs(dy * point[0] - dx * point[1] + b[0] * a[1] - b[1] * a[0]) / length;
}


/**
 * Turn an RGBA image upside down in place. `gl.readPixels` returns rows from
 * the bottom of the canvas up; images count downwards.
 */
export function flipRows(pixels, width, height) {
    const stride = width * 4;
    const row = new Uint8ClampedArray(stride);
    for (let top = 0, bottom = height - 1; top < bottom; top += 1, bottom -= 1) {
        const a = top * stride;
        const b = bottom * stride;
        row.set(pixels.subarray(a, a + stride));
        pixels.copyWithin(a, b, b + stride);
        pixels.set(row, b);
    }
    return pixels;
}

/**
 * Write each pixel's brightest channel into its alpha, in place: for a layer
 * rendered light-on-opaque-dark, where alpha is solid everywhere and the ink
 * is in the color. `traceLayer()` reads alpha.
 */
export function brightnessToAlpha(pixels) {
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i + 3] = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    return pixels;
}
