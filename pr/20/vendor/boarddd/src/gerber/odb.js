// boarddd/gerber: ODB++ jobs as renderer layers, in the browser (and Node 18+). Wraps the upstream ODB++ loader
// vendored in third_party/wasm-gerber-renderer/odb (job trees, matrix, layer envelopes); the wasm renderer reads
// the `%ODB++LAYER%` envelopes like Gerber/Excellon text. ZIPs are read by ./odb-zip.js, TAR/TGZ by upstream.
import {
  collectOdbLayerSourcesFromTree,
  createOdbTreeFromFiles,
  odbTreeOptions,
} from "../../third_party/wasm-gerber-renderer/odb/index.js";
import { gunzip, isGzipBytes } from "../../third_party/wasm-gerber-renderer/odb/archive/gzip.js";
import { createTarJobTree } from "../../third_party/wasm-gerber-renderer/odb/archive/job-tree.js";
import { parseTar } from "../../third_party/wasm-gerber-renderer/odb/archive/tar.js";
import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_TAR_EXPANDED_SIZE_BYTES,
} from "../../third_party/wasm-gerber-renderer/odb/config.js";
import { createZipBytesJobTree } from "./odb-zip.js";

const noop = () => {};

function isZipBytes(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input.arrayBuffer === "function") return new Uint8Array(await input.arrayBuffer());
  throw new TypeError("loadOdbJob: expected a File/Blob, ArrayBuffer, Uint8Array or a list of files");
}

/**
 * Read an ODB++ job into renderer layer records `{ name, kind, source }` (kind "gerber" or "drill"; `source`
 * is the text to hand to the renderer, like a Gerber or Excellon file's). `name` is a Gerber-style file name
 * (`f.cu.gtl`, `b.mask.gbs`, `drill_plated_f.cu-b.cu.drl`, `profile`) so name-based layer classification works.
 *
 * `input`: a `.zip`, `.tgz`/`.tar.gz` or `.tar` as a File/Blob/ArrayBuffer/Uint8Array, or a dropped folder as
 * an array of Files (with `webkitRelativePath`) or `{ file, relativePath }`.
 * Options: `name` (job label, default the file name), `stepName` (default: the board step), `renderer` (a
 * GerberRenderer, whose wasm decompresses `.Z` members) or `decompressUnixZ(bytes, maxBytes)`, and the
 * callbacks `onWarning(label, message)`, `onInfo(label, message)`, `onStage(label, stage)`.
 */
export async function loadOdbJob(input, options = {}) {
  const wasm = options.renderer?.wasmModule ?? options.wasmModule ?? null;
  const decompressUnixZ =
    options.decompressUnixZ ??
    (typeof wasm?.decompress_unix_z === "function" ? (bytes, max) => wasm.decompress_unix_z(bytes, max) : null);
  const treeOptions = odbTreeOptions({ decompressUnixZ });
  let label = options.name ?? input?.name ?? "job";
  let tree;
  if (Array.isArray(input)) {
    tree = createOdbTreeFromFiles(input, treeOptions);
    if (!options.name) {
      const first = input[0]?.relativePath ?? input[0]?.webkitRelativePath ?? input[0]?.file?.webkitRelativePath ?? "";
      label = first.split("/")[0] || label;
    }
  } else {
    let bytes = await toBytes(input);
    if (isZipBytes(bytes)) {
      tree = createZipBytesJobTree(bytes, { archiveName: label, ...treeOptions });
    } else {
      if (isGzipBytes(bytes)) {
        bytes = await gunzip(bytes, {
          maxOutputBytes: Math.min(MAX_TAR_EXPANDED_SIZE_BYTES, bytes.byteLength * MAX_ARCHIVE_COMPRESSION_RATIO),
          label,
        });
      }
      tree = createTarJobTree(parseTar(bytes, { archiveName: label }), treeOptions);
    }
  }
  if (!tree.isOdbJob) throw new Error(`${label} is not an ODB++ job (matrix/matrix not found)`);
  const sources = await collectOdbLayerSourcesFromTree(tree, label, {
    odbStepName: options.stepName ?? null,
    onArchiveStage: options.onStage ?? noop,
    onArchiveWarning: options.onWarning ?? noop,
    onArchiveInfo: options.onInfo ?? noop,
  });
  return Promise.all(sources.map(async (s) => ({ name: s.name, kind: s.kind, source: await s.readText() })));
}
