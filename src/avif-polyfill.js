/**
 * AVIF WASM polyfill — lazy-loaded fallback decoder for browsers
 * that do not support AVIF natively.
 *
 * Uses @jsquash/avif (libavif compiled to WASM).
 * The WASM binary is loaded on first decode call (~200ms init).
 */

let decodeImpl = null;

async function ensureDecoder() {
  if (decodeImpl) { return; }
  const mod = await import('@jsquash/avif/decode.js');
  decodeImpl = mod.default || mod.decode;
}

/**
 * Decode AVIF bytes to ImageData (RGBA pixels).
 * @param {Uint8Array} avifBytes
 * @returns {Promise<ImageData>}
 */
export async function decodeAvifToImageData(avifBytes) {
  await ensureDecoder();
  const buffer = avifBytes.buffer.byteLength === avifBytes.length
    ? avifBytes.buffer
    : avifBytes.slice().buffer;
  return decodeImpl(buffer);
}
