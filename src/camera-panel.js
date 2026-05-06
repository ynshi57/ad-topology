/**
 * Camera Panel — spatial vehicle-centric camera layout with selectable cameras.
 * 12 cameras arranged around a top-down vehicle silhouette.
 *
 * View name: Camera View (canonical per ui_rule.mdc)
 */

import { decodeCameraFrame, decodeCameraCalibration, decodeFrameTransform } from './camera-decoder.js';
import { decodeAvifToImageData } from './avif-polyfill.js';
import { isCameraVideoTopic, isVideoStreamSchema, parseVideoStream, createH264Decoder, isWebCodecsAvailable } from './videostream-decoder.js';
import { parseBevMap, parseOccResult, expandOccCells, isBevMapSchema, isOccResultSchema } from './bev-decoder.js';
import { renderBev, createBevViewState, attachPanZoom } from './bev-renderer.js';

const AVIF_SUPPORT = checkAvifSupport();

function checkAvifSupport() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0);
    img.onerror = () => resolve(false);
    img.src = 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAABoAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAADGF2MUOBAAAAAAAAFWlzcGUAAAAAAAAAAQAAAAEAAAAMYXYxQ4EgAAAAAAAiaXBtYQAAAAAAAAABAAEEAQKDBAAAABptZGF0EgAKBDgABokyCRAAAAAP';
  });
}

function extractCameraName(topic) {
  const m = topic.match(/\/sensor\/camera\/([^/]+)/);
  return m ? m[1] : topic;
}

function esc(s) {
  const d = document.createElement('span');
  d.textContent = s;
  return d.innerHTML;
}

// -----------------------------------------------------------------------
//  Camera position mapping: name -> { zone, order, label }
// -----------------------------------------------------------------------

const CAMERA_POSITIONS = {
  'front_left_1':           { zone: 'front', order: 0, label: 'FL' },
  'front_left_dark_11':     { zone: 'front', order: 1, label: 'FL-D' },
  'front_middle_0':         { zone: 'front', order: 2, label: 'FM' },
  'front_middle_fisheye_0': { zone: 'front', order: 2, label: 'FM-F' },
  'front_right_10':         { zone: 'front', order: 3, label: 'FR' },
  'left_front_2':           { zone: 'left',  order: 0, label: 'LF' },
  'left_middle_3':          { zone: 'left',  order: 1, label: 'LM' },
  'left_middle_fisheye_3':  { zone: 'left',  order: 1, label: 'LM-F' },
  'left_rear_4':            { zone: 'left',  order: 2, label: 'LR' },
  'right_front_9':          { zone: 'right', order: 0, label: 'RF' },
  'right_middle_8':         { zone: 'right', order: 1, label: 'RM' },
  'right_middle_fisheye_8': { zone: 'right', order: 1, label: 'RM-F' },
  'right_rear_7':           { zone: 'right', order: 2, label: 'RR' },
  'rear_left_5':            { zone: 'rear',  order: 0, label: 'RL' },
  'rear_left_fisheye_5':    { zone: 'rear',  order: 0, label: 'RL-F' },
  'rear_right_6':           { zone: 'rear',  order: 1, label: 'RG' },
};

function getCameraZone(name) {
  return CAMERA_POSITIONS[name] || { zone: 'other', order: 99, label: '?' };
}

function makeVehicleSvg() {
  return `<svg class="cam-vehicle-svg" viewBox="0 0 100 160" xmlns="http://www.w3.org/2000/svg">
    <rect x="15" y="20" width="70" height="120" rx="14" ry="14" fill="#1a1a1a" stroke="#333" stroke-width="1.5"/>
    <rect x="8" y="35" width="10" height="22" rx="3" fill="#222" stroke="#444" stroke-width="0.8"/>
    <rect x="82" y="35" width="10" height="22" rx="3" fill="#222" stroke="#444" stroke-width="0.8"/>
    <rect x="8" y="103" width="10" height="22" rx="3" fill="#222" stroke="#444" stroke-width="0.8"/>
    <rect x="82" y="103" width="10" height="22" rx="3" fill="#222" stroke="#444" stroke-width="0.8"/>
    <polygon points="50,28 44,40 56,40" fill="#555" opacity="0.8"/>
    <text x="50" y="55" text-anchor="middle" fill="#555" font-size="9" font-family="Inter,sans-serif" font-weight="600">FRONT</text>
    <circle cx="50" cy="90" r="6" fill="none" stroke="#333" stroke-width="1"/>
    <circle cx="50" cy="90" r="2" fill="#444"/>
  </svg>`;
}

