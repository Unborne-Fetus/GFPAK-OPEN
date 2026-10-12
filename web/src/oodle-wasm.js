/**
 * Local GFPAK Oodle resource decompression (Kraken/Mermaid/Selkie/Leviathan,
 * plus LZNA/Bitknit supported by the upstream ooz engine).
 *
 * Decoder: ooz-wasm 2.0.0 (SnosMe; upstream powzix/ooz),
 * GPL-3.0-or-later. See THIRD_PARTY_LICENSES.md.
 *
 * This module is lazily imported only when a compressed GFPAK member is
 * requested. It does not require a game DLL, prod.keys, network service,
 * server upload or Blender.
 */
export const MAX_OODLE_OUTPUT = 512 * 1024 * 1024;
export const MAX_OODLE_PACKED = 512 * 1024 * 1024;
let loading = null;

function assertSize(value, maximum, kind) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error('Invalid Oodle ' + kind + ' length (' + value +
      '); browser decoding is limited to 512 MiB per resource');
  }
}

/** True when loading decoder modules can work in this browser. */
export function supportsOodle() {
  return typeof WebAssembly !== 'undefined' && typeof Uint8Array !== 'undefined';
}

async function decoder() {
  if (!supportsOodle())
    throw new Error('This browser does not support WebAssembly Oodle decompression');
  if (!loading) {
    // Embedded WASM is local to the bundled application and compiled once.
    // A static import would stall the first page load for every user.
    loading = import('ooz-wasm').catch(error => {
      loading = null;
      throw new Error('Could not initialize the browser Oodle WASM decoder: ' +
        (error?.message || error));
    });
  }
  return loading;
}

/** Decode an entire independent GFPAK Oodle block and return owned bytes.
 * The WASM library reuses its internal heap between calls: never return a
 * view into that heap to a caller that may await or access another resource.
 */
export async function decompressOodle(packed, expected) {
  if (!(packed instanceof Uint8Array)) {
    if (packed instanceof ArrayBuffer) packed = new Uint8Array(packed);
    else throw new TypeError('Oodle input must be Uint8Array or ArrayBuffer');
  }
  assertSize(expected, MAX_OODLE_OUTPUT, 'uncompressed');
  assertSize(packed.byteLength, MAX_OODLE_PACKED, 'compressed');
  let api;
  try {
    api = await decoder();
    const output = api.decompress(packed, expected);
    if (!(output instanceof Uint8Array) || output.byteLength !== expected) {
      throw new Error('decoder returned wrong output length');
    }
    // Guard against shared WebAssembly memory even if the package changes.
    return Uint8Array.from(output);
  } catch (error) {
    throw new Error('Oodle resource could not be decoded (' +
      (error?.message || String(error)) +
      '). The game may use an unsupported Oodle version or the resource may be corrupt.');
  }
}
