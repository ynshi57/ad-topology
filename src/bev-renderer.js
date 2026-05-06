/**
 * BEV renderer — pure canvas-2d drawing functions for the BEV view.
 *
 * Coordinate convention (vehicle frame):
 *   x = forward, y = left, z = up, all in meters.
 *
 * On screen we orient so that:
 *   - vehicle origin (0,0) is at canvas center
 *   - forward direction (+x) points to the RIGHT of the screen
 *   - left direction (+y) points UP
 *   - z is ignored (top-down view)
 */

import { LineMainType, LineColor, LineStyle, ObjectType, OccupancyStatus } from './bev-decoder.js';

const LINE_COLORS = {
  byMainType: {
    [LineMainType.CENTER]:    'rgba(120, 120, 120, 0.5)',
    [LineMainType.BOUNDARY]:  '#ffffff',
    [LineMainType.CURB]:      '#9ca3af',
    [LineMainType.STOP]:      '#ef4444',
    [LineMainType.SPEED_BUMP]: '#f59e0b',
    [LineMainType.DIVERSION]: '#facc15',
    [LineMainType.VIRTUAL]:   'rgba(255,255,255,0.25)',
    [LineMainType.UNKNOWN]:   'rgba(255,255,255,0.4)',
  },
  byColor: {
    [LineColor.WHITE]:   '#ffffff',
    [LineColor.YELLOW]:  '#facc15',
    [LineColor.UNKNOWN]: null,
  },
};

const OBJECT_COLORS = {
  [ObjectType.UNKNOWN]:      '#9ca3af',
  [ObjectType.VEHICLE]:      '#10b981',
  [ObjectType.PEDESTRIAN]:   '#fbbf24',
  [ObjectType.CYCLIST]:      '#a78bfa',
  [ObjectType.LARGEVEHICLE]: '#34d399',
  [ObjectType.SOD]:          '#60a5fa',
  [ObjectType.PARKING_SPACE]: '#a78bfa',
  [ObjectType.BICYCLE]:      '#f472b6',
};

const OCC_COLORS = {
  byStatus: {
    [OccupancyStatus.OCCUPIED]: 'rgba(239,68,68,0.45)',
    [OccupancyStatus.FILTER]:   'rgba(245,158,11,0.40)',
    [OccupancyStatus.FREE]:     'rgba(120,120,120,0.0)',
    [OccupancyStatus.UNKNOWN]:  'rgba(120,120,120,0.0)',
  },
};

export function createBevViewState() {
  return {
    pxPerMeter: 6,
    panX: 0,
    panY: 0,
    showLanes: true,
    showObjects: true,
    showOccupancy: true,
    showMap: true,
  };
}

function applyBevTransform(ctx, canvasW, canvasH, view) {
  const cx = canvasW / 2 + view.panX;
  const cy = canvasH / 2 + view.panY;
  ctx.translate(cx, cy);
  ctx.scale(view.pxPerMeter, -view.pxPerMeter);
}