// -----------------------------------------------------------------------
//  createCameraPanel
// -----------------------------------------------------------------------

export function createCameraPanel(container, opts) {
  const { cameraIndex } = opts;
  const { cameras, frameIndex, idrIndex, msgDataCache } = cameraIndex;

  if (cameras.length === 0) {
    container.innerHTML = '<div class="cam-empty">No camera channels found</div>';
    return { update() {}, destroy() {}, getVisibleCameras() { return []; } };
  }

  const el = document.createElement('div');
  el.className = 'cam-panel';
  el.setAttribute('data-view-name', 'Camera View');

  const enabledSet = new Set();
  cameras.forEach(c => enabledSet.add(c.videoTopic));

  const blobUrls = {};
  const frameCursors = {};
  const decoding = {};
  const wasmFallbackTopics = new Set();
  const h264Decoders = {};
  const h264LastFedIdx = {};
  const webCodecsOk = isWebCodecsAvailable();
  const cellElements = {};
  const cellParents = {};

  // BEV view state
  const bevIndex = cameraIndex.bevIndex || { bevTopics: [], occTopics: [], frameIndex: {} };
  const bevView = createBevViewState();
  const bevCursors = {};
  let bevDataCache = { bevMap: null, occResult: null, occCells: null };
  let bevPanZoomUnbind = null;

  let viewMode = 'spatial'; // 'spatial' | 'focus' | 'fullscreen'
  let fullscreenCamera = null;
  let focusCameras = [];

  buildDom();
  container.appendChild(el);

  // ----- DOM construction (one-time) -----

  function buildDom() {
    el.innerHTML = '';

    const sidebar = document.createElement('div');
    sidebar.className = 'cam-sidebar';
    sidebar.innerHTML = `
      <div class="cam-sidebar-header">
        <span class="cam-sidebar-title">Cameras</span>
        <span class="cam-sidebar-count">${cameras.length}</span>
      </div>
      <div class="cam-sidebar-list" id="cam-sidebar-list"></div>
    `;

    const listEl = sidebar.querySelector('#cam-sidebar-list');
    for (const cam of cameras) {
      const pos = getCameraZone(cam.name);
      const item = document.createElement('label');
      item.className = 'cam-sidebar-item';
      item.innerHTML = `
        <input type="checkbox" checked data-topic="${esc(cam.videoTopic)}" />
        <span class="cam-sidebar-zone">${esc(pos.label)}</span>
        <span class="cam-sidebar-name">${esc(cam.name)}</span>
      `;
      item.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) {
          enabledSet.add(cam.videoTopic);
        } else {
          enabledSet.delete(cam.videoTopic);
        }
        applyCellVisibility();
      });
      listEl.appendChild(item);
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'cam-sidebar-btns';
    btnRow.innerHTML = `
      <button class="cam-sidebar-btn" id="cam-btn-all">All</button>
      <button class="cam-sidebar-btn" id="cam-btn-none">None</button>
    `;
    sidebar.appendChild(btnRow);

    sidebar.querySelector('#cam-btn-all').addEventListener('click', () => {
      cameras.forEach(c => enabledSet.add(c.videoTopic));
      listEl.querySelectorAll('input').forEach(cb => { cb.checked = true; });
      applyCellVisibility();
    });
    sidebar.querySelector('#cam-btn-none').addEventListener('click', () => {
      enabledSet.clear();
      listEl.querySelectorAll('input').forEach(cb => { cb.checked = false; });
      applyCellVisibility();
    });

    const gridContainer = document.createElement('div');
    gridContainer.className = 'cam-grid-container';
    gridContainer.id = 'cam-grid-container';

    const spatialGrid = document.createElement('div');
    spatialGrid.className = 'cam-spatial-grid';
    spatialGrid.id = 'cam-spatial-grid';

    const zones = { front: [], left: [], right: [], rear: [], other: [] };
    for (const cam of cameras) {
      const pos = getCameraZone(cam.name);
      zones[pos.zone].push({ cam, order: pos.order });
    }
    for (const z of Object.values(zones)) {
      z.sort((a, b) => a.order - b.order);
    }

    function appendCellToZone(zone, cam) {
      const cell = createCell(cam);
      zone.appendChild(cell);
      cellParents[cam.videoTopic] = zone;
    }

    const frontRow = document.createElement('div');
    frontRow.className = 'cam-zone cam-zone-front';
    for (const { cam } of zones.front) { appendCellToZone(frontRow, cam); }

    const leftCol = document.createElement('div');
    leftCol.className = 'cam-zone cam-zone-left';
    for (const { cam } of zones.left) { appendCellToZone(leftCol, cam); }

    const rightCol = document.createElement('div');
    rightCol.className = 'cam-zone cam-zone-right';
    for (const { cam } of zones.right) { appendCellToZone(rightCol, cam); }

    const rearRow = document.createElement('div');
    rearRow.className = 'cam-zone cam-zone-rear';
    for (const { cam } of zones.rear) { appendCellToZone(rearRow, cam); }

    // Center column is now empty (BEV view on the right provides vehicle context)
    const carCenter = document.createElement('div');
    carCenter.className = 'cam-zone-car';

    spatialGrid.appendChild(frontRow);
    spatialGrid.appendChild(leftCol);
    spatialGrid.appendChild(carCenter);
    spatialGrid.appendChild(rightCol);
    spatialGrid.appendChild(rearRow);

    for (const { cam } of zones.other) {
      appendCellToZone(rearRow, cam);
    }

    // BEV side area
    const bevArea = buildBevArea();

    const focusGrid = document.createElement('div');
    focusGrid.className = 'cam-focus-grid';
    focusGrid.id = 'cam-focus-grid';
    focusGrid.style.display = 'none';

    const floatOverlay = document.createElement('div');
    floatOverlay.className = 'cam-float-overlay';
    floatOverlay.id = 'cam-float-overlay';
    floatOverlay.style.display = 'none';
    floatOverlay.innerHTML = `
      <div class="cam-float-card" id="cam-float-card">
        <div class="cam-float-header">
          <span class="cam-float-name" id="cam-float-name"></span>
          <span class="cam-float-fps" id="cam-float-fps">--</span>
          <button class="cam-float-info" id="cam-float-info">Info</button>
          <button class="cam-float-close" id="cam-float-close">X</button>
        </div>
        <div class="cam-float-body">
          <canvas class="cam-float-canvas" id="cam-float-canvas"></canvas>
          <img class="cam-float-img" id="cam-float-img" />
        </div>
        <div class="cam-fs-overlay" id="cam-fs-overlay" style="display:none"></div>
      </div>
    `;
    floatOverlay.addEventListener('click', (e) => {
      if (e.target === floatOverlay) { closeFloatingPreview(); }
    });
    floatOverlay.querySelector('#cam-float-close').addEventListener('click', () => {
      closeFloatingPreview();
    });
    floatOverlay.querySelector('#cam-float-info').addEventListener('click', (e) => {
      e.stopPropagation();
      if (fullscreenCamera) { toggleCalibrationOverlay(fullscreenCamera, floatOverlay.querySelector('#cam-float-card')); }
    });

    // Layout container that holds spatial grid (left) + bev area (right)
    const cameraBevWrap = document.createElement('div');
    cameraBevWrap.className = 'cam-bev-wrap';
    cameraBevWrap.appendChild(spatialGrid);
    cameraBevWrap.appendChild(bevArea);

    gridContainer.appendChild(cameraBevWrap);
    gridContainer.appendChild(focusGrid);
    gridContainer.appendChild(floatOverlay);

    el.appendChild(sidebar);
    el.appendChild(gridContainer);
  }

  function buildBevArea() {
    const wrap = document.createElement('div');
    wrap.className = 'bev-area';

    const canvas = document.createElement('canvas');
    canvas.className = 'bev-canvas';
    canvas.id = 'bev-canvas';
    wrap.appendChild(canvas);

    const layerBar = document.createElement('div');
    layerBar.className = 'bev-layer-bar';
    layerBar.innerHTML = `
      <button class="bev-layer-btn active" data-layer="lanes">Lanes</button>
      <button class="bev-layer-btn active" data-layer="objects">Objects</button>
      <button class="bev-layer-btn active" data-layer="occupancy">Occupancy</button>
    `;
    wrap.appendChild(layerBar);

    layerBar.querySelectorAll('.bev-layer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const layer = btn.dataset.layer;
        const active = !btn.classList.contains('active');
        btn.classList.toggle('active', active);
        if (layer === 'lanes') { bevView.showLanes = active; }
        else if (layer === 'objects') { bevView.showObjects = active; }
        else if (layer === 'occupancy') { bevView.showOccupancy = active; }
        requestBevRedraw();
      });
    });

    return wrap;
  }

  function ensureBevCanvasSize() {
    const canvas = document.getElementById('bev-canvas');
    if (!canvas) { return null; }
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(100, Math.floor(rect.width));
    const h = Math.max(100, Math.floor(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return canvas;
  }

  let bevRedrawScheduled = false;
  function requestBevRedraw() {
    if (bevRedrawScheduled) { return; }
    bevRedrawScheduled = true;
    requestAnimationFrame(() => {
      bevRedrawScheduled = false;
      const canvas = ensureBevCanvasSize();
      if (!canvas) { return; }
      const ctx = canvas.getContext('2d');
      renderBev(ctx, { width: canvas.width, height: canvas.height }, bevView, bevDataCache);
    });
  }

  function setupBevPanZoomLazy() {
    if (bevPanZoomUnbind) { return; }
    const canvas = document.getElementById('bev-canvas');
    if (!canvas) { return; }
    bevPanZoomUnbind = attachPanZoom(canvas, bevView, () => {
      requestBevRedraw();
    });
  }

  function createCell(cam) {
    const id = cssId(cam.videoTopic);
    const pos = getCameraZone(cam.name);
    const cell = document.createElement('div');
    cell.className = 'cam-cell';
    cell.id = `cam-cell-${id}`;
    cell.dataset.topic = cam.videoTopic;
    cell.innerHTML = `
      <div class="cam-cell-header">
        <span class="cam-cell-name">${esc(cam.name)}</span>
        <span class="cam-cell-fps" id="cam-fps-${id}">--</span>
      </div>
      <img class="cam-cell-img" id="cam-img-${id}" />
      <canvas class="cam-cell-canvas" id="cam-canvas-${id}"></canvas>
      <div class="cam-cell-noframe" id="cam-noframe-${id}">No frame</div>
      <div class="cam-cell-zone-badge">${esc(pos.label)}</div>
    `;
    cell.addEventListener('click', () => {
      showFloatingPreview(cam);
    });
    cellElements[cam.videoTopic] = cell;
    return cell;
  }

  // ----- View mode switching (no DOM recreation) -----

  function returnCellsToSpatial() {
    for (const cam of cameras) {
      const cell = cellElements[cam.videoTopic];
      const parent = cellParents[cam.videoTopic];
      if (cell && parent && cell.parentElement !== parent) {
        cell.classList.remove('cam-cell-focus');
        parent.appendChild(cell);
      }
    }
  }

  function showFloatingPreview(cam) {
    fullscreenCamera = cam;
    const overlay = document.getElementById('cam-float-overlay');
    if (!overlay) { return; }

    overlay.style.display = 'flex';
    const nameEl = document.getElementById('cam-float-name');
    if (nameEl) { nameEl.textContent = cam.name; }

    const infoOverlay = document.getElementById('cam-fs-overlay');
    if (infoOverlay) { infoOverlay.style.display = 'none'; }
  }

  function closeFloatingPreview() {
    fullscreenCamera = null;
    const overlay = document.getElementById('cam-float-overlay');
    if (overlay) { overlay.style.display = 'none'; }
  }

  function applyCellVisibility() {
    for (const cam of cameras) {
      const cell = cellElements[cam.videoTopic];
      if (cell) {
        cell.style.display = enabledSet.has(cam.videoTopic) ? '' : 'none';
      }
    }
  }

  // ----- Calibration overlay -----

  function toggleCalibrationOverlay(cam, wrap) {
    const overlay = wrap.querySelector('#cam-fs-overlay');
    if (!overlay) { return; }
    if (overlay.style.display !== 'none') { overlay.style.display = 'none'; return; }

    let html = '<div class="cam-calib-content">';
    html += `<div class="cam-calib-title">Camera Info: ${esc(cam.name)}</div>`;
    if (cam.calibration) {
      const c = cam.calibration;
      html += '<div class="cam-calib-section">Calibration</div>';
      html += `<div class="cam-calib-row"><span>Resolution:</span> ${c.width} x ${c.height}</div>`;
      html += `<div class="cam-calib-row"><span>Distortion:</span> ${c.distortionModel || 'N/A'}</div>`;
      if (c.K?.length >= 9) {
        html += `<div class="cam-calib-row"><span>fx, fy:</span> ${c.K[0]?.toFixed(1)}, ${c.K[4]?.toFixed(1)}</div>`;
        html += `<div class="cam-calib-row"><span>cx, cy:</span> ${c.K[2]?.toFixed(1)}, ${c.K[5]?.toFixed(1)}</div>`;
      }
      if (c.D?.length > 0) {
        html += `<div class="cam-calib-row"><span>D:</span> [${c.D.map(v => v.toFixed(4)).join(', ')}]</div>`;
      }
    } else {
      html += '<div class="cam-calib-row">No calibration data</div>';
    }
    if (cam.transform) {
      const t = cam.transform;
      html += '<div class="cam-calib-section">Transform</div>';
      html += `<div class="cam-calib-row"><span>Parent:</span> ${t.parentFrameId || 'N/A'}</div>`;
      html += `<div class="cam-calib-row"><span>Child:</span> ${t.childFrameId || 'N/A'}</div>`;
      if (t.translation) {
        const tr = t.translation;
        html += `<div class="cam-calib-row"><span>Translation:</span> [${(tr.x||0).toFixed(3)}, ${(tr.y||0).toFixed(3)}, ${(tr.z||0).toFixed(3)}]</div>`;
      }
      if (t.rotation) {
        const r = t.rotation;
        html += `<div class="cam-calib-row"><span>Rotation:</span> [${(r.x||0).toFixed(4)}, ${(r.y||0).toFixed(4)}, ${(r.z||0).toFixed(4)}, ${(r.w||0).toFixed(4)}]</div>`;
      }
    }
    html += '<button class="cam-calib-close" id="cam-calib-close">Close</button></div>';
    overlay.innerHTML = html;
    overlay.style.display = 'flex';
    overlay.querySelector('#cam-calib-close').addEventListener('click', (e) => {
      e.stopPropagation();
      overlay.style.display = 'none';
    });
  }

  // ----- Blob / rendering helpers (unchanged logic) -----

  function revokeBlob(topic) {
    if (blobUrls[topic]) {
      URL.revokeObjectURL(blobUrls[topic]);
      delete blobUrls[topic];
    }
  }

  function update(currentSec, topicFreqs) {
    setupBevPanZoomLazy();

    const visible = cameras.filter(c => enabledSet.has(c.videoTopic));

    for (const cam of visible) {
      const frames = frameIndex[cam.videoTopic];
      if (!frames || frames.length === 0) { continue; }

      let lo = 0, hi = frames.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid].sec <= currentSec) { lo = mid + 1; }
        else { hi = mid; }
      }
      const idx = lo - 1;
      if (idx < 0) { continue; }

      if (frameCursors[cam.videoTopic] === idx) {
        updateFpsBadge(cam.videoTopic, topicFreqs);
        continue;
      }

      if (cam.codec === 'h264') {
        updateH264Camera(cam, idx);
      } else {
        frameCursors[cam.videoTopic] = idx;
        const frameRef = frames[idx];
        const msgEntry = msgDataCache[cam.videoTopic]?.[frameRef.dataIdx];
        if (!msgEntry) { continue; }
        const decoded = decodeCameraFrame(msgEntry.schemaId, msgEntry.data);
        if (!decoded || decoded.data.length === 0) { continue; }

        if (wasmFallbackTopics.has(cam.videoTopic)) {
          renderViaWasm(cam.videoTopic, decoded.data);
        } else {
          renderViaImg(cam.videoTopic, decoded);
        }
      }

      updateFpsBadge(cam.videoTopic, topicFreqs);
    }

    updateBev(currentSec);
  }

  function updateBev(currentSec) {
    let changed = false;

    // Pick latest BevMap message at-or-before currentSec
    const bevTopic = bevIndex.bevTopics[0];
    if (bevTopic) {
      const frames = bevIndex.frameIndex[bevTopic];
      if (frames && frames.length > 0) {
        let lo = 0, hi = frames.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (frames[mid].sec <= currentSec) { lo = mid + 1; }
          else { hi = mid; }
        }
        const idx = lo - 1;
        if (idx >= 0 && bevCursors[bevTopic] !== idx) {
          bevCursors[bevTopic] = idx;
          const entry = msgDataCache[bevTopic]?.[frames[idx].dataIdx];
          if (entry) {
            try {
              bevDataCache.bevMap = parseBevMap(entry.data);
              changed = true;
            } catch (e) {
              console.warn('parseBevMap failed:', e);
            }
          }
        }
      }
    }

    // Same for OccResult
    const occTopic = bevIndex.occTopics[0];
    if (occTopic) {
      const frames = bevIndex.frameIndex[occTopic];
      if (frames && frames.length > 0) {
        let lo = 0, hi = frames.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (frames[mid].sec <= currentSec) { lo = mid + 1; }
          else { hi = mid; }
        }
        const idx = lo - 1;
        if (idx >= 0 && bevCursors[occTopic] !== idx) {
          bevCursors[occTopic] = idx;
          const entry = msgDataCache[occTopic]?.[frames[idx].dataIdx];
          if (entry) {
            try {
              const occ = parseOccResult(entry.data);
              bevDataCache.occResult = occ;
              bevDataCache.occCells = expandOccCells(occ);
              changed = true;
            } catch (e) {
              console.warn('parseOccResult failed:', e);
            }
          }
        }
      }
    }

    if (changed) { requestBevRedraw(); }
  }

  function updateH264Camera(cam, targetIdx) {
    const topic = cam.videoTopic;
    const frames = frameIndex[topic];

    if (!webCodecsOk) {
      const id = cssId(topic);
      const noFrame = document.getElementById(`cam-noframe-${id}`);
      if (noFrame) { noFrame.textContent = 'WebCodecs not available'; noFrame.style.display = 'flex'; }
      frameCursors[topic] = targetIdx;
      return;
    }

    if (!h264Decoders[topic]) {
      h264Decoders[topic] = createH264Decoder((videoFrame) => {
        drawVideoFrame(topic, videoFrame);
        videoFrame.close();
      });
      h264LastFedIdx[topic] = -1;
    }

    const decoder = h264Decoders[topic];
    const prevIdx = frameCursors[topic] ?? -1;
    const jumped = prevIdx === -1 || targetIdx < prevIdx || (targetIdx - prevIdx) > 30;

    let startIdx;
    if (jumped) {
      const idrPos = idrIndex[topic] || [];
      let idrBefore = -1;
      for (let i = idrPos.length - 1; i >= 0; i--) {
        if (idrPos[i] <= targetIdx) { idrBefore = idrPos[i]; break; }
      }
      if (idrBefore < 0) { frameCursors[topic] = targetIdx; return; }
      decoder.requestReset();
      startIdx = idrBefore;
      h264LastFedIdx[topic] = idrBefore - 1;
    } else {
      startIdx = (h264LastFedIdx[topic] ?? prevIdx) + 1;
    }

    const feedEnd = Math.min(targetIdx + 1, frames.length);
    for (let i = startIdx; i < feedEnd; i++) {
      const frame = frames[i];
      const msgEntry = msgDataCache[topic]?.[frame.dataIdx];
      if (!msgEntry) { continue; }
      const raw = msgEntry.data instanceof Uint8Array ? msgEntry.data : new Uint8Array(msgEntry.data);
      const vs = parseVideoStream(raw);
      if (!vs || !vs.data) { continue; }
      decoder.decode(vs.data, vs.frameType, Math.round(frame.sec * 1_000_000));
      h264LastFedIdx[topic] = i;
    }
    frameCursors[topic] = targetIdx;
  }

  function drawVideoFrame(topic, videoFrame) {
    const id = cssId(topic);
    const canvas = document.getElementById(`cam-canvas-${id}`);
    if (canvas) {
      canvas.width = videoFrame.displayWidth;
      canvas.height = videoFrame.displayHeight;
      canvas.getContext('2d').drawImage(videoFrame, 0, 0);
      canvas.style.display = 'block';
      const img = document.getElementById(`cam-img-${id}`);
      if (img) { img.style.display = 'none'; }
    }
    const noFrame = document.getElementById(`cam-noframe-${id}`);
    if (noFrame) { noFrame.style.display = 'none'; }

    if (fullscreenCamera && fullscreenCamera.videoTopic === topic) {
      const fc = document.getElementById('cam-float-canvas');
      if (fc) {
        fc.width = videoFrame.displayWidth;
        fc.height = videoFrame.displayHeight;
        fc.getContext('2d').drawImage(videoFrame, 0, 0);
        fc.style.display = 'block';
      }
      const fi = document.getElementById('cam-float-img');
      if (fi) { fi.style.display = 'none'; }
    }
  }

  function renderViaImg(topic, decoded) {
    revokeBlob(topic);
    const mimeType = decoded.format === 'avif' ? 'image/avif'
      : decoded.format === 'jpeg' || decoded.format === 'jpg' ? 'image/jpeg'
      : decoded.format === 'png' ? 'image/png' : 'application/octet-stream';
    const blob = new Blob([decoded.data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobUrls[topic] = url;

    const testImg = new Image();
    testImg.onload = () => { setImageSrc(topic, url); };
    testImg.onerror = () => {
      wasmFallbackTopics.add(topic);
      revokeBlob(topic);
      renderViaWasm(topic, decoded.data);
    };
    testImg.src = url;
  }

  function renderViaWasm(topic, avifBytes) {
    if (decoding[topic]) { return; }
    decoding[topic] = true;
    decodeAvifToImageData(avifBytes).then(imageData => {
      decoding[topic] = false;
      drawToCanvas(topic, imageData);
    }).catch(err => {
      decoding[topic] = false;
      console.error(`WASM AVIF decode failed [${topic}]:`, err);
    });
  }

  function drawToCanvas(topic, imageData) {
    const id = cssId(topic);
    const canvas = document.getElementById(`cam-canvas-${id}`);
    if (canvas) {
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      canvas.getContext('2d').putImageData(imageData, 0, 0);
      canvas.style.display = 'block';
      const img = document.getElementById(`cam-img-${id}`);
      if (img) { img.style.display = 'none'; }
    }
    const noFrame = document.getElementById(`cam-noframe-${id}`);
    if (noFrame) { noFrame.style.display = 'none'; }

    if (fullscreenCamera && fullscreenCamera.videoTopic === topic) {
      const fc = document.getElementById('cam-float-canvas');
      if (fc) {
        fc.width = imageData.width;
        fc.height = imageData.height;
        fc.getContext('2d').putImageData(imageData, 0, 0);
        fc.style.display = 'block';
      }
    }
  }

  function setImageSrc(topic, url) {
    const id = cssId(topic);
    const gridImg = document.getElementById(`cam-img-${id}`);
    const gridNoFrame = document.getElementById(`cam-noframe-${id}`);
    if (gridImg) { gridImg.src = url; gridImg.style.display = 'block'; }
    if (gridNoFrame) { gridNoFrame.style.display = 'none'; }

    if (fullscreenCamera && fullscreenCamera.videoTopic === topic) {
      const fi = document.getElementById('cam-float-img');
      if (fi) { fi.src = url; fi.style.display = 'block'; }
      const fc = document.getElementById('cam-float-canvas');
      if (fc) { fc.style.display = 'none'; }
    }
  }

  function updateFpsBadge(topic, topicFreqs) {
    const hz = topicFreqs?.[topic];
    const text = hz !== undefined && hz >= 0 ? `${hz.toFixed(1)} Hz` : '--';
    const gridBadge = document.getElementById(`cam-fps-${cssId(topic)}`);
    if (gridBadge) { gridBadge.textContent = text; }
    if (fullscreenCamera && fullscreenCamera.videoTopic === topic) {
      const fb = document.getElementById('cam-float-fps');
      if (fb) { fb.textContent = text; }
    }
  }

  function getVisibleCameras() {
    return cameras.filter(c => enabledSet.has(c.videoTopic));
  }

  function destroy() {
    Object.keys(blobUrls).forEach(revokeBlob);
    for (const dec of Object.values(h264Decoders)) { dec.destroy(); }
    if (bevPanZoomUnbind) { bevPanZoomUnbind(); bevPanZoomUnbind = null; }
    el.remove();
  }

  return { update, destroy, getVisibleCameras };
}

function cssId(topic) {
  return topic.replace(/[^a-zA-Z0-9]/g, '_');
}

// -----------------------------------------------------------------------
//  buildCameraIndex (unchanged)
// -----------------------------------------------------------------------

export function buildCameraIndex(summary, msgDataCache) {
  const videoChannels = [];
  const calibChannels = [];
  const transformChannels = [];
  const bevTopics = [];     // BevMap topics, ordered by preference
  const occTopics = [];     // OccResult topics

  // Preferred BevMap topics in order: obj_infer (dynamic objects), then static (lanes), then map_tr, then debug
  const bevTopicPriority = ['/perception/obj_infer', '/perception/static', '/perception/map_tr_infer', '/maprouter/debug_localmap'];

  for (const ch of summary.channels) {
    if (ch.schemaName === 'foxglove.CompressedImage') {
      videoChannels.push({ ...ch, codec: 'image' });
    } else if (isVideoStreamSchema(ch.schemaName) && isCameraVideoTopic(ch.topic)) {
      videoChannels.push({ ...ch, codec: 'h264' });
    } else if (ch.schemaName === 'foxglove.CameraCalibration') {
      calibChannels.push(ch);
    } else if (ch.schemaName === 'foxglove.FrameTransform') {
      transformChannels.push(ch);
    } else if (isBevMapSchema(ch.schemaName)) {
      bevTopics.push(ch.topic);
    } else if (isOccResultSchema(ch.schemaName)) {
      occTopics.push(ch.topic);
    }
  }

  // Sort bev topics by priority (most informative first)
  bevTopics.sort((a, b) => {
    const ai = bevTopicPriority.indexOf(a);
    const bi = bevTopicPriority.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const frameIndex = {};
  const idrIndex = {};

  for (const ch of videoChannels) {
    const msgs = msgDataCache[ch.topic];
    if (!msgs) { continue; }
    if (ch.codec === 'h264') {
      const frames = [];
      const idrPositions = [];
      for (let i = 0; i < msgs.length; i++) {
        const raw = msgs[i].data;
        const parsed = (raw && raw.byteLength > 0) ? parseVideoStream(raw instanceof Uint8Array ? raw : new Uint8Array(raw)) : null;
        const isIdr = parsed ? parsed.frameType === 3 : false;
        frames.push({ sec: msgs[i].sec, dataIdx: i, isIdr });
        if (isIdr) { idrPositions.push(frames.length - 1); }
      }
      frameIndex[ch.topic] = frames;
      idrIndex[ch.topic] = idrPositions;
    } else {
      frameIndex[ch.topic] = msgs.map((m, i) => ({ sec: m.sec, dataIdx: i, isIdr: true }));
    }
  }

  const cameras = [];
  for (const vch of videoChannels) {
    const cameraName = extractCameraName(vch.topic);
    const basePath = vch.topic.replace(/\/video$/, '');
    const calibTopic = calibChannels.find(c => c.topic.startsWith(basePath))?.topic || null;
    const transformTopic = transformChannels.find(c => c.topic.startsWith(basePath))?.topic || null;

    let calibration = null;
    if (calibTopic && msgDataCache[calibTopic]?.length > 0) {
      const entry = msgDataCache[calibTopic][0];
      calibration = decodeCameraCalibration(entry.schemaId, entry.data);
    }
    let transform = null;
    if (transformTopic && msgDataCache[transformTopic]?.length > 0) {
      const entry = msgDataCache[transformTopic][0];
      transform = decodeFrameTransform(entry.schemaId, entry.data);
    }

    cameras.push({
      name: cameraName,
      videoTopic: vch.topic,
      codec: vch.codec,
      calibTopic, transformTopic, calibration, transform,
    });
  }

  cameras.sort((a, b) => a.name.localeCompare(b.name));

  // Build bev/occ frame index (sec -> dataIdx)
  const bevFrameIndex = {};
  for (const topic of [...bevTopics, ...occTopics]) {
    const msgs = msgDataCache[topic];
    if (!msgs) { continue; }
    bevFrameIndex[topic] = msgs.map((m, i) => ({ sec: m.sec, dataIdx: i }));
  }

  return {
    cameras,
    frameIndex,
    idrIndex,
    msgDataCache,
    bevIndex: { bevTopics, occTopics, frameIndex: bevFrameIndex },
  };
}

export { AVIF_SUPPORT };
