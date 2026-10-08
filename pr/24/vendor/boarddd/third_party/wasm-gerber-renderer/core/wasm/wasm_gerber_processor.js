let wasm;

function isLikeNone(x) {
    return x === undefined || x === null;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let WASM_VECTOR_LEN = 0;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

let cachedUint32ArrayMemory0 = null;

function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;

function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
/**
 * Initialize panic hook for better error messages in browser console
 */
export function init_panic_hook() {
    wasm.init_panic_hook();
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}
/**
 * Preflight a large JS-to-WASM input copy with catchable allocation failure.
 * @param {number} byte_count
 */
export function reserve_input_capacity(byte_count) {
    const ret = wasm.reserve_input_capacity(byte_count);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @returns {any}
 */
export function parse_gerber_layer(content, offset_x, offset_y) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_gerber_layer(ptr0, len0, offset_x, offset_y);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @param {boolean} preserve_arc_regions
 * @param {number} arc_tessellation_quality
 * @returns {any}
 */
export function parse_gerber_layer_with_options(content, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_gerber_layer_with_options(ptr0, len0, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @param {boolean} preserve_arc_regions
 * @param {number} arc_tessellation_quality
 * @returns {any}
 */
export function parse_gerber_layer_payload_with_options(content, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_gerber_layer_payload_with_options(ptr0, len0, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}
/**
 * Decompress a UNIX `compress` (`.Z`) stream, the per-file compression many
 * CAM tools apply to ODB++ `features` files. The output is capped at
 * `max_output_bytes`; the viewer charges it to the archive byte budget.
 * @param {Uint8Array} bytes
 * @param {number} max_output_bytes
 * @returns {Uint8Array}
 */
export function decompress_unix_z(bytes, max_output_bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decompress_unix_z(ptr0, len0, max_output_bytes);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Diagnostics of the most recent ODB++ layer parsed by this module instance
 * ("Skipped or approximated: ..."), or `undefined` when there were none.
 * Read it right after a parse or add call for an ODB++ layer envelope.
 * @returns {string | undefined}
 */
export function take_last_odb_diagnostics() {
    const ret = wasm.take_last_odb_diagnostics();
    let v1;
    if (ret[0] !== 0) {
        v1 = getStringFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v1;
}

/**
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @returns {any}
 */
export function parse_drill_layer(content, offset_x, offset_y) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_drill_layer(ptr0, len0, offset_x, offset_y);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

const BoundaryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_boundary_free(ptr >>> 0, 1));
/**
 * Boundary information for the entire Gerber layer
 */
export class Boundary {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Boundary.prototype);
        obj.__wbg_ptr = ptr;
        BoundaryFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BoundaryFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_boundary_free(ptr, 0);
    }
    /**
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     */
    constructor(min_x, max_x, min_y, max_y) {
        const ret = wasm.boundary_new(min_x, max_x, min_y, max_y);
        this.__wbg_ptr = ret >>> 0;
        BoundaryFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    get max_x() {
        const ret = wasm.boundary_max_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get max_y() {
        const ret = wasm.boundary_max_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get min_x() {
        const ret = wasm.boundary_min_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get min_y() {
        const ret = wasm.boundary_min_y(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Boundary.prototype[Symbol.dispose] = Boundary.prototype.free;

const GerberProcessorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gerberprocessor_free(ptr >>> 0, 1));
/**
 * Main Gerber processor with stateful WebGL renderer
 */
export class GerberProcessor {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GerberProcessorFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gerberprocessor_free(ptr, 0);
    }
    /**
     * Render one tile of a larger virtual canvas to the current WebGL canvas.
     *
     * The caller is expected to resize the WebGL canvas to `tile_width` x
     * `tile_height` before calling this method, then copy the result into the
     * final image at `tile_x`, `tile_y`.
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {number} export_width
     * @param {number} export_height
     * @param {number} tile_x
     * @param {number} tile_y
     * @param {number} tile_width
     * @param {number} tile_height
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @returns {string}
     */
    render_tile(active_layer_ids, color_data, export_width, export_height, tile_x, tile_y, tile_width, tile_height, zoom_x, zoom_y, offset_x, offset_y, alpha) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render_tile(this.__wbg_ptr, ptr0, len0, ptr1, len1, export_width, export_height, tile_x, tile_y, tile_width, tile_height, zoom_x, zoom_y, offset_x, offset_y, alpha);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Get the boundary of the parsed Gerber data for fitToView
     *
     * # Returns
     * * `Boundary` containing min/max x/y coordinates
     *
     * # Errors
     * * Returns error if parse() has not been called yet
     * @returns {Boundary}
     */
    get_boundary() {
        const ret = wasm.gerberprocessor_get_boundary(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Boundary.__wrap(ret[0]);
    }
    /**
     * Remove a layer from the renderer
     *
     * # Arguments
     * * `layer_id` - Layer ID returned from add_layer()
     *
     * # Returns
     * * `"remove_done"` signal on success
     * @param {number} layer_id
     * @returns {string}
     */
    remove_layer(layer_id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_remove_layer(this.__wbg_ptr, layer_id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Initialize with WebGL 2.0 context and explicit framebuffer size.
     *
     * This is intended for headless contexts that do not expose an HTML canvas.
     * @param {WebGL2RenderingContext} gl
     * @param {number} width
     * @param {number} height
     * @returns {string}
     */
    init_with_size(gl, width, height) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_init_with_size(this.__wbg_ptr, gl, width, height);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Add an Excellon / NC Drill file as a drill overlay.
     * @param {string} content
     * @returns {any}
     */
    add_drill_layer(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_drill_layer(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Recreate WebGL-owned resources after browser context restoration.
     *
     * This can recreate GPU resources only while parsed geometry is still retained.
     * After geometry has been released to reduce WASM memory, JS should rebuild
     * layers from the retained source file contents.
     * @param {WebGL2RenderingContext} gl
     * @returns {string}
     */
    restore_context(gl) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_restore_context(this.__wbg_ptr, gl);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Add a layer from geometry parsed in a worker or another WASM instance.
     * @param {any} parsed_layer
     * @returns {number}
     */
    add_parsed_layer(parsed_layer) {
        const ret = wasm.gerberprocessor_add_parsed_layer(this.__wbg_ptr, parsed_layer);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Render geometry to the canvas, optionally preserving existing canvas contents.
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @param {boolean} clear_canvas
     * @returns {string}
     */
    render_with_clear(active_layer_ids, color_data, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render_with_clear(this.__wbg_ptr, ptr0, len0, ptr1, len1, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Turn anti-aliased layer masks on or off (default off). Independent of
     * the minimum line width; applies to the viewer, screenshots and the
     * renderer API alike because they all go through this processor.
     * @param {boolean} enabled
     */
    set_anti_aliasing(enabled) {
        wasm.gerberprocessor_set_anti_aliasing(this.__wbg_ptr, enabled);
    }
    /**
     * Add a worker-produced render payload directly to WebGL buffers.
     * @param {any} render_payload
     * @returns {number}
     */
    add_render_payload(render_payload) {
        const ret = wasm.gerberprocessor_add_render_payload(this.__wbg_ptr, render_payload);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Get the boundary of one parsed user layer.
     * @param {number} layer_id
     * @returns {Boundary}
     */
    get_layer_boundary(layer_id) {
        const ret = wasm.gerberprocessor_get_layer_boundary(this.__wbg_ptr, layer_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Boundary.__wrap(ret[0]);
    }
    /**
     * @param {number} composite_id
     * @returns {string | undefined}
     */
    get_composite_error(composite_id) {
        const ret = wasm.gerberprocessor_get_composite_error(this.__wbg_ptr, composite_id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @param {number} composite_id
     * @param {number} x
     * @param {number} y
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {number}
     */
    pick_composite_area(composite_id, x, y, zoom_x, zoom_y, offset_x, offset_y) {
        const ret = wasm.gerberprocessor_pick_composite_area(this.__wbg_ptr, composite_id, x, y, zoom_x, zoom_y, offset_x, offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {number} composite_id
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    pick_composite_code(composite_id, x, y) {
        const ret = wasm.gerberprocessor_pick_composite_code(this.__wbg_ptr, composite_id, x, y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {number} composite_id
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     */
    set_composite_bounds(composite_id, min_x, max_x, min_y, max_y) {
        const ret = wasm.gerberprocessor_set_composite_bounds(this.__wbg_ptr, composite_id, min_x, max_x, min_y, max_y);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Add a new layer after translating its parsed geometry.
     *
     * # Arguments
     * * `content` - Gerber file content as string
     * * `offset_x` - Horizontal offset in parsed Gerber world units
     * * `offset_y` - Vertical offset in parsed Gerber world units
     *
     * # Returns
     * * Layer ID (u32) for tracking this layer
     * @param {string} content
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {number}
     */
    add_layer_with_offset(content, offset_x, offset_y) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_layer_with_offset(this.__wbg_ptr, ptr0, len0, offset_x, offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Return true if an interaction layer is already stored for this layer id.
     * @param {number} layer_id
     * @returns {boolean}
     */
    has_interaction_layer(layer_id) {
        const ret = wasm.gerberprocessor_has_interaction_layer(this.__wbg_ptr, layer_id);
        return ret !== 0;
    }
    /**
     * @param {number} composite_id
     * @param {boolean} inverted
     */
    set_composite_inverted(composite_id, inverted) {
        const ret = wasm.gerberprocessor_set_composite_inverted(this.__wbg_ptr, composite_id, inverted);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} layer_id
     * @param {any} interaction_payload
     */
    add_interaction_payload(layer_id, interaction_payload) {
        const ret = wasm.gerberprocessor_add_interaction_payload(this.__wbg_ptr, layer_id, interaction_payload);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    end_composite_selection() {
        const ret = wasm.gerberprocessor_end_composite_selection(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     */
    release_composite_cache(composite_id) {
        const ret = wasm.gerberprocessor_release_composite_cache(this.__wbg_ptr, composite_id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} layer_id
     * @param {number} pixels
     * @param {number} world
     * @returns {string}
     */
    set_layer_inner_outline(layer_id, pixels, world) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_set_layer_inner_outline(this.__wbg_ptr, layer_id, pixels, world);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Build and store the interaction layer for an already-loaded render layer.
     *
     * Call this after `add_render_payload` to attach interaction data without
     * re-uploading render geometry. The gerber content is parsed a second time
     * but no GPU buffers are allocated.
     * @param {number} layer_id
     * @param {string} content
     * @param {number} offset_x
     * @param {number} offset_y
     */
    build_layer_interactions(layer_id, content, offset_x, offset_y) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_build_layer_interactions(this.__wbg_ptr, layer_id, ptr0, len0, offset_x, offset_y);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    clear_interaction_layers() {
        wasm.gerberprocessor_clear_interaction_layers(this.__wbg_ptr);
    }
    /**
     * @param {number} composite_id
     * @returns {Uint32Array}
     */
    get_composite_area_codes(composite_id) {
        const ret = wasm.gerberprocessor_get_composite_area_codes(this.__wbg_ptr, composite_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint32Array} layer_ids
     * @param {number} x
     * @param {number} y
     * @param {number} tolerance
     * @returns {any}
     */
    pick_interaction_feature(layer_ids, x, y, tolerance) {
        const ptr0 = passArray32ToWasm0(layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_pick_interaction_feature(this.__wbg_ptr, ptr0, len0, x, y, tolerance);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Render into a fresh offscreen framebuffer and return bottom-up RGBA pixels.
     *
     * The target is always initialized to transparent black. `clear_canvas`
     * remains in the ABI for compatibility but cannot preserve contents
     * across calls because each call owns a new framebuffer.
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @param {boolean} clear_canvas
     * @returns {Uint8Array}
     */
    render_pixels_with_clear(active_layer_ids, color_data, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas) {
        const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_render_pixels_with_clear(this.__wbg_ptr, ptr0, len0, ptr1, len1, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * @param {number} composite_id
     * @param {number} start_y
     * @param {number} row_count
     */
    scan_composite_area_band(composite_id, start_y, row_count) {
        const ret = wasm.gerberprocessor_scan_composite_area_band(this.__wbg_ptr, composite_id, start_y, row_count);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} pixels
     */
    set_drill_outline_pixels(pixels) {
        wasm.gerberprocessor_set_drill_outline_pixels(this.__wbg_ptr, pixels);
    }
    /**
     * @param {boolean} enabled
     */
    set_interactions_enabled(enabled) {
        wasm.gerberprocessor_set_interactions_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Configure how regions containing arcs are parsed.
     *
     * When true, arc-containing regions are preserved for analytic WebGL rendering.
     * When false, arcs are approximated into contour points before triangulation.
     * @param {boolean} preserve_arc_regions
     */
    set_preserve_arc_regions(preserve_arc_regions) {
        wasm.gerberprocessor_set_preserve_arc_regions(this.__wbg_ptr, preserve_arc_regions);
    }
    /**
     * @param {number} composite_id
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     */
    update_composite_sources(composite_id, source_layer_ids, visible_bits) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_update_composite_sources(this.__wbg_ptr, composite_id, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     */
    begin_composite_area_scan(composite_id) {
        const ret = wasm.gerberprocessor_begin_composite_area_scan(this.__wbg_ptr, composite_id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     * @returns {any}
     */
    get_composite_diagnostics(composite_id) {
        const ret = wasm.gerberprocessor_get_composite_diagnostics(this.__wbg_ptr, composite_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Recreate WebGL-owned resources with an explicit framebuffer size.
     * @param {WebGL2RenderingContext} gl
     * @param {number} width
     * @param {number} height
     * @returns {string}
     */
    restore_context_with_size(gl, width, height) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_restore_context_with_size(this.__wbg_ptr, gl, width, height);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} composite_id
     */
    cancel_composite_area_scan(composite_id) {
        const ret = wasm.gerberprocessor_cancel_composite_area_scan(this.__wbg_ptr, composite_id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     * @returns {Uint32Array}
     */
    finish_composite_area_scan(composite_id) {
        const ret = wasm.gerberprocessor_finish_composite_area_scan(this.__wbg_ptr, composite_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} composite_id
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {string}
     */
    render_composite_selection(composite_id, zoom_x, zoom_y, offset_x, offset_y) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_render_composite_selection(this.__wbg_ptr, composite_id, zoom_x, zoom_y, offset_x, offset_y);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} composite_id
     * @param {Uint8Array} visible_bits
     */
    set_composite_visible_bits(composite_id, visible_bits) {
        const ptr0 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_set_composite_visible_bits(this.__wbg_ptr, composite_id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     * @param {number} byte_index
     * @param {number} value
     */
    set_composite_visible_byte(composite_id, byte_index, value) {
        const ret = wasm.gerberprocessor_set_composite_visible_byte(this.__wbg_ptr, composite_id, byte_index, value);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Configure minimum display size for tiny rendered features.
     *
     * `0.0` disables the adjustment. Current implementation applies to
     * analytic line and arc strokes in the WebGL renderer.
     * @param {number} pixels
     */
    set_minimum_feature_pixels(pixels) {
        wasm.gerberprocessor_set_minimum_feature_pixels(this.__wbg_ptr, pixels);
    }
    /**
     * @param {string} content
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {any}
     */
    add_drill_layer_with_offset(content, offset_x, offset_y) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_drill_layer_with_offset(this.__wbg_ptr, ptr0, len0, offset_x, offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} layer_id
     * @param {number} feature_id
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {string}
     */
    render_interaction_highlight(layer_id, feature_id, zoom_x, zoom_y, offset_x, offset_y) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_render_interaction_highlight(this.__wbg_ptr, layer_id, feature_id, zoom_x, zoom_y, offset_x, offset_y);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {Uint8Array} blend_modes
     * @param {number} export_width
     * @param {number} export_height
     * @param {number} tile_x
     * @param {number} tile_y
     * @param {number} tile_width
     * @param {number} tile_height
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @returns {string}
     */
    render_tile_with_blend_modes(active_layer_ids, color_data, blend_modes, export_width, export_height, tile_x, tile_y, tile_width, tile_height, zoom_x, zoom_y, offset_x, offset_y, alpha) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(blend_modes, wasm.__wbindgen_malloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render_tile_with_blend_modes(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, export_width, export_height, tile_x, tile_y, tile_width, tile_height, zoom_x, zoom_y, offset_x, offset_y, alpha);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Configure arc tessellation quality for legacy approximated region arcs.
     *
     * `0` = low, `1` = normal, `2` = high.
     * @param {number} arc_tessellation_quality
     */
    set_arc_tessellation_quality(arc_tessellation_quality) {
        wasm.gerberprocessor_set_arc_tessellation_quality(this.__wbg_ptr, arc_tessellation_quality);
    }
    /**
     * Anti-aliasing state: `enabled`, `status` (off, pending, ready,
     * size-limited, unsupported, unexpected), whether the shared multisample
     * target and its stencil are allocated, the size a memory-limited
     * allocation failed at, the code of an unexpected GL failure, and `mode`,
     * the mode the masks were last drawn in ("multisampled" or
     * "point-sampled"), which is uniform across a frame.
     * @returns {any}
     */
    get_anti_aliasing_diagnostics() {
        const ret = wasm.gerberprocessor_get_anti_aliasing_diagnostics(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} composite_id
     * @param {number} start_y
     * @param {number} row_count
     * @returns {Uint32Array}
     */
    get_composite_area_codes_band(composite_id, start_y, row_count) {
        const ret = wasm.gerberprocessor_get_composite_area_codes_band(this.__wbg_ptr, composite_id, start_y, row_count);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {string} target_content
     * @param {number} target_offset_x
     * @param {number} target_offset_y
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     * @returns {number}
     */
    add_inverted_layer_with_bounds(target_content, target_offset_x, target_offset_y, min_x, max_x, min_y, max_y) {
        const ptr0 = passStringToWasm0(target_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_inverted_layer_with_bounds(this.__wbg_ptr, ptr0, len0, target_offset_x, target_offset_y, min_x, max_x, min_y, max_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} layer_ids
     * @param {number} x
     * @param {number} y
     * @param {number} tolerance
     * @param {number} after_layer_id
     * @param {number} after_feature_id
     * @returns {any}
     */
    pick_interaction_feature_after(layer_ids, x, y, tolerance, after_layer_id, after_feature_id) {
        const ptr0 = passArray32ToWasm0(layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_pick_interaction_feature_after(this.__wbg_ptr, ptr0, len0, x, y, tolerance, after_layer_id, after_feature_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} layer_id
     * @param {number} pixels
     * @returns {string}
     */
    set_layer_feature_extra_pixels(layer_id, pixels) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_set_layer_feature_extra_pixels(this.__wbg_ptr, layer_id, pixels);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     * @param {boolean} inverted
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     * @returns {number}
     */
    add_composite_layer_with_bounds(source_layer_ids, visible_bits, inverted, min_x, max_x, min_y, max_y) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_layer_with_bounds(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, min_x, max_x, min_y, max_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add an inverted display layer by filling a board outline and clearing
     * the target layer geometry from it.
     * @param {string} target_content
     * @param {string} outline_content
     * @param {number} target_offset_x
     * @param {number} target_offset_y
     * @param {number} outline_offset_x
     * @param {number} outline_offset_y
     * @returns {number}
     */
    add_inverted_layer_with_outline(target_content, outline_content, target_offset_x, target_offset_y, outline_offset_x, outline_offset_y) {
        const ptr0 = passStringToWasm0(target_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(outline_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_inverted_layer_with_outline(this.__wbg_ptr, ptr0, len0, ptr1, len1, target_offset_x, target_offset_y, outline_offset_x, outline_offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} composite_id
     * @param {number} selected_code
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {string}
     */
    render_composite_area_highlight(composite_id, selected_code, zoom_x, zoom_y, offset_x, offset_y) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_render_composite_area_highlight(this.__wbg_ptr, composite_id, selected_code, zoom_x, zoom_y, offset_x, offset_y);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     * @param {boolean} inverted
     * @param {number} outline_layer_id
     * @returns {number}
     */
    add_composite_layer_with_outline(source_layer_ids, visible_bits, inverted, outline_layer_id) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_layer_with_outline(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, outline_layer_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {string} preset
     * @param {boolean} inverted
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     * @returns {number}
     */
    add_composite_preset_with_bounds(source_layer_ids, preset, inverted, min_x, max_x, min_y, max_y) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(preset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_preset_with_bounds(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, min_x, max_x, min_y, max_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {string} preset
     * @param {boolean} inverted
     * @param {number} outline_layer_id
     * @returns {number}
     */
    add_composite_preset_with_outline(source_layer_ids, preset, inverted, outline_layer_id) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(preset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_preset_with_outline(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, outline_layer_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {Uint8Array} blend_modes
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @param {boolean} clear_canvas
     * @returns {string}
     */
    render_with_clear_and_blend_modes(active_layer_ids, color_data, blend_modes, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(blend_modes, wasm.__wbindgen_malloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render_with_clear_and_blend_modes(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * @param {string} target_content
     * @param {number} target_offset_x
     * @param {number} target_offset_y
     * @param {boolean} target_preserve_arc_regions
     * @param {number} target_arc_tessellation_quality
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     * @returns {number}
     */
    add_inverted_layer_with_bounds_options(target_content, target_offset_x, target_offset_y, target_preserve_arc_regions, target_arc_tessellation_quality, min_x, max_x, min_y, max_y) {
        const ptr0 = passStringToWasm0(target_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_inverted_layer_with_bounds_options(this.__wbg_ptr, ptr0, len0, target_offset_x, target_offset_y, target_preserve_arc_regions, target_arc_tessellation_quality, min_x, max_x, min_y, max_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add an inverted display layer while preserving the parse settings of
     * independently prepared target and outline sources.
     * @param {string} target_content
     * @param {string} outline_content
     * @param {number} target_offset_x
     * @param {number} target_offset_y
     * @param {boolean} target_preserve_arc_regions
     * @param {number} target_arc_tessellation_quality
     * @param {number} outline_offset_x
     * @param {number} outline_offset_y
     * @param {boolean} outline_preserve_arc_regions
     * @param {number} outline_arc_tessellation_quality
     * @returns {number}
     */
    add_inverted_layer_with_outline_options(target_content, outline_content, target_offset_x, target_offset_y, target_preserve_arc_regions, target_arc_tessellation_quality, outline_offset_x, outline_offset_y, outline_preserve_arc_regions, outline_arc_tessellation_quality) {
        const ptr0 = passStringToWasm0(target_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(outline_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_inverted_layer_with_outline_options(this.__wbg_ptr, ptr0, len0, ptr1, len1, target_offset_x, target_offset_y, target_preserve_arc_regions, target_arc_tessellation_quality, outline_offset_x, outline_offset_y, outline_preserve_arc_regions, outline_arc_tessellation_quality);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Create a new GerberProcessor instance
     */
    constructor() {
        const ret = wasm.gerberprocessor_new();
        this.__wbg_ptr = ret >>> 0;
        GerberProcessorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     * @param {boolean} inverted
     * @param {number} outline_layer_id
     * @param {string} outline_content
     * @param {number} outline_offset_x
     * @param {number} outline_offset_y
     * @returns {number}
     */
    add_composite_layer_with_outline_content(source_layer_ids, visible_bits, inverted, outline_layer_id, outline_content, outline_offset_x, outline_offset_y) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(outline_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_layer_with_outline_content(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, outline_layer_id, ptr2, len2, outline_offset_x, outline_offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {Uint8Array} blend_modes
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @param {boolean} clear_canvas
     * @returns {Uint8Array}
     */
    render_pixels_with_clear_and_blend_modes(active_layer_ids, color_data, blend_modes, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas) {
        const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(blend_modes, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_render_pixels_with_clear_and_blend_modes(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v4;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     * @param {boolean} inverted
     * @param {number} outline_layer_id
     * @param {string} outline_content
     * @param {number} outline_offset_x
     * @param {number} outline_offset_y
     * @param {boolean} outline_preserve_arc_regions
     * @param {number} outline_arc_tessellation_quality
     * @returns {number}
     */
    add_composite_layer_with_outline_content_options(source_layer_ids, visible_bits, inverted, outline_layer_id, outline_content, outline_offset_x, outline_offset_y, outline_preserve_arc_regions, outline_arc_tessellation_quality) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(outline_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_layer_with_outline_content_options(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, outline_layer_id, ptr2, len2, outline_offset_x, outline_offset_y, outline_preserve_arc_regions, outline_arc_tessellation_quality);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Initialize with WebGL 2.0 context
     *
     * # Arguments
     * * `gl` - WebGL 2.0 rendering context from canvas
     *
     * # Returns
     * * `"init_done"` signal on success
     * @param {WebGL2RenderingContext} gl
     * @returns {string}
     */
    init(gl) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_init(this.__wbg_ptr, gl);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Clear all layers
     *
     * # Returns
     * * `"clear_done"` signal on success
     * @returns {string}
     */
    clear() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_clear(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * DEPRECATED: Use add_layer() instead
     * Parse Gerber file data and create renderer
     *
     * # Arguments
     * * `content` - Gerber file content as string
     *
     * # Returns
     * * `"parse_done"` signal on success
     * @param {string} content
     * @returns {string}
     */
    parse(content) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_parse(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Render geometry to FBOs and composite to canvas
     *
     * # Arguments
     * * `active_layer_ids` - Array of layer IDs to render (in order)
     * * `color_data` - Flat array of [r, g, b] or [r, g, b, a] for each active layer
     * * `zoom_x` - Horizontal zoom factor
     * * `zoom_y` - Vertical zoom factor
     * * `offset_x` - Horizontal pan offset
     * * `offset_y` - Vertical pan offset
     * * `alpha` - Global alpha for all layers
     *
     * # Returns
     * * `"render_done"` signal on success
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @returns {string}
     */
    render(active_layer_ids, color_data, zoom_x, zoom_y, offset_x, offset_y, alpha) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render(this.__wbg_ptr, ptr0, len0, ptr1, len1, zoom_x, zoom_y, offset_x, offset_y, alpha);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Resize framebuffers when canvas dimensions change (e.g., fullscreen)
     *
     * # Returns
     * * `"resize_done"` signal on success
     *
     * # Errors
     * * Returns error if renderer is not initialized
     * @returns {string}
     */
    resize() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_resize(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Add a new layer to the renderer
     *
     * # Arguments
     * * `content` - Gerber file content as string
     *
     * # Returns
     * * Layer ID (u32) for tracking this layer
     * @param {string} content
     * @returns {number}
     */
    add_layer(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_layer(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Resize framebuffers to explicit dimensions.
     * @param {number} width
     * @param {number} height
     * @returns {string}
     */
    resize_to(width, height) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_resize_to(this.__wbg_ptr, width, height);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) GerberProcessor.prototype[Symbol.dispose] = GerberProcessor.prototype.free;

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg___wbindgen_boolean_get_6d5a1ee65bab5f68 = function(arg0) {
        const v = arg0;
        const ret = typeof(v) === 'boolean' ? v : undefined;
        return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
    };
    imports.wbg.__wbg___wbindgen_is_null_5e69f72e906cc57c = function(arg0) {
        const ret = arg0 === null;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_string_fbb76cb2940daafd = function(arg0) {
        const ret = typeof(arg0) === 'string';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_undefined_2d472862bd29a478 = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_number_get_a20bf9b85341449d = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'number' ? obj : undefined;
        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    };
    imports.wbg.__wbg___wbindgen_string_get_e4f06c90489ad01b = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'string' ? obj : undefined;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_throw_b855445ff6a94295 = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_activeTexture_48c9bc28acaaa54d = function(arg0, arg1) {
        arg0.activeTexture(arg1 >>> 0);
    };
    imports.wbg.__wbg_attachShader_4729f6e4e28e3c47 = function(arg0, arg1, arg2) {
        arg0.attachShader(arg1, arg2);
    };
    imports.wbg.__wbg_bindAttribLocation_d241d5fdbd2a907d = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.bindAttribLocation(arg1, arg2 >>> 0, getStringFromWasm0(arg3, arg4));
    };
    imports.wbg.__wbg_bindBuffer_54099db8f6d4b751 = function(arg0, arg1, arg2) {
        arg0.bindBuffer(arg1 >>> 0, arg2);
    };
    imports.wbg.__wbg_bindFramebuffer_847f466d072551ab = function(arg0, arg1, arg2) {
        arg0.bindFramebuffer(arg1 >>> 0, arg2);
    };
    imports.wbg.__wbg_bindRenderbuffer_6d55f6b17a2a967a = function(arg0, arg1, arg2) {
        arg0.bindRenderbuffer(arg1 >>> 0, arg2);
    };
    imports.wbg.__wbg_bindSampler_1cb7b3a2885d276f = function(arg0, arg1, arg2) {
        arg0.bindSampler(arg1 >>> 0, arg2);
    };
    imports.wbg.__wbg_bindTexture_ada4abace31e0749 = function(arg0, arg1, arg2) {
        arg0.bindTexture(arg1 >>> 0, arg2);
    };
    imports.wbg.__wbg_bindVertexArray_c061c24c9d2fbfef = function(arg0, arg1) {
        arg0.bindVertexArray(arg1);
    };
    imports.wbg.__wbg_blendEquationSeparate_8fd8b8c2468c0d49 = function(arg0, arg1, arg2) {
        arg0.blendEquationSeparate(arg1 >>> 0, arg2 >>> 0);
    };
    imports.wbg.__wbg_blendEquation_61323fac068c262a = function(arg0, arg1) {
        arg0.blendEquation(arg1 >>> 0);
    };
    imports.wbg.__wbg_blendFuncSeparate_efd2b4ec166727db = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.blendFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
    };
    imports.wbg.__wbg_blendFunc_328efc81a0f974bb = function(arg0, arg1, arg2) {
        arg0.blendFunc(arg1 >>> 0, arg2 >>> 0);
    };
    imports.wbg.__wbg_blitFramebuffer_574724ebc0e9dba2 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
        arg0.blitFramebuffer(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0);
    };
    imports.wbg.__wbg_bufferData_121b54242e0dabb1 = function(arg0, arg1, arg2, arg3) {
        arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
    };
    imports.wbg.__wbg_bufferData_2a3d4047e152548f = function(arg0, arg1, arg2, arg3) {
        arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
    };
    imports.wbg.__wbg_bufferSubData_0ed75aa014fd4a8e = function(arg0, arg1, arg2, arg3) {
        arg0.bufferSubData(arg1 >>> 0, arg2, arg3);
    };
    imports.wbg.__wbg_byteLength_4d9230ccd65ab9d6 = function(arg0) {
        const ret = arg0.byteLength;
        return ret;
    };
    imports.wbg.__wbg_canvas_6f15478b1f103abb = function(arg0) {
        const ret = arg0.canvas;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_checkFramebufferStatus_97c355c5aa52375c = function(arg0, arg1) {
        const ret = arg0.checkFramebufferStatus(arg1 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_clearColor_e7b3ddf4fdaaecaa = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.clearColor(arg1, arg2, arg3, arg4);
    };
    imports.wbg.__wbg_clearStencil_fe0fe187c10f40b9 = function(arg0, arg1) {
        arg0.clearStencil(arg1);
    };
    imports.wbg.__wbg_clear_bd1d14ac12f3d45d = function(arg0, arg1) {
        arg0.clear(arg1 >>> 0);
    };
    imports.wbg.__wbg_colorMask_27f4ed2cabe913b5 = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.colorMask(arg1 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
    };
    imports.wbg.__wbg_compileShader_b6b9c3922553e2b5 = function(arg0, arg1) {
        arg0.compileShader(arg1);
    };
    imports.wbg.__wbg_createBuffer_5d773097dcb49bc5 = function(arg0) {
        const ret = arg0.createBuffer();
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_createFramebuffer_0f0b136542e6a783 = function(arg0) {
        const ret = arg0.createFramebuffer();
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_createProgram_76f1b3b1649a6a70 = function(arg0) {
        const ret = arg0.createProgram();
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_createRenderbuffer_a2ac822093e282ae = function(arg0) {
        const ret = arg0.createRenderbuffer();
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_createShader_8956396370304fdd = function(arg0, arg1) {
        const ret = arg0.createShader(arg1 >>> 0);
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_createTexture_b4154609b3be9454 = function(arg0) {
        const ret = arg0.createTexture();
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_createVertexArray_0060b507a03b9521 = function(arg0) {
        const ret = arg0.createVertexArray();
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_deleteBuffer_1d3ed354bfcc9cc1 = function(arg0, arg1) {
        arg0.deleteBuffer(arg1);
    };
    imports.wbg.__wbg_deleteFramebuffer_3c4629acadbd9c90 = function(arg0, arg1) {
        arg0.deleteFramebuffer(arg1);
    };
    imports.wbg.__wbg_deleteProgram_57e178b9a4712e5d = function(arg0, arg1) {
        arg0.deleteProgram(arg1);
    };
    imports.wbg.__wbg_deleteRenderbuffer_e0b163b9d644c48a = function(arg0, arg1) {
        arg0.deleteRenderbuffer(arg1);
    };
    imports.wbg.__wbg_deleteShader_fc28d3e4e0b5dce1 = function(arg0, arg1) {
        arg0.deleteShader(arg1);
    };
    imports.wbg.__wbg_deleteTexture_e8ccb15bc8feb76d = function(arg0, arg1) {
        arg0.deleteTexture(arg1);
    };
    imports.wbg.__wbg_deleteVertexArray_39ce2ddddad98d30 = function(arg0, arg1) {
        arg0.deleteVertexArray(arg1);
    };
    imports.wbg.__wbg_disableVertexAttribArray_b05c9e7b1b3ecc2f = function(arg0, arg1) {
        arg0.disableVertexAttribArray(arg1 >>> 0);
    };
    imports.wbg.__wbg_disable_8a379385ec68f6aa = function(arg0, arg1) {
        arg0.disable(arg1 >>> 0);
    };
    imports.wbg.__wbg_drawArraysInstanced_d5a66fa2c3a32cda = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.drawArraysInstanced(arg1 >>> 0, arg2, arg3, arg4);
    };
    imports.wbg.__wbg_drawArrays_42ee4f71cad07136 = function(arg0, arg1, arg2, arg3) {
        arg0.drawArrays(arg1 >>> 0, arg2, arg3);
    };
    imports.wbg.__wbg_drawBuffers_58b7685a9dd4e003 = function(arg0, arg1) {
        arg0.drawBuffers(arg1);
    };
    imports.wbg.__wbg_enableVertexAttribArray_10d871fb9fd0846c = function(arg0, arg1) {
        arg0.enableVertexAttribArray(arg1 >>> 0);
    };
    imports.wbg.__wbg_enable_e086a91d756e13d4 = function(arg0, arg1) {
        arg0.enable(arg1 >>> 0);
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_framebufferRenderbuffer_0fb26ace6cfe35c5 = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.framebufferRenderbuffer(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
    };
    imports.wbg.__wbg_framebufferTexture2D_52df07a1bb4d540a = function(arg0, arg1, arg2, arg3, arg4, arg5) {
        arg0.framebufferTexture2D(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5);
    };
    imports.wbg.__wbg_from_a4ad7cbddd0d7135 = function(arg0) {
        const ret = Array.from(arg0);
        return ret;
    };
    imports.wbg.__wbg_getError_63344ab78b980409 = function(arg0) {
        const ret = arg0.getError();
        return ret;
    };
    imports.wbg.__wbg_getParameter_1b50ca7ab8b81a6c = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.getParameter(arg1 >>> 0);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_getProgramInfoLog_579753d7443e93d0 = function(arg0, arg1, arg2) {
        const ret = arg1.getProgramInfoLog(arg2);
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_getProgramParameter_c7c229864f96a134 = function(arg0, arg1, arg2) {
        const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_getShaderInfoLog_77e0c47daa4370bb = function(arg0, arg1, arg2) {
        const ret = arg1.getShaderInfoLog(arg2);
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_getShaderParameter_e3163f97690735a5 = function(arg0, arg1, arg2) {
        const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_getUniformLocation_595d98b1f60ef0bd = function(arg0, arg1, arg2, arg3) {
        const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_get_7bed016f185add81 = function(arg0, arg1) {
        const ret = arg0[arg1 >>> 0];
        return ret;
    };
    imports.wbg.__wbg_get_efcb449f58ec27c2 = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.get(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_get_index_bf9423c9fc9a6058 = function(arg0, arg1) {
        const ret = arg0[arg1 >>> 0];
        return ret;
    };
    imports.wbg.__wbg_height_119077665279308c = function(arg0) {
        const ret = arg0.height;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Float32Array_b5aca6cdb4c3cac9 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Float32Array;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_HtmlCanvasElement_3e2e95b109dae976 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof HTMLCanvasElement;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Uint32Array_49eaef1401bd8621 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Uint32Array;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_isContextLost_39ddc15f15134247 = function(arg0) {
        const ret = arg0.isContextLost();
        return ret;
    };
    imports.wbg.__wbg_isEnabled_70d65043ac834ae5 = function(arg0, arg1) {
        const ret = arg0.isEnabled(arg1 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_length_58bec3c3f0487eb5 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_length_98176481f29eb789 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_length_cdd215e10d9dd507 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_linkProgram_18ffcc2016a8ef92 = function(arg0, arg1) {
        arg0.linkProgram(arg1);
    };
    imports.wbg.__wbg_new_1acc0b6eea89d040 = function() {
        const ret = new Object();
        return ret;
    };
    imports.wbg.__wbg_new_4738dc8f520107dd = function(arg0) {
        const ret = new Uint32Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return ret;
    };
    imports.wbg.__wbg_new_c3f9ad0c6987ae9d = function(arg0) {
        const ret = new Float32Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_new_e17d9f43105b08be = function() {
        const ret = new Array();
        return ret;
    };
    imports.wbg.__wbg_new_from_slice_7943307099c96d15 = function(arg0, arg1) {
        const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_new_with_length_28efd1ab3e435499 = function(arg0) {
        const ret = new Float32Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_new_with_length_df9a19d083a824bc = function(arg0) {
        const ret = new Uint32Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_pixelStorei_bb82795e08644ed9 = function(arg0, arg1, arg2) {
        arg0.pixelStorei(arg1 >>> 0, arg2);
    };
    imports.wbg.__wbg_prototypesetcall_08c6532019b121d3 = function(arg0, arg1, arg2) {
        Uint32Array.prototype.set.call(getArrayU32FromWasm0(arg0, arg1), arg2);
    };
    imports.wbg.__wbg_prototypesetcall_9e380fea31826508 = function(arg0, arg1, arg2) {
        Float32Array.prototype.set.call(getArrayF32FromWasm0(arg0, arg1), arg2);
    };
    imports.wbg.__wbg_push_df81a39d04db858c = function(arg0, arg1) {
        const ret = arg0.push(arg1);
        return ret;
    };
    imports.wbg.__wbg_readBuffer_9f02c1916f858a32 = function(arg0, arg1) {
        arg0.readBuffer(arg1 >>> 0);
    };
    imports.wbg.__wbg_readPixels_e6f5d2b47fa47a8a = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
        arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7 === 0 ? undefined : getArrayU8FromWasm0(arg7, arg8));
    }, arguments) };
    imports.wbg.__wbg_renderbufferStorageMultisample_27bb7c36f04a927f = function(arg0, arg1, arg2, arg3, arg4, arg5) {
        arg0.renderbufferStorageMultisample(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
    };
    imports.wbg.__wbg_renderbufferStorage_c0da78888bd26a9d = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.renderbufferStorage(arg1 >>> 0, arg2 >>> 0, arg3, arg4);
    };
    imports.wbg.__wbg_set_c2abbebe8b9ebee1 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = Reflect.set(arg0, arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_set_eaa55bcb7597ecca = function(arg0, arg1, arg2) {
        arg0.set(getArrayF32FromWasm0(arg1, arg2));
    };
    imports.wbg.__wbg_set_fed9f2d08c1c01ae = function(arg0, arg1, arg2) {
        arg0.set(getArrayU32FromWasm0(arg1, arg2));
    };
    imports.wbg.__wbg_shaderSource_3d2fab949529ee31 = function(arg0, arg1, arg2, arg3) {
        arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
    };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_stencilFuncSeparate_c7b312390e26ce2b = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.stencilFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
    };
    imports.wbg.__wbg_stencilFunc_13722ed24071ed5e = function(arg0, arg1, arg2, arg3) {
        arg0.stencilFunc(arg1 >>> 0, arg2, arg3 >>> 0);
    };
    imports.wbg.__wbg_stencilMaskSeparate_d23bea80f02b7026 = function(arg0, arg1, arg2) {
        arg0.stencilMaskSeparate(arg1 >>> 0, arg2 >>> 0);
    };
    imports.wbg.__wbg_stencilMask_3fcd63c1452bf133 = function(arg0, arg1) {
        arg0.stencilMask(arg1 >>> 0);
    };
    imports.wbg.__wbg_stencilOpSeparate_779b981c744101cd = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.stencilOpSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
    };
    imports.wbg.__wbg_stencilOp_aa93d65e3452e9ce = function(arg0, arg1, arg2, arg3) {
        arg0.stencilOp(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0);
    };
    imports.wbg.__wbg_texImage2D_9bdba72682cc4411 = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
        arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9 === 0 ? undefined : getArrayU8FromWasm0(arg9, arg10));
    }, arguments) };
    imports.wbg.__wbg_texParameteri_b2871a22f57e806d = function(arg0, arg1, arg2, arg3) {
        arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
    };
    imports.wbg.__wbg_texSubImage2D_651a50507237c59f = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
        arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9 === 0 ? undefined : getArrayU8FromWasm0(arg9, arg10));
    }, arguments) };
    imports.wbg.__wbg_uniform1f_faef7d3063c804a5 = function(arg0, arg1, arg2) {
        arg0.uniform1f(arg1, arg2);
    };
    imports.wbg.__wbg_uniform1i_fe4307a416c7e7aa = function(arg0, arg1, arg2) {
        arg0.uniform1i(arg1, arg2);
    };
    imports.wbg.__wbg_uniform1ui_babec07bde75babc = function(arg0, arg1, arg2) {
        arg0.uniform1ui(arg1, arg2 >>> 0);
    };
    imports.wbg.__wbg_uniform2f_24cdd97984906bea = function(arg0, arg1, arg2, arg3) {
        arg0.uniform2f(arg1, arg2, arg3);
    };
    imports.wbg.__wbg_uniform4fv_8fd48d16c1040c6a = function(arg0, arg1, arg2, arg3) {
        arg0.uniform4fv(arg1, getArrayF32FromWasm0(arg2, arg3));
    };
    imports.wbg.__wbg_uniformMatrix3fv_45ee220dfb318eee = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.uniformMatrix3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
    };
    imports.wbg.__wbg_useProgram_20101ed5f7e0d637 = function(arg0, arg1) {
        arg0.useProgram(arg1);
    };
    imports.wbg.__wbg_vertexAttrib1f_fb83b2e64d169449 = function(arg0, arg1, arg2) {
        arg0.vertexAttrib1f(arg1 >>> 0, arg2);
    };
    imports.wbg.__wbg_vertexAttribDivisor_a03c25c88e81ab48 = function(arg0, arg1, arg2) {
        arg0.vertexAttribDivisor(arg1 >>> 0, arg2 >>> 0);
    };
    imports.wbg.__wbg_vertexAttribPointer_316e3d795c40b758 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
        arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
    };
    imports.wbg.__wbg_viewport_774feeb955171e3d = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.viewport(arg1, arg2, arg3, arg4);
    };
    imports.wbg.__wbg_width_9ea2df52b5d2c909 = function(arg0) {
        const ret = arg0.width;
        return ret;
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_cd07b1914aa3d62c = function(arg0, arg1) {
        // Cast intrinsic for `Ref(Slice(F32)) -> NamedExternref("Float32Array")`.
        const ret = getArrayF32FromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
        // Cast intrinsic for `F64 -> Externref`.
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('wasm_gerber_processor_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
