/**
 * YOLO sidecar loader and rendering helpers.
 *
 * Reads <input>.yolo.json produced by tools/yolo_detect/detect.py and
 * provides:
 *   - per-topic time-indexed lookup
 *   - bbox drawing on Camera View cells (image space)
 *   - ground-plane back-projection to BEV View (vehicle frame)
 */

// COCO class id -> color (Uber-style palette)
const CLASS_COLORS = {
  0: '#fbbf24',   // person       -> amber
  1: '#a78bfa',   // bicycle      -> violet
  2: '#10b981',   // car          -> green
  3: '#a78bfa',   // motorcycle   -> violet
  5: '#34d399',   // bus          -> teal
  7: '#34d399',   // truck        -> teal
  9: '#3b82f6',   // traffic light-> blue
  11: '#f472b6',  // stop sign    -> pink
};

const FALLBACK_COLOR = '#9ca3af';

export function getClassColor(classId) {
  return CLASS_COLORS[classId] || FALLBACK_COLOR;
}

/**
 * Try to load <mcapPath>.yolo.json. Returns parsed sidecar object on success,
 * or null if the file is not present (404) or invalid.
 *
 * @param {string} mcapPath absolute path to the source mcap file
 * @returns {Promise<Object|null>}
 */
export async function loadYoloSidecar(mcapPath) {
  if (!mcapPath) {
    return null;
  }
  // Strip trailing .mcap if present, then add .yolo.json
  let base = mcapPath;
  if (base.toLowerCase().endsWith('.mcap')) {
    base = base.slice(0, -5);
  }
  const sidecarPath = base + '.yolo.json';

  try {
    const url = `http://localhost:8765/file?path=${encodeURIComponent(sidecarPath)}`;
    const resp = await fetch(url);
    if (resp.status === 404) {
      return null;
    }
    if (!resp.ok) {
      console.warn(`YOLO sidecar fetch failed: ${resp.status}`);
      return null;
    }
    const sidecar = await resp.json();
    return buildIndex(sidecar);
  } catch (err) {
    console.warn('YOLO sidecar load error:', err.message);
    return null;
  }
}

/**
 * Build per-topic sorted frames index for fast time-lookup.
 *
 * Returns:
 *   {
 *     model, version, conf_threshold, ...,
 *     frames_by_topic: { topic -> [{ log_time_ns, image_w, image_h, detections }, ...] (sorted by time) },
 *     total_detections: number,
 *   }
 */
function buildIndex(sidecar) {
  const framesByTopic = {};
  let total = 0;
  for (const f of sidecar.frames || []) {
    if (!framesByTopic[f.topic]) {
      framesByTopic[f.topic] = [];
    }
    framesByTopic[f.topic].push(f);
    total += (f.detections || []).length;
  }
  // Sort each topic's frames by log_time_ns ascending
  for (const arr of Object.values(framesByTopic)) {
    arr.sort((a, b) => {
      // BigInt-safe compare (log_time_ns may be a JS number; if it's a string
      // already, fall back to string compare lex order).
      const ax = Number(a.log_time_ns);
      const bx = Number(b.log_time_ns);
      return ax - bx;
    });
  }
  console.log(
    `Loaded YOLO sidecar: model=${sidecar.model} ` +
    `frames=${(sidecar.frames || []).length} detections=${total}`
  );
  return {
    model: sidecar.model,
    version: sidecar.version,
    confThreshold: sidecar.conf_threshold,
    framesByTopic,
    totalDetections: total,
  };
}

/**
 * Find the most recent frame at-or-before the given time for a topic.
 * Returns null if no match.
 *
 * @param {Object} index built by buildIndex()
 * @param {string} topic
 * @param {number} secOffset relative seconds since record start
 * @param {number} startTimeNs record start time in ns (Number-safe ok)
 */
export function findFrameAt(index, topic, secOffset, startTimeNs) {
  if (!index || !index.framesByTopic[topic]) { return null; }
  const arr = index.framesByTopic[topic];
  if (arr.length === 0) { return null; }

  const targetNs = startTimeNs + secOffset * 1e9;
  // Binary search for largest log_time_ns <= targetNs
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(arr[mid].log_time_ns) <= targetNs) { lo = mid + 1; }
    else { hi = mid; }
  }
  const idx = lo - 1;
  if (idx < 0) { return null; }
  return arr[idx];
}

/**
 * Draw bboxes on a 2D canvas context (already sized to display dimensions).
 * Bboxes in `frame.detections` are in original image pixels; this function
 * scales them to the canvas size based on frame.image_w/h.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{width, height}} canvasSize - actual canvas pixel size
 * @param {Object} frame - { image_w, image_h, detections: [...] }
 * @param {Object} [opts] - { showLabel: bool, minConfidence: number }
 */
