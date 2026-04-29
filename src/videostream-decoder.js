/**
 * VideoStream decoder — wire-level protobuf parser for
 * neodrive.global.drivers.camera.VideoStream + WebCodecs H264 decode.
 *
 * The FDS stored in record-converted mcaps is incomplete (missing imported
 * header.proto / ts_header.proto), so we cannot use protobufjs. Instead we
 * parse the few fields we need directly from the wire format.
 */

// -----------------------------------------------------------------------
//  Protobuf wire-level reader (minimal, for VideoStream only)
// -----------------------------------------------------------------------

function readVarint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos];
    result |= (b & 0x7F) << shift;
    pos++;
    if ((b & 0x80) === 0) { return [result, pos]; }
    shift += 7;
    if (shift > 35) { break; }
  }
  return [result, pos];
}

/**
 * @typedef {Object} VideoStreamFields
 * @property {string} frameId  - field 2
 * @property {string} format   - field 3 ("h264")
 * @property {number} measurementTime - field 4 (double)
 * @property {number} frameType - field 6 (0=P, 3=IDR)
 * @property {Uint8Array} data  - field 21 (H264 NAL bytes)
 */

/**
 * Parse a VideoStream protobuf message from raw wire bytes.
 * Only extracts fields 2, 3, 4, 6, 21.
 * @param {Uint8Array} buf
 * @returns {VideoStreamFields|null}
 */
export function parseVideoStream(buf) {
  const result = { frameId: '', format: '', measurementTime: 0, frameType: -1, data: null };
  let pos = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  while (pos < buf.length) {
    const [tag, nextPos] = readVarint(buf, pos);
    pos = nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      const [val, p] = readVarint(buf, pos);
      pos = p;
      if (fieldNum === 6) { result.frameType = val; }
    } else if (wireType === 1) {
      if (fieldNum === 4 && pos + 8 <= buf.length) {
        result.measurementTime = view.getFloat64(pos, true);
      }
      pos += 8;
    } else if (wireType === 2) {
      const [len, p] = readVarint(buf, pos);
      pos = p;
      if (fieldNum === 2) {
        result.frameId = new TextDecoder().decode(buf.subarray(pos, pos + len));
      } else if (fieldNum === 3) {
        result.format = new TextDecoder().decode(buf.subarray(pos, pos + len));
      } else if (fieldNum === 21) {
        result.data = buf.subarray(pos, pos + len);
      }
      pos += len;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }

  return result.data ? result : null;
}

// -----------------------------------------------------------------------
//  H264 SPS parsing (extract codec string for WebCodecs configure)
// -----------------------------------------------------------------------

function extractCodecString(nalData) {
  let i = 0;
  while (i < nalData.length - 4) {
    const isStart4 = nalData[i] === 0 && nalData[i + 1] === 0 && nalData[i + 2] === 0 && nalData[i + 3] === 1;
    const isStart3 = nalData[i] === 0 && nalData[i + 1] === 0 && nalData[i + 2] === 1;
    if (isStart4 || isStart3) {
      const offset = isStart4 ? i + 4 : i + 3;
      const nalType = nalData[offset] & 0x1F;
      if (nalType === 7 && offset + 3 < nalData.length) {
        const profileIdc = nalData[offset + 1];
        const constraintFlags = nalData[offset + 2];
        const levelIdc = nalData[offset + 3];
        const hex = (v) => v.toString(16).padStart(2, '0');
        return `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}`;
      }
      i = offset + 1;
    } else {
      i++;
    }
  }
  return 'avc1.640028';
}

// -----------------------------------------------------------------------
//  Per-camera H264 WebCodecs decoder
// -----------------------------------------------------------------------

/**
 * Manages a WebCodecs VideoDecoder for one camera stream.
 * Handles IDR/P-frame sequencing and outputs decoded VideoFrames.
 */
class H264CameraDecoder {
  constructor(onFrame) {
    this._onFrame = onFrame;
    this._decoder = null;
    this._configured = false;
    this._codecString = null;
    this._frameCounter = 0;
    this._pendingReset = false;
  }

  _ensureDecoder() {
    if (this._decoder && this._decoder.state !== 'closed') { return; }
    this._decoder = new VideoDecoder({
      output: (frame) => {
        this._onFrame(frame);
      },
      error: (e) => {
        console.error('H264 VideoDecoder error:', e);
      },
    });
    this._configured = false;
  }

  /**
   * Feed an H264 NAL unit (may contain SPS+PPS+IDR or just a slice).
   * @param {Uint8Array} nalData - raw H264 bytes with start codes
   * @param {number} frameType - 3=IDR, 0=P-frame
   * @param {number} timestampUs - presentation timestamp in microseconds
   */
  decode(nalData, frameType, timestampUs) {
    this._ensureDecoder();

    const isKey = frameType === 3;

    if (isKey && !this._configured) {
      this._codecString = extractCodecString(nalData);
      this._decoder.configure({
        codec: this._codecString,
        optimizeForLatency: true,
      });
      this._configured = true;
    }

    if (!this._configured) { return; }

    if (this._pendingReset && isKey) {
      this._decoder.reset();
      this._decoder.configure({
        codec: this._codecString,
        optimizeForLatency: true,
      });
      this._pendingReset = false;
    }

    if (this._pendingReset && !isKey) { return; }

    const chunk = new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: timestampUs,
      data: nalData,
    });

    try {
      this._decoder.decode(chunk);
    } catch (e) {
      console.warn('H264 decode error:', e.message);
    }
  }

  requestReset() {
    this._pendingReset = true;
  }

  flush() {
    if (this._decoder && this._decoder.state === 'configured') {
      return this._decoder.flush();
    }
    return Promise.resolve();
  }

  destroy() {
    if (this._decoder && this._decoder.state !== 'closed') {
      this._decoder.close();
    }
    this._decoder = null;
    this._configured = false;
  }
}

// -----------------------------------------------------------------------
//  Public API
// -----------------------------------------------------------------------

const CAMERA_TOPIC_RE = /\/sensor\/camera\/[^/]+\/image\/video$/;

/**
 * Check if a topic looks like a camera video topic by its path pattern.
 */
export function isCameraVideoTopic(topic) {
  return CAMERA_TOPIC_RE.test(topic);
}

/**
 * Check if a schema name is a VideoStream type that we handle.
 */
export function isVideoStreamSchema(schemaName) {
  return schemaName === 'neodrive.global.drivers.camera.VideoStream';
}

/**
 * Check if WebCodecs VideoDecoder is available in this browser.
 */
export function isWebCodecsAvailable() {
  return typeof VideoDecoder !== 'undefined';
}

/**
 * Create an H264 decoder for a single camera topic.
 * @param {function(VideoFrame): void} onFrame
 * @returns {H264CameraDecoder}
 */
export function createH264Decoder(onFrame) {
  return new H264CameraDecoder(onFrame);
}