function drawGrid(ctx, canvasW, canvasH, view) {
  ctx.save();
  applyBevTransform(ctx, canvasW, canvasH, view);

  const cx = canvasW / 2 + view.panX;
  const cy = canvasH / 2 + view.panY;
  const xMinM = (-cx) / view.pxPerMeter;
  const xMaxM = (canvasW - cx) / view.pxPerMeter;
  const yMinM = -((canvasH - cy) / view.pxPerMeter);
  const yMaxM = -((-cy) / view.pxPerMeter);

  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1 / view.pxPerMeter;
  const step = 10;
  ctx.beginPath();
  const x0 = Math.floor(xMinM / step) * step;
  const x1 = Math.ceil(xMaxM / step) * step;
  const y0 = Math.floor(yMinM / step) * step;
  const y1 = Math.ceil(yMaxM / step) * step;
  for (let x = x0; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let y = y0; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1.5 / view.pxPerMeter;
  ctx.beginPath();
  ctx.moveTo(x0, 0); ctx.lineTo(x1, 0);
  ctx.moveTo(0, y0); ctx.lineTo(0, y1);
  ctx.stroke();
  ctx.restore();
}

function drawEgo(ctx, canvasW, canvasH, view) {
  ctx.save();
  applyBevTransform(ctx, canvasW, canvasH, view);
  const len = 2.9, wid = 1.1;
  ctx.fillStyle = 'rgba(0, 229, 255, 0.18)';
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.rect(-0.6, -wid / 2, len, wid);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(2.3, 0);
  ctx.lineTo(1.6, 0.4);
  ctx.lineTo(1.6, -0.4);
  ctx.closePath();
  ctx.fillStyle = '#00e5ff';
  ctx.fill();
  ctx.restore();
}

function drawLine(ctx, line) {
  if (!line || !line.points || line.points.length < 2) { return; }
  let stroke = LINE_COLORS.byColor[line.color];
  if (!stroke) {
    stroke = LINE_COLORS.byMainType[line.mainType] || LINE_COLORS.byMainType[LineMainType.UNKNOWN];
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = line.mainType === LineMainType.STOP ? 0.4 : 0.15;
  ctx.beginPath();
  ctx.moveTo(line.points[0].x, line.points[0].y);
  for (let i = 1; i < line.points.length; i++) {
    ctx.lineTo(line.points[i].x, line.points[i].y);
  }
  if (line.style === LineStyle.DASH) {
    ctx.setLineDash([0.6, 0.4]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.stroke();
  }
}

function drawLines(ctx, canvasW, canvasH, view, bevMap) {
  if (!bevMap) { return; }
  ctx.save();
  applyBevTransform(ctx, canvasW, canvasH, view);
  for (const line of bevMap.stopLines) { drawLine(ctx, line); }
  for (const line of bevMap.roadBoundaries) { drawLine(ctx, line); }
  for (const line of bevMap.allLines) { drawLine(ctx, line); }
  for (const lane of bevMap.lanes) {
    if (lane.centerLine) { drawLine(ctx, lane.centerLine); }
    if (lane.leftBoundary) { drawLine(ctx, lane.leftBoundary); }
    if (lane.rightBoundary) { drawLine(ctx, lane.rightBoundary); }
  }
  ctx.restore();
}

function drawObject(ctx, obj) {
  const { center, size, heading } = obj.geometry;
  const halfX = size.x / 2;
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(heading);
  ctx.beginPath();
  ctx.rect(-halfX, -size.y / 2, size.x, size.y);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(halfX, 0);
  ctx.stroke();
  ctx.restore();
}

function drawObjects(ctx, canvasW, canvasH, view, bevMap) {
  if (!bevMap) { return; }
  ctx.save();
  applyBevTransform(ctx, canvasW, canvasH, view);
  ctx.lineWidth = 0.08;

  for (const obj of bevMap.staticObjects) {
    const color = OBJECT_COLORS[obj.objectType] || OBJECT_COLORS[ObjectType.UNKNOWN];
    ctx.fillStyle = hexAlpha(color, 0.15);
    ctx.strokeStyle = hexAlpha(color, 0.55);
    drawObject(ctx, obj);
  }
  for (const obj of bevMap.objects) {
    const color = OBJECT_COLORS[obj.objectType] || OBJECT_COLORS[ObjectType.UNKNOWN];
    ctx.fillStyle = hexAlpha(color, 0.30);
    ctx.strokeStyle = color;
    drawObject(ctx, obj);

    if (Math.abs(obj.vx) > 0.1 || Math.abs(obj.vy) > 0.1) {
      const c = obj.geometry.center;
      const vMag = Math.hypot(obj.vx, obj.vy);
      const scale = Math.min(2, vMag * 0.5);
      const dx = (obj.vx / vMag) * scale;
      const dy = (obj.vy / vMag) * scale;
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + dx, c.y + dy);
      ctx.stroke();
      const ang = Math.atan2(dy, dx);
      const ah = 0.3;
      ctx.beginPath();
      ctx.moveTo(c.x + dx, c.y + dy);
      ctx.lineTo(c.x + dx - ah * Math.cos(ang - 0.4), c.y + dy - ah * Math.sin(ang - 0.4));
      ctx.lineTo(c.x + dx - ah * Math.cos(ang + 0.4), c.y + dy - ah * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawOccupancy(ctx, canvasW, canvasH, view, occResult, occCells) {
  if (!occResult || !occCells || occCells.length === 0) { return; }
  ctx.save();
  applyBevTransform(ctx, canvasW, canvasH, view);
  const lo = occResult.lowerBound;
  const res = occResult.resolution;
  for (const cell of occCells) {
    const color = OCC_COLORS.byStatus[cell.status];
    if (!color) { continue; }
    const x = lo.x + cell.gx * res.x;
    const y = lo.y + cell.gy * res.y;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, res.x, res.y);
  }
  ctx.restore();
}

function drawScaleBar(ctx, canvasW, canvasH, view) {
  const targetPx = 80;
  const meters = niceRound(targetPx / view.pxPerMeter);
  const px = meters * view.pxPerMeter;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1;
  ctx.font = '11px Inter, sans-serif';
  const x = canvasW - px - 20;
  const y = canvasH - 20;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  ctx.moveTo(x + px, y - 4);
  ctx.lineTo(x + px, y + 4);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillText(`${meters}m`, x + px / 2, y - 6);
  ctx.restore();
}

function drawAxisLabels(ctx, canvasW, canvasH, view) {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '10px Inter, sans-serif';
  ctx.fillText('FRONT  +x ->', canvasW - 90, 18);
  ctx.fillText('+y (LEFT)', 6, 18);
  ctx.restore();
}

/**
 * Full redraw of the BEV canvas.
 */
export function renderBev(ctx, canvasSize, view, data) {
  const { width, height } = canvasSize;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height, view);

  if (view.showOccupancy && data.occResult && data.occCells) {
    drawOccupancy(ctx, width, height, view, data.occResult, data.occCells);
  }
  if (view.showLanes && data.bevMap) {
    drawLines(ctx, width, height, view, data.bevMap);
  }
  if (view.showObjects && data.bevMap) {
    drawObjects(ctx, width, height, view, data.bevMap);
  }
  drawEgo(ctx, width, height, view);
  drawAxisLabels(ctx, width, height, view);
  drawScaleBar(ctx, width, height, view);
}

function hexAlpha(color, alpha) {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

function niceRound(x) {
  if (x <= 0) { return 1; }
  const exp = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, exp);
  let nf;
  if (f < 1.5) { nf = 1; }
  else if (f < 3) { nf = 2; }
  else if (f < 7) { nf = 5; }
  else { nf = 10; }
  return nf * Math.pow(10, exp);
}

/**
 * Attach mouse pan + wheel zoom listeners. Returns unbinder.
 */
export function attachPanZoom(canvas, view, onChange) {
  let dragging = false;
  let lastX = 0, lastY = 0;

  function onDown(e) {
    if (e.button !== 0) { return; }
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) { return; }
    view.panX += (e.clientX - lastX);
    view.panY += (e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    onChange(view);
  }
  function onUp() { dragging = false; }
  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - canvas.width / 2 - view.panX;
    const my = e.clientY - rect.top - canvas.height / 2 - view.panY;
    const oldPx = view.pxPerMeter;
    view.pxPerMeter = Math.max(1, Math.min(50, oldPx * factor));
    const ratio = view.pxPerMeter / oldPx - 1;
    view.panX -= mx * ratio;
    view.panY -= my * ratio;
    onChange(view);
  }
  function onDblClick() {
    view.panX = 0;
    view.panY = 0;
    view.pxPerMeter = 6;
    onChange(view);
  }

  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);

  return () => {
    canvas.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDblClick);
  };
}