export function drawBboxesOnCanvas(ctx, canvasSize, frame, opts = {}) {
  if (!frame || !frame.detections || frame.detections.length === 0) {
    return;
  }
  const { width: cw, height: ch } = canvasSize;
  if (!(cw > 0 && ch > 0 && frame.image_w > 0 && frame.image_h > 0)) {
    return;
  }
  // The cell's <img>/<canvas> uses object-fit: contain. The image is
  // letter-boxed inside the cell when its aspect ratio differs from the
  // cell's. Mirror that geometry here so bboxes land on the actual pixels.
  const imgAR = frame.image_w / frame.image_h;
  const canvasAR = cw / ch;
  let drawW;
  let drawH;
  let offX;
  let offY;
  if (imgAR > canvasAR) {
    // Image is wider than cell - top/bottom letterbox.
    drawW = cw;
    drawH = cw / imgAR;
    offX = 0;
    offY = (ch - drawH) / 2;
  } else {
    // Image is taller than cell - left/right letterbox.
    drawH = ch;
    drawW = ch * imgAR;
    offX = (cw - drawW) / 2;
    offY = 0;
  }
  const sx = drawW / frame.image_w;
  const sy = drawH / frame.image_h;
  const showLabel = opts.showLabel !== false;
  const minConf = opts.minConfidence || 0;

  ctx.lineWidth = Math.max(1.5, Math.min(drawW, drawH) * 0.004);
  ctx.font = `${Math.max(10, Math.round(drawW * 0.018))}px Inter, sans-serif`;
  ctx.textBaseline = 'top';

  for (const det of frame.detections) {
    if (det.confidence < minConf) { continue; }
    const color = getClassColor(det.class_id);
    const [x1, y1, x2, y2] = det.bbox;
    const dx1 = offX + x1 * sx;
    const dy1 = offY + y1 * sy;
    const dw = (x2 - x1) * sx;
    const dh = (y2 - y1) * sy;

    ctx.strokeStyle = color;
    ctx.strokeRect(dx1, dy1, dw, dh);

    if (showLabel) {
      const label = `${det.class_name} ${det.confidence.toFixed(2)}`;
      const padding = 3;
      const metrics = ctx.measureText(label);
      const textW = metrics.width + padding * 2;
      const textH = parseInt(ctx.font, 10) + padding * 2;

      ctx.fillStyle = color;
      ctx.fillRect(dx1, Math.max(0, dy1 - textH), textW, textH);
      ctx.fillStyle = '#000';
      ctx.fillText(label, dx1 + padding, Math.max(0, dy1 - textH) + padding);
    }
  }
}

/**
 * Project a single bbox to the vehicle ground plane (BEV).
 *
 * Uses the bottom-center pixel of the bbox + camera intrinsics + extrinsics
 * to back-project to a ray in the vehicle (BEV) frame, then intersect with
 * the ground plane (z = 0 in vehicle frame).
 *
 * @param {Object} det - one detection { bbox: [x1,y1,x2,y2], ... }
 * @param {Object} cam - camera with .calibration (foxglove.CameraCalibration parsed)
 *                       and .transform (foxglove.FrameTransform parsed, parent=bev, child=camera)
 * @returns {{x: number, y: number} | null} BEV coordinates (meters) or null on failure.
 */
export function projectDetectionToBev(det, cam) {
  if (!cam || !cam.calibration || !cam.transform) { return null; }
  const c = cam.calibration;
  if (!c.K || c.K.length < 9 || !c.width || !c.height) { return null; }
  const t = cam.transform;
  if (!t.translation || !t.rotation) { return null; }

  // 1) bottom-center pixel
  const u = (det.bbox[0] + det.bbox[2]) / 2;
  const v = det.bbox[3];

  // Calibration K is in original image coords (e.g. 1920x1536).
  // YOLO bbox is also in original image pixels (we wrote it that way), so no scaling.
  const fx = c.K[0];
  const fy = c.K[4];
  const cx = c.K[2];
  const cy = c.K[5];
  if (!(fx > 0 && fy > 0)) { return null; }

  // 2) pixel -> camera-frame ray (z=1 forward)
  // Note: image pixel convention - x to right, y down, z forward in camera.
  // Standard pinhole: X_cam = (u - cx) / fx, Y_cam = (v - cy) / fy, Z_cam = 1
  const rxCam = (u - cx) / fx;
  const ryCam = (v - cy) / fy;
  const rzCam = 1.0;

  // 3) Rotate ray from camera frame to BEV frame using transform.rotation.
  // FrameTransform's rotation is parent_to_child (q applied to bev to get camera).
  // We want camera->bev so we use the rotation directly with camera-to-bev convention?
  //
  // Foxglove convention: parent_frame_id="bev", child_frame_id="camera"
  // means the transform represents the camera's pose in the bev frame, i.e.
  // p_bev = R * p_camera + t
  //
  // So to take a vector in camera frame and express it in bev frame, we apply R.
  const r = t.rotation;
  const qw = r.w, qx = r.x, qy = r.y, qz = r.z;
  const v_in = [rxCam, ryCam, rzCam];
  const rotated = quatRotate(qw, qx, qy, qz, v_in);
  const rxBev = rotated[0];
  const ryBev = rotated[1];
  const rzBev = rotated[2];

  // 4) Camera origin in BEV frame
  const ox = t.translation.x;
  const oy = t.translation.y;
  const oz = t.translation.z;

  // 5) Intersect ray (origin + s * direction) with z = 0
  if (Math.abs(rzBev) < 1e-6) {
    // Ray is parallel to ground; can't project
    return null;
  }
  const s = -oz / rzBev;
  if (s < 0 || s > 200) {
    // Behind camera or unreasonably far
    return null;
  }
  const xBev = ox + s * rxBev;
  const yBev = oy + s * ryBev;

  // sanity range
  if (Math.abs(xBev) > 200 || Math.abs(yBev) > 200) { return null; }
  return { x: xBev, y: yBev, distance: s };
}

/**
 * Apply quaternion rotation q*v*q^-1 to a 3-vector.
 * q = (w, x, y, z).
 */
function quatRotate(qw, qx, qy, qz, v) {
  // Hamilton product, optimized for vector input
  const ix = qw * v[0] + qy * v[2] - qz * v[1];
  const iy = qw * v[1] + qz * v[0] - qx * v[2];
  const iz = qw * v[2] + qx * v[1] - qy * v[0];
  const iw = -qx * v[0] - qy * v[1] - qz * v[2];

  return [
    ix * qw + iw * (-qx) + iy * (-qz) - iz * (-qy),
    iy * qw + iw * (-qy) + iz * (-qx) - ix * (-qz),
    iz * qw + iw * (-qz) + ix * (-qy) - iy * (-qx),
  ];
}
