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
import { findFrameAt, drawBboxesOnCanvas, loadYoloSidecar, getClassColor } from './yolo-overlay.js';
import { runYoloDetect, summarizeLogLine } from './yolo-runner.js';

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

// Camera IDs that are fisheye on the X3PRO platform (front_middle, left_middle,
// rear_left, right_middle). When neither the topic name nor calibration metadata
// flags the lens type, fall back to this convention.
const FISHEYE_CAM_IDS = new Set([0, 3, 5, 8]);

/**
 * Identify a fisheye camera by topic / cam name.
 * Matches both
 *  - record-converted mcaps: ``front_middle_fisheye_0``
 *  - URL-loaded camera.mcap: ``front_middle_0`` (no ``fisheye`` word)
 */
function isFisheyeCamera(cam) {
  const name = cam.name || '';
  const topic = cam.videoTopic || '';
  if (name.includes('fisheye') || topic.includes('fisheye')) { return true; }
  // Trailing camera id - e.g. front_middle_0, left_middle_3
  const m = (topic || name).match(/_(\d+)(?:\/image\/video)?$/);
  if (m && FISHEYE_CAM_IDS.has(parseInt(m[1], 10))) { return true; }
  return false;
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
  let yoloIndex = opts.yoloIndex || null;
  const startTimeNs = Number(opts.startTimeNs || 0);
  const mcapPath = opts.mcapPath || null;
  const onYoloIndexChange = opts.onYoloIndexChange || (() => {});
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
  let bevDataCache = {
    bevMap: null,
    occResult: null,
    occCells: null,
    yoloIndex,
    cameras,
    currentSec: 0,
    startTimeNs,
  };
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

    // ----- Tab bar [Cameras] [Fisheye] [BEV] -----
    const tabBar = document.createElement('div');
    tabBar.className = 'cam-tab-bar';
    tabBar.innerHTML = `
      <button class="cam-tab active" data-tab="cameras">Cameras</button>
      <button class="cam-tab" data-tab="fisheye">Fisheye</button>
      <button class="cam-tab" data-tab="bev">BEV</button>
    `;

    // ----- Tab content container (resizable; sibling of YOLO panel) -----
    const tabContent = document.createElement('div');
    tabContent.className = 'cam-tab-content';

    // ----- Cameras tab: spatial layout of regular (non-fisheye) cameras -----
    const camerasPane = document.createElement('div');
    camerasPane.className = 'cam-tab-pane cam-tab-cameras active';
    const spatialGrid = document.createElement('div');
    spatialGrid.className = 'cam-spatial-grid';
    spatialGrid.id = 'cam-spatial-grid';

    // ----- Fisheye tab: 2x2 grid of fisheye cameras -----
    const fisheyePane = document.createElement('div');
    fisheyePane.className = 'cam-tab-pane cam-tab-fisheye';
    const fisheyeGrid = document.createElement('div');
    fisheyeGrid.className = 'cam-fisheye-grid';
    fisheyeGrid.id = 'cam-fisheye-grid';
    fisheyePane.appendChild(fisheyeGrid);

    // ----- BEV tab: full BEV canvas -----
    const bevPane = document.createElement('div');
    bevPane.className = 'cam-tab-pane cam-tab-bev';
    const bevArea = buildBevArea();
    bevPane.appendChild(bevArea);

    // Distribute cells: regular cameras into spatial grid (zoned),
    // fisheye cameras into the dedicated 2x2 grid.
    const regularCams = cameras.filter(c => !isFisheyeCamera(c));
    const fisheyeCams = cameras.filter(c => isFisheyeCamera(c));

    const zones = { front: [], left: [], right: [], rear: [], other: [] };
    for (const cam of regularCams) {
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
    camerasPane.appendChild(spatialGrid);

    // Sort fisheye cams by canonical id order (0, 3, 5, 8) so the 2x2 grid
    // is consistent across mcap variants.
    fisheyeCams.sort((a, b) => {
      const idA = parseInt((a.videoTopic || '').match(/_(\d+)\/image/)?.[1] || '99', 10);
      const idB = parseInt((b.videoTopic || '').match(/_(\d+)\/image/)?.[1] || '99', 10);
      return idA - idB;
    });
    for (const cam of fisheyeCams) {
      const cell = createCell(cam);
      fisheyeGrid.appendChild(cell);
      cellParents[cam.videoTopic] = fisheyeGrid;
    }

    // Stack panes inside the tab content wrapper.
    tabContent.appendChild(camerasPane);
    tabContent.appendChild(fisheyePane);
    tabContent.appendChild(bevPane);

    // Tab switching: simple display toggle on panes + active class on tabs.
    function activateTab(name) {
      tabBar.querySelectorAll('.cam-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === name);
      });
      tabContent.querySelectorAll('.cam-tab-pane').forEach(p => {
        const isActive = p.classList.contains(`cam-tab-${name}`);
        p.classList.toggle('active', isActive);
      });
      // Force BEV redraw when switching to its tab so the canvas sizes to the
      // newly visible area.
      if (name === 'bev') { requestBevRedraw(); }
    }
    tabBar.querySelectorAll('.cam-tab').forEach(btn => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });

    // ----- Bottom: YOLO panel (always visible across tabs) -----
    const yoloPanel = buildYoloPanel();
    const splitterH = document.createElement('div');
    splitterH.className = 'cam-splitter-horizontal';
    splitterH.title = 'Drag to resize';
    attachVerticalDrag(splitterH, tabContent, yoloPanel);

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
          <canvas class="cam-float-yolo-overlay" id="cam-float-yolo"></canvas>
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

    // Layout container: tab bar on top, tab content + YOLO panel as
    // resizable flex column.
    const cameraBevWrap = document.createElement('div');
    cameraBevWrap.className = 'cam-main-area';
    cameraBevWrap.appendChild(tabBar);
    cameraBevWrap.appendChild(tabContent);
    cameraBevWrap.appendChild(splitterH);
    cameraBevWrap.appendChild(yoloPanel);

    gridContainer.appendChild(cameraBevWrap);
    gridContainer.appendChild(focusGrid);
    gridContainer.appendChild(floatOverlay);

    el.appendChild(sidebar);
    el.appendChild(gridContainer);
  }

  // ----- Resizable panel splitters -----

  function attachHorizontalDrag(handle, leftEl, rightEl) {
    let startX = 0;
    let startLeftBasis = 0;
    let startRightBasis = 0;
    let startTotal = 0;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      // Increase left, decrease right by same delta.
      const newLeft = Math.max(120, Math.min(startTotal - 120, startLeftBasis + dx));
      const newRight = startTotal - newLeft;
      leftEl.style.flex = `0 0 ${newLeft}px`;
      rightEl.style.flex = `0 0 ${newRight}px`;
      requestBevRedraw();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    handle.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const lr = leftEl.getBoundingClientRect();
      const rr = rightEl.getBoundingClientRect();
      startX = ev.clientX;
      startLeftBasis = lr.width;
      startRightBasis = rr.width;
      startTotal = startLeftBasis + startRightBasis;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function attachVerticalDrag(handle, topEl, bottomEl) {
    let startY = 0;
    let startTop = 0;
    let startBottom = 0;
    let startTotal = 0;

    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      const newTop = Math.max(120, Math.min(startTotal - 100, startTop + dy));
      const newBot = startTotal - newTop;
      topEl.style.flex = `0 0 ${newTop}px`;
      bottomEl.style.flex = `0 0 ${newBot}px`;
      requestBevRedraw();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    handle.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const tr = topEl.getBoundingClientRect();
      const br = bottomEl.getBoundingClientRect();
      startY = ev.clientY;
      startTop = tr.height;
      startBottom = br.height;
      startTotal = startTop + startBottom;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
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
      <span class="bev-layer-label">onemodel</span>
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

  // ----- YOLO control panel (right column, below BEV) -----

  function buildYoloPanel() {
    const wrap = document.createElement('div');
    wrap.className = 'yolo-panel';
    wrap.innerHTML = `
      <div class="yolo-panel-header">
        <span class="yolo-panel-title">YOLOv11</span>
        <span class="yolo-panel-status" id="yolo-status">${yoloIndex ? 'Loaded' : 'No data'}</span>
      </div>
      <div class="yolo-panel-controls">
        <select id="yolo-model" class="yolo-control" title="Model size">
          <option value="yolo11n">yolo11n  (5MB / fastest)</option>
          <option value="yolo11s">yolo11s  (10MB)</option>
          <option value="yolo11m">yolo11m  (20MB)</option>
          <option value="yolo11l">yolo11l  (25MB)</option>
          <option value="yolo11x">yolo11x  (57MB / best)</option>
        </select>
        <select id="yolo-device" class="yolo-control" title="Inference device">
          <option value="auto">device: auto</option>
          <option value="cpu">device: cpu</option>
          <option value="cuda:0">device: cuda:0</option>
        </select>
        <input id="yolo-conf" class="yolo-control" type="number" min="0.05" max="0.95"
               step="0.05" value="0.25" title="Confidence threshold" />
        <label class="yolo-checkbox" title="Skip 4 fisheye cameras (faster, less edge distortion noise)">
          <input id="yolo-skip-fisheye" type="checkbox" checked /> skip fisheye
        </label>
        <button id="yolo-run" class="yolo-run-btn">Run YOLO</button>
        <button id="yolo-cancel" class="yolo-cancel-btn" style="display:none">Cancel</button>
        <label class="yolo-toggle">
          <input id="yolo-show" type="checkbox" ${yoloIndex ? 'checked' : ''} ${yoloIndex ? '' : 'disabled'} />
          show overlay
        </label>
      </div>
      <div class="yolo-panel-progress" id="yolo-progress" style="display:none">
        <div class="yolo-progress-bar"><div class="yolo-progress-fill" id="yolo-progress-fill"></div></div>
        <div class="yolo-progress-text" id="yolo-progress-text">starting...</div>
      </div>
      <div class="yolo-panel-stats" id="yolo-stats"></div>
      <div class="yolo-panel-legend" id="yolo-legend"></div>
      <pre class="yolo-panel-log" id="yolo-log" style="display:none"></pre>
    `;

    setTimeout(() => bindYoloPanel(wrap), 0);
    return wrap;
  }

  function bindYoloPanel(panel) {
    const runBtn = panel.querySelector('#yolo-run');
    const cancelBtn = panel.querySelector('#yolo-cancel');
    const showCb = panel.querySelector('#yolo-show');
    const statusEl = panel.querySelector('#yolo-status');
    const progressEl = panel.querySelector('#yolo-progress');
    const progressFill = panel.querySelector('#yolo-progress-fill');
    const progressText = panel.querySelector('#yolo-progress-text');
    const statsEl = panel.querySelector('#yolo-stats');
    const legendEl = panel.querySelector('#yolo-legend');
    const logEl = panel.querySelector('#yolo-log');
    const modelSel = panel.querySelector('#yolo-model');
    const deviceSel = panel.querySelector('#yolo-device');
    const confInput = panel.querySelector('#yolo-conf');
    const skipFishCb = panel.querySelector('#yolo-skip-fisheye');

    let abortController = null;

    showCb.addEventListener('change', () => {
      bevView.showYolo = showCb.checked;
      requestBevRedraw();
    });

    cancelBtn.addEventListener('click', () => {
      if (abortController) {
        abortController.abort();
      }
    });

    runBtn.addEventListener('click', async () => {
      if (!mcapPath) {
        progressEl.style.display = 'block';
        progressText.textContent = 'No mcap server path. Use "Load from server path" to enable Run.';
        return;
      }
      runBtn.style.display = 'none';
      cancelBtn.style.display = 'inline-block';
      progressEl.style.display = 'block';
      progressFill.style.width = '5%';
      progressText.textContent = 'starting...';
      logEl.style.display = 'block';
      logEl.textContent = '';
      statusEl.textContent = 'running...';

      abortController = new AbortController();
      const t0 = performance.now();

      try {
        const final = await runYoloDetect({
          mcapPath,
          model: modelSel.value,
          device: deviceSel.value,
          conf: parseFloat(confInput.value) || 0.25,
          skipFisheye: skipFishCb.checked,
          signal: abortController.signal,
          onLog: (evt) => {
            if (evt.type === 'log') {
              const summary = summarizeLogLine(evt.line);
              if (summary) {
                progressText.textContent = summary;
                if (/Decoding/.test(summary)) { progressFill.style.width = '20%'; }
                else if (/decoded \d+ frames/.test(summary)) { progressFill.style.width = '40%'; }
                else if (/Running inference/.test(summary)) { progressFill.style.width = '55%'; }
                else if (/inferred \d+ detections/.test(summary)) { progressFill.style.width = '90%'; }
                else if (/Done\./.test(summary)) { progressFill.style.width = '100%'; }
              }
              logEl.textContent += evt.line + '\n';
              logEl.scrollTop = logEl.scrollHeight;
            } else if (evt.type === 'start') {
              progressText.textContent = `running ${evt.model} on ${evt.device}...`;
            }
          },
        });

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        progressFill.style.width = '100%';
        progressText.textContent = `done in ${elapsed}s. ${final.summary?.totalDetections || 0} detections in ${final.summary?.frames || 0} frames.`;

        // Reload sidecar
        const newIndex = await loadYoloSidecar(mcapPath);
        if (newIndex) {
          yoloIndex = newIndex;
          onYoloIndexChange(newIndex);
          bevDataCache.yoloIndex = newIndex;
          bevView.showYolo = true;
          showCb.checked = true;
          showCb.disabled = false;
          statusEl.textContent = `${newIndex.model} | ${newIndex.totalDetections} dets`;
          renderYoloStats(panel, newIndex);
          renderYoloLegend(legendEl);
          requestBevRedraw();
        } else {
          statusEl.textContent = 'sidecar load failed';
        }
      } catch (err) {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        if (err.name === 'AbortError') {
          progressText.textContent = `cancelled after ${elapsed}s`;
        } else {
          progressText.textContent = `failed: ${err.message}`;
          console.error('YOLO run failed:', err);
        }
        statusEl.textContent = 'failed';
      } finally {
        runBtn.style.display = 'inline-block';
        cancelBtn.style.display = 'none';
        abortController = null;
      }
    });

    // Initial render if a sidecar is already loaded.
    if (yoloIndex) {
      statusEl.textContent = `${yoloIndex.model} | ${yoloIndex.totalDetections} dets`;
      renderYoloStats(panel, yoloIndex);
      renderYoloLegend(legendEl);
    } else {
      renderYoloLegend(legendEl);
    }
  }

  function renderYoloStats(panel, index) {
    const statsEl = panel.querySelector('#yolo-stats');
    if (!statsEl || !index) { return; }
    const m = computeYoloMetrics(index);
    statsEl.innerHTML = renderYoloMetrics(m);
  }

  /**
   * Build all derivable quality metrics from a sidecar index.
   *
   * Returns:
   *   {
   *     topics, totalFrames, totalDets, confThreshold,
   *     byClass: [{name, count}],
   *     confHist: { bins: [{lo, hi, count}], total },
   *     perCamera: [{topic, short, count}],
   *     stability: {
   *       overallPct, overallPairs,
   *       perCamera: [{topic, short, jitterPct, pairs}],
   *     },
   *   }
   */
  function computeYoloMetrics(index) {
    let totalFrames = 0;
    let totalDets = 0;
    const byClass = {};
    const perCamCount = {};
    const confBins = [
      { lo: 0.0, hi: 0.4, count: 0 },
      { lo: 0.4, hi: 0.55, count: 0 },
      { lo: 0.55, hi: 0.7, count: 0 },
      { lo: 0.7, hi: 0.85, count: 0 },
      { lo: 0.85, hi: 1.0001, count: 0 },
    ];

    for (const [topic, arr] of Object.entries(index.framesByTopic)) {
      totalFrames += arr.length;
      perCamCount[topic] = 0;
      for (const f of arr) {
        for (const d of (f.detections || [])) {
          totalDets++;
          byClass[d.class_name] = (byClass[d.class_name] || 0) + 1;
          perCamCount[topic] += 1;
          for (const b of confBins) {
            if (d.confidence >= b.lo && d.confidence < b.hi) {
              b.count++;
              break;
            }
          }
        }
      }
    }

    const stability = computeStability(index);

    return {
      topics: Object.keys(index.framesByTopic).length,
      totalFrames,
      totalDets,
      confThreshold: index.confThreshold,
      byClass: Object.entries(byClass)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      confHist: { bins: confBins, total: totalDets },
      perCamera: Object.entries(perCamCount)
        .map(([topic, count]) => ({ topic, short: shortCamName(topic), count }))
        .sort((a, b) => b.count - a.count),
      stability,
    };
  }

  function shortCamName(topic) {
    // /sensor/camera/<name>/image/video -> <name>
    const m = topic.match(/\/sensor\/camera\/([^/]+)\//);
    return m ? m[1] : topic;
  }

  /**
   * Median-pair detection-center jitter between adjacent frames per camera.
   *
   * For each camera, walk frames in time order; on each adjacent pair, greedily
   * match same-class detections by IoU (>= 0.3); for matched pairs compute the
   * Euclidean distance between bbox centers, normalized by image diagonal.
   * Report the median per-pair jitter (in % of diagonal).
   */
  function computeStability(index) {
    const perCamera = [];
    let allDeltas = [];

    for (const [topic, frames] of Object.entries(index.framesByTopic)) {
      if (frames.length < 2) { continue; }
      const camDeltas = [];
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1];
        const b = frames[i];
        if (!a.image_w || !a.image_h) { continue; }
        const diag = Math.hypot(a.image_w, a.image_h);
        const matches = greedyMatchByIou(a.detections || [], b.detections || [], 0.3);
        for (const [da, db] of matches) {
          const ca = bboxCenter(da.bbox);
          const cb = bboxCenter(db.bbox);
          const dist = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
          camDeltas.push(dist / diag);
        }
      }
      if (camDeltas.length > 0) {
        const med = median(camDeltas);
        perCamera.push({
          topic,
          short: shortCamName(topic),
          jitterPct: med * 100,
          pairs: camDeltas.length,
        });
        allDeltas = allDeltas.concat(camDeltas);
      }
    }
    perCamera.sort((a, b) => a.jitterPct - b.jitterPct);
    return {
      overallPct: allDeltas.length > 0 ? median(allDeltas) * 100 : null,
      overallPairs: allDeltas.length,
      perCamera,
    };
  }

  function bboxCenter(b) { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  function median(arr) {
    if (arr.length === 0) { return 0; }
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function bboxIou(a, b) {
    const ix1 = Math.max(a[0], b[0]);
    const iy1 = Math.max(a[1], b[1]);
    const ix2 = Math.min(a[2], b[2]);
    const iy2 = Math.min(a[3], b[3]);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    if (inter <= 0) { return 0; }
    const aA = (a[2] - a[0]) * (a[3] - a[1]);
    const bA = (b[2] - b[0]) * (b[3] - b[1]);
    const u = aA + bA - inter;
    return u > 0 ? inter / u : 0;
  }
  function greedyMatchByIou(detsA, detsB, thresh) {
    const candidates = [];
    for (let i = 0; i < detsA.length; i++) {
      for (let j = 0; j < detsB.length; j++) {
        if (detsA[i].class_id !== detsB[j].class_id) { continue; }
        const iou = bboxIou(detsA[i].bbox, detsB[j].bbox);
        if (iou >= thresh) {
          candidates.push({ i, j, iou });
        }
      }
    }
    candidates.sort((x, y) => y.iou - x.iou);
    const usedA = new Set();
    const usedB = new Set();
    const matches = [];
    for (const c of candidates) {
      if (usedA.has(c.i) || usedB.has(c.j)) { continue; }
      usedA.add(c.i);
      usedB.add(c.j);
      matches.push([detsA[c.i], detsB[c.j]]);
    }
    return matches;
  }

  function renderYoloMetrics(m) {
    const fmtPct = (x) => (x == null ? '--' : `${x.toFixed(1)}%`);

    const headerRow = `
      <div class="yolo-stat-row">
        <span class="yolo-stat-label">topics</span><span>${m.topics}</span>
        <span class="yolo-stat-label">frames</span><span>${m.totalFrames}</span>
        <span class="yolo-stat-label">conf &gt;=</span><span>${m.confThreshold ?? '?'}</span>
      </div>`;

    const classChips = `
      <div class="yolo-stat-classes">
        ${m.byClass.map(c => `<span class="yolo-stat-chip">${c.name}: <b>${c.count}</b></span>`).join('')}
      </div>`;

    // Confidence histogram
    const maxBin = Math.max(1, ...m.confHist.bins.map(b => b.count));
    const histRows = m.confHist.bins.map(b => {
      const pct = m.confHist.total > 0 ? (b.count / m.confHist.total * 100) : 0;
      const w = (b.count / maxBin * 100);
      const range = b.hi >= 1.0 ? `${b.lo.toFixed(2)}-1.00` : `${b.lo.toFixed(2)}-${b.hi.toFixed(2)}`;
      return `
        <div class="yolo-mtr-row">
          <span class="yolo-mtr-key">${range}</span>
          <span class="yolo-mtr-bar"><span class="yolo-mtr-fill" style="width:${w.toFixed(0)}%"></span></span>
          <span class="yolo-mtr-val">${b.count} (${pct.toFixed(0)}%)</span>
        </div>`;
    }).join('');

    // Per-camera detection density
    const maxCam = Math.max(1, ...m.perCamera.map(c => c.count));
    const perCamRows = m.perCamera.map(c => {
      const w = c.count / maxCam * 100;
      return `
        <div class="yolo-mtr-row">
          <span class="yolo-mtr-key" title="${c.topic}">${c.short}</span>
          <span class="yolo-mtr-bar"><span class="yolo-mtr-fill" style="width:${w.toFixed(0)}%"></span></span>
          <span class="yolo-mtr-val">${c.count}</span>
        </div>`;
    }).join('');

    // Stability
    const s = m.stability;
    const stabHeader = `
      <div class="yolo-mtr-overall">
        overall jitter: <b>${fmtPct(s.overallPct)}</b>
        <span class="yolo-mtr-pair">(${s.overallPairs} pairs, lower = more stable)</span>
      </div>`;
    const stabRows = s.perCamera.map(p => {
      const w = Math.min(100, p.jitterPct * 10); // 10% jitter -> full bar
      return `
        <div class="yolo-mtr-row">
          <span class="yolo-mtr-key" title="${p.topic}">${p.short}</span>
          <span class="yolo-mtr-bar"><span class="yolo-mtr-fill stab" style="width:${w.toFixed(0)}%"></span></span>
          <span class="yolo-mtr-val">${p.jitterPct.toFixed(1)}% (${p.pairs})</span>
        </div>`;
    }).join('');

    return `
      ${headerRow}
      ${classChips}
      <details class="yolo-mtr-group" open>
        <summary>confidence histogram</summary>
        <div class="yolo-mtr-block">${histRows}</div>
      </details>
      <details class="yolo-mtr-group">
        <summary>detections per camera</summary>
        <div class="yolo-mtr-block">${perCamRows || '<i>no cameras</i>'}</div>
      </details>
      <details class="yolo-mtr-group">
        <summary>temporal stability (jitter)</summary>
        <div class="yolo-mtr-block">
          ${stabHeader}
          ${stabRows || '<i>not enough adjacent matches</i>'}
        </div>
      </details>
    `;
  }

  function renderYoloLegend(legendEl) {
    if (!legendEl) { return; }
    // Same class colors used in yolo-overlay.js / drawBboxesOnCanvas.
    const items = [
      { id: 0, name: 'person' },
      { id: 1, name: 'bicycle' },
      { id: 2, name: 'car' },
      { id: 3, name: 'motorcycle' },
      { id: 5, name: 'bus' },
      { id: 7, name: 'truck' },
      { id: 9, name: 'traffic light' },
      { id: 11, name: 'stop sign' },
    ];
    legendEl.innerHTML = items.map(it =>
      `<span class="yolo-legend-chip">
         <span class="yolo-legend-swatch" style="background:${getClassColor(it.id)}"></span>
         ${it.name}
       </span>`,
    ).join('');
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
      <canvas class="cam-cell-yolo-overlay" id="cam-yolo-${id}"></canvas>
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

    // Always pull the latest content from the cell so the floating preview
    // shows THIS camera (not whatever the previous open left behind).
    syncFloatFromCell(cam);
  }

  function closeFloatingPreview() {
    fullscreenCamera = null;
    const overlay = document.getElementById('cam-float-overlay');
    if (overlay) { overlay.style.display = 'none'; }
    // Clear stale pixels so a future open that hits the canvas-path before
    // a fresh frame arrives doesn't show ghost content.
    clearFloatPreviewSurfaces();
  }

  function syncFloatFromCell(cam) {
    const id = cssId(cam.videoTopic);
    const cellCanvas = document.getElementById(`cam-canvas-${id}`);
    const cellImg = document.getElementById(`cam-img-${id}`);
    const fc = document.getElementById('cam-float-canvas');
    const fi = document.getElementById('cam-float-img');
    const fy = document.getElementById('cam-float-yolo');

    // Pixels first: prefer canvas (H264 / WASM AVIF), fall back to img (native AVIF/JPEG/PNG).
    const canvasReady = cellCanvas
        && cellCanvas.style.display !== 'none'
        && cellCanvas.width > 0
        && cellCanvas.height > 0;
    const imgReady = cellImg
        && cellImg.style.display !== 'none'
        && cellImg.src
        && cellImg.complete
        && cellImg.naturalWidth > 0;

    if (canvasReady && fc) {
      fc.width = cellCanvas.width;
      fc.height = cellCanvas.height;
      fc.getContext('2d').drawImage(cellCanvas, 0, 0);
      fc.style.display = 'block';
      if (fi) { fi.style.display = 'none'; fi.removeAttribute('src'); }
    } else if (imgReady && fi) {
      fi.src = cellImg.src;
      fi.style.display = 'block';
      if (fc) {
        fc.style.display = 'none';
        fc.getContext('2d').clearRect(0, 0, fc.width || 1, fc.height || 1);
      }
    } else {
      // Nothing decoded yet for this camera; clear both.
      if (fc) {
        fc.style.display = 'none';
        fc.getContext('2d').clearRect(0, 0, fc.width || 1, fc.height || 1);
      }
      if (fi) {
        fi.style.display = 'none';
        fi.removeAttribute('src');
      }
    }

    // Reset YOLO overlay (it'll be redrawn on the next update tick).
    if (fy) {
      fy.getContext('2d').clearRect(0, 0, fy.width || 1, fy.height || 1);
    }

    // Sync FPS badge from the cell's badge text.
    const fb = document.getElementById('cam-float-fps');
    const cellFps = document.getElementById(`cam-fps-${id}`);
    if (fb && cellFps) {
      fb.textContent = cellFps.textContent;
    }
  }

  function clearFloatPreviewSurfaces() {
    const fc = document.getElementById('cam-float-canvas');
    const fi = document.getElementById('cam-float-img');
    const fy = document.getElementById('cam-float-yolo');
    if (fc) {
      fc.getContext('2d').clearRect(0, 0, fc.width || 1, fc.height || 1);
      fc.style.display = 'none';
    }
    if (fi) {
      fi.removeAttribute('src');
      fi.style.display = 'none';
    }
    if (fy) {
      fy.getContext('2d').clearRect(0, 0, fy.width || 1, fy.height || 1);
    }
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

    if (yoloIndex && bevView.showYolo) {
      drawYoloOverlays(currentSec);
    } else {
      clearYoloOverlays();
    }

    bevDataCache.currentSec = currentSec;
    bevDataCache.yoloIndex = yoloIndex;
    updateBev(currentSec);

    // YOLO BEV points need to follow playback even if BevMap/Occ haven't
    // changed; trigger a redraw if YOLO data is present.
    if (yoloIndex && bevView.showYolo) {
      requestBevRedraw();
    }
  }

  function clearYoloOverlays() {
    for (const cam of cameras) {
      const id = cssId(cam.videoTopic);
      const el = document.getElementById(`cam-yolo-${id}`);
      if (el) {
        const ctx = el.getContext('2d');
        ctx.clearRect(0, 0, el.width, el.height);
      }
    }
    const fOverlay = document.getElementById('cam-float-yolo');
    if (fOverlay) {
      const ctx = fOverlay.getContext('2d');
      ctx.clearRect(0, 0, fOverlay.width, fOverlay.height);
    }
  }

  function drawYoloOverlays(currentSec) {
    for (const cam of cameras) {
      if (!enabledSet.has(cam.videoTopic)) { continue; }
      const id = cssId(cam.videoTopic);
      const overlayEl = document.getElementById(`cam-yolo-${id}`);
      if (!overlayEl) { continue; }

      const frame = findFrameAt(yoloIndex, cam.videoTopic, currentSec, startTimeNs);
      if (!frame) {
        overlayEl.width = overlayEl.width;  // clear
        continue;
      }

      sizeOverlayToCell(overlayEl);
      const ctx = overlayEl.getContext('2d');
      ctx.clearRect(0, 0, overlayEl.width, overlayEl.height);
      drawBboxesOnCanvas(ctx, { width: overlayEl.width, height: overlayEl.height }, frame, {
        showLabel: true,
        minConfidence: 0,
      });
    }

    if (fullscreenCamera) {
      const fOverlay = document.getElementById('cam-float-yolo');
      if (fOverlay) {
        const frame = findFrameAt(yoloIndex, fullscreenCamera.videoTopic, currentSec, startTimeNs);
        sizeOverlayToFloat(fOverlay);
        const ctx = fOverlay.getContext('2d');
        ctx.clearRect(0, 0, fOverlay.width, fOverlay.height);
        if (frame) {
          drawBboxesOnCanvas(ctx, { width: fOverlay.width, height: fOverlay.height }, frame, {
            showLabel: true,
          });
        }
      }
    }
  }

  function sizeOverlayToCell(overlayEl) {
    const parent = overlayEl.parentElement;
    if (!parent) { return; }
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (overlayEl.width !== w) { overlayEl.width = w; }
    if (overlayEl.height !== h) { overlayEl.height = h; }
  }

  function sizeOverlayToFloat(overlayEl) {
    const parent = overlayEl.parentElement;
    if (!parent) { return; }
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (overlayEl.width !== w) { overlayEl.width = w; }
    if (overlayEl.height !== h) { overlayEl.height = h; }
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
