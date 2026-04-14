/**
 * 3D Scene renderer using Three.js.
 * Renders foxglove.SceneUpdate entities (lines, cubes, triangles, texts).
 * BEV (Bird's Eye View) default camera with OrbitControls.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const DEFAULT_COLORS = {
  line: 0x10b981,
  cube: 0x3b82f6,
  triangle: 0x8b5cf6,
  grid: 0xffffff,
  background: 0x0a0a0a,
  ground: 0x1a1a1a,
};

export function create3DScene(container) {
  const W = container.clientWidth || 800;
  const H = container.clientHeight || 600;

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(DEFAULT_COLORS.background);

  // Camera — slightly angled BEV for depth perception
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 2000);
  camera.position.set(-15, -25, 50);
  camera.up.set(0, 0, 1);
  camera.lookAt(10, 0, 0);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.target.set(5, 0, 0);

  // Ground grid
  const gridHelper = new THREE.GridHelper(200, 100, 0x222222, 0x151515);
  gridHelper.rotation.x = Math.PI / 2; // XY plane for BEV
  scene.add(gridHelper);

  // Ambient light
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.4);
  dirLight.position.set(50, 50, 100);
  scene.add(dirLight);

  // ===== EGO VEHICLE MARKER (always at origin in BEV frame) =====
  const egoGroup = new THREE.Group();
  egoGroup.name = 'ego_marker';

  // Car body
  const egoBodyGeo = new THREE.BoxGeometry(3.7, 1.4, 1.2);
  const egoBodyMat = new THREE.MeshPhongMaterial({ color: 0x00e5ff, emissive: 0x004455, opacity: 0.95, transparent: true });
  const egoBody = new THREE.Mesh(egoBodyGeo, egoBodyMat);
  egoBody.position.set(0, 0, 0.6);
  egoGroup.add(egoBody);

  // Car roof
  const egoRoofGeo = new THREE.BoxGeometry(2.0, 1.2, 0.6);
  const egoRoofMat = new THREE.MeshPhongMaterial({ color: 0x0097a7, emissive: 0x003040, opacity: 0.9, transparent: true });
  const egoRoof = new THREE.Mesh(egoRoofGeo, egoRoofMat);
  egoRoof.position.set(-0.2, 0, 1.35);
  egoGroup.add(egoRoof);

  // Direction arrow
  const egoArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1.8),
    3.5, 0x00e5ff, 1.0, 0.5
  );
  egoGroup.add(egoArrow);

  // Wireframe
  const egoWireGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(3.7, 1.4, 2.0));
  const egoWireMat = new THREE.LineBasicMaterial({ color: 0x00e5ff, opacity: 0.7, transparent: true });
  const egoWire = new THREE.LineSegments(egoWireGeo, egoWireMat);
  egoWire.position.set(0, 0, 1.0);
  egoGroup.add(egoWire);

  // "EGO" label
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 128; labelCanvas.height = 32;
  const labelCtx = labelCanvas.getContext('2d');
  labelCtx.fillStyle = '#00e5ff';
  labelCtx.font = 'bold 24px Inter, sans-serif';
  labelCtx.textAlign = 'center';
  labelCtx.fillText('EGO', 64, 24);
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true, opacity: 0.9 });
  const labelSprite = new THREE.Sprite(labelMat);
  labelSprite.scale.set(4, 1, 1);
  labelSprite.position.set(0, 0, 3.0);
  egoGroup.add(labelSprite);

  scene.add(egoGroup);

  // Topic entity groups: topic -> THREE.Group
  const topicGroups = new Map();
  const enabledTopics = new Set();

  // Animation loop
  let animId = null;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Resize handler
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', resize);
  const resizeObs = new ResizeObserver(resize);
  resizeObs.observe(container);

  // ===== ENTITY RENDERING =====

  function getOrCreateGroup(topic) {
    if (!topicGroups.has(topic)) {
      const group = new THREE.Group();
      group.name = topic;
      topicGroups.set(topic, group);
      if (enabledTopics.has(topic)) {
        scene.add(group);
      }
    }
    return topicGroups.get(topic);
  }

  function clearGroup(topic) {
    const group = topicGroups.get(topic);
    if (!group) return;
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    }
  }

  /**
   * Render a foxglove.SceneUpdate decoded message for a topic.
   * @param {string} topic
   * @param {object} sceneUpdate — decoded foxglove.SceneUpdate
   */
  function renderSceneUpdate(topic, sceneUpdate) {
    if (!enabledTopics.has(topic)) return;
    if (!sceneUpdate || (!sceneUpdate.entities?.length && !sceneUpdate.deletions?.length)) return;

    const group = getOrCreateGroup(topic);

    // Clear previous frame — each SceneUpdate is a snapshot
    clearGroup(topic);

    // Render entities
    for (const entity of (sceneUpdate.entities || [])) {
      renderEntity(group, entity);
    }
  }

  function renderEntity(group, entity) {
    const isEgoCar = entity.id?.startsWith('ego_car');
    for (const line of (entity.lines || [])) renderLine(group, line, entity.id);
    for (let ci = 0; ci < (entity.cubes || []).length; ci++) {
      const cube = entity.cubes[ci];
      if (isEgoCar && ci === 0) {
        renderEgoVehicle(group, cube, entity.id);
      } else {
        renderCube(group, cube, entity.id);
      }
    }
    for (const tri of (entity.triangles || [])) renderTriangles(group, tri, entity.id);
    for (const arrow of (entity.arrows || [])) renderArrow(group, arrow, entity.id);
    for (const sphere of (entity.spheres || [])) renderSphere(group, sphere, entity.id);
    for (const cylinder of (entity.cylinders || [])) renderCylinder(group, cylinder, entity.id);
  }

  function renderEgoVehicle(group, cubeData, entityId) {
    const size = cubeData.size || { x: 3.7, y: 1.4, z: 2.2 };
    const w = size.x || 3.7, h = size.y || 1.4, d = size.z || 2.2;

    // Car body — bright cyan, solid
    const bodyGeo = new THREE.BoxGeometry(w, h, d * 0.6);
    const bodyMat = new THREE.MeshPhongMaterial({ color: 0x00e5ff, opacity: 0.85, transparent: true });
    const body = new THREE.Mesh(bodyGeo, bodyMat);

    const pos = cubeData.pose?.position;
    if (pos) body.position.set(pos.x || 0, pos.y || 0, (pos.z || 0));
    const q = cubeData.pose?.orientation;
    if (q) body.quaternion.set(q.x || 0, q.y || 0, q.z || 0, q.w || 1);

    body.userData.entityId = entityId;
    group.add(body);

    // Roof — slightly smaller, darker
    const roofGeo = new THREE.BoxGeometry(w * 0.6, h * 0.9, d * 0.35);
    const roofMat = new THREE.MeshPhongMaterial({ color: 0x0097a7, opacity: 0.8, transparent: true });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.copy(body.position);
    roof.position.z += d * 0.45;
    roof.position.x -= w * 0.05;
    roof.quaternion.copy(body.quaternion);
    group.add(roof);

    // Direction arrow on top
    const dir = new THREE.Vector3(1, 0, 0);
    if (q) dir.applyQuaternion(new THREE.Quaternion(q.x || 0, q.y || 0, q.z || 0, q.w || 1));
    const arrOrigin = body.position.clone();
    arrOrigin.z += d * 0.65;
    const arrHelper = new THREE.ArrowHelper(dir.normalize(), arrOrigin, w * 0.8, 0x00e5ff, w * 0.3, w * 0.15);
    group.add(arrHelper);

    // Wireframe outline
    const wireGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
    const wireMat = new THREE.LineBasicMaterial({ color: 0x00e5ff, opacity: 0.6, transparent: true });
    const wireframe = new THREE.LineSegments(wireGeo, wireMat);
    wireframe.position.copy(body.position);
    wireframe.quaternion.copy(body.quaternion);
    group.add(wireframe);
  }

  function parseColor(c) {
    if (!c) return new THREE.Color(DEFAULT_COLORS.line);
    return new THREE.Color(c.r || 0, c.g || 0, c.b || 0);
  }

  function parseAlpha(c) {
    return c?.a !== undefined ? c.a : 1;
  }

  function renderLine(group, lineData, entityId) {
    const points = lineData.points;
    if (!points || points.length < 2) return;

    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x || 0;
      positions[i * 3 + 1] = points[i].y || 0;
      positions[i * 3 + 2] = points[i].z || 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const color = parseColor(lineData.color);
    const alpha = parseAlpha(lineData.color);
    const material = new THREE.LineBasicMaterial({
      color,
      opacity: alpha,
      transparent: alpha < 1,
      linewidth: 1,
    });

    const mesh = lineData.type === 1
      ? new THREE.LineSegments(geometry, material) // LINE_STRIP pairs
      : new THREE.Line(geometry, material);        // LINE_STRIP

    mesh.userData.entityId = entityId;
    group.add(mesh);
  }

  function renderCube(group, cubeData, entityId) {
    const size = cubeData.size || { x: 1, y: 1, z: 1 };
    const geometry = new THREE.BoxGeometry(size.x || 1, size.y || 1, size.z || 1);

    const color = parseColor(cubeData.color);
    const alpha = parseAlpha(cubeData.color);
    const material = new THREE.MeshPhongMaterial({
      color,
      opacity: Math.min(alpha, 0.6),
      transparent: true,
    });

    const mesh = new THREE.Mesh(geometry, material);

    const pos = cubeData.pose?.position;
    if (pos) mesh.position.set(pos.x || 0, pos.y || 0, pos.z || 0);

    const q = cubeData.pose?.orientation;
    if (q) mesh.quaternion.set(q.x || 0, q.y || 0, q.z || 0, q.w || 1);

    mesh.userData.entityId = entityId;
    group.add(mesh);

    // Wireframe outline
    const wireGeo = new THREE.EdgesGeometry(geometry);
    const wireMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.3, transparent: true });
    const wireframe = new THREE.LineSegments(wireGeo, wireMat);
    wireframe.position.copy(mesh.position);
    wireframe.quaternion.copy(mesh.quaternion);
    group.add(wireframe);
  }

  function renderTriangles(group, triData, entityId) {
    const points = triData.points;
    if (!points || points.length < 3) return;

    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x || 0;
      positions[i * 3 + 1] = points[i].y || 0;
      positions[i * 3 + 2] = points[i].z || 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();

    const color = parseColor(triData.color);
    const alpha = parseAlpha(triData.color);
    const material = new THREE.MeshPhongMaterial({
      color,
      opacity: Math.min(alpha, 0.5),
      transparent: true,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.entityId = entityId;
    group.add(mesh);
  }

  function renderArrow(group, arrowData, entityId) {
    const pos = arrowData.pose?.position || { x: 0, y: 0, z: 0 };
    const len = arrowData.length || 2;
    const color = parseColor(arrowData.color);

    const dir = new THREE.Vector3(1, 0, 0);
    const q = arrowData.pose?.orientation;
    if (q) {
      const quat = new THREE.Quaternion(q.x || 0, q.y || 0, q.z || 0, q.w || 1);
      dir.applyQuaternion(quat);
    }

    const origin = new THREE.Vector3(pos.x || 0, pos.y || 0, pos.z || 0);
    const arrowHelper = new THREE.ArrowHelper(dir.normalize(), origin, len, color.getHex(), len * 0.2, len * 0.1);
    arrowHelper.userData.entityId = entityId;
    group.add(arrowHelper);
  }

  function renderSphere(group, sphereData, entityId) {
    const size = sphereData.size || { x: 1, y: 1, z: 1 };
    const r = Math.max(size.x || 1, size.y || 1, size.z || 1) / 2;
    const geometry = new THREE.SphereGeometry(r, 12, 8);
    const color = parseColor(sphereData.color);
    const alpha = parseAlpha(sphereData.color);
    const material = new THREE.MeshPhongMaterial({ color, opacity: Math.min(alpha, 0.7), transparent: true });
    const mesh = new THREE.Mesh(geometry, material);
    const pos = sphereData.pose?.position;
    if (pos) mesh.position.set(pos.x || 0, pos.y || 0, pos.z || 0);
    mesh.userData.entityId = entityId;
    group.add(mesh);
  }

  function renderCylinder(group, cylData, entityId) {
    const r = (cylData.top_radius || cylData.bottom_radius || 0.5);
    const h = cylData.size?.z || 1;
    const geometry = new THREE.CylinderGeometry(r, cylData.bottom_radius || r, h, 12);
    const color = parseColor(cylData.color);
    const material = new THREE.MeshPhongMaterial({ color, opacity: 0.6, transparent: true });
    const mesh = new THREE.Mesh(geometry, material);
    const pos = cylData.pose?.position;
    if (pos) mesh.position.set(pos.x || 0, pos.y || 0, pos.z || 0);
    mesh.userData.entityId = entityId;
    group.add(mesh);
  }

  /**
   * Render a foxglove.Grid message.
   */
  function renderGrid(topic, gridData) {
    if (!enabledTopics.has(topic)) return;

    const group = getOrCreateGroup(topic);
    clearGroup(topic);

    const cellSize = gridData.cell_size || [1, 1];
    const cols = gridData.column_count || 0;
    const data = gridData.data;
    if (!cols || !data) return;

    const rows = Math.floor(data.length / (cols * (gridData.cell_stride || 1)));
    const width = cols * (cellSize[0] || 1);
    const height = rows * (cellSize[1] || 1);

    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(cols, rows);

    for (let i = 0; i < cols * rows && i < data.length; i++) {
      const v = typeof data === 'string' ? data.charCodeAt(i) : (data[i] || 0);
      const idx = i * 4;
      imgData.data[idx] = v;
      imgData.data[idx + 1] = v;
      imgData.data[idx + 2] = v;
      imgData.data[idx + 3] = v > 0 ? 200 : 0;
    }
    ctx.putImageData(imgData, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);

    const pos = gridData.pose?.position;
    if (pos) mesh.position.set(pos.x || 0, pos.y || 0, (pos.z || 0) + 0.01);

    group.add(mesh);
    if (!scene.children.includes(group)) scene.add(group);
  }

  // ===== TOPIC MANAGEMENT =====

  function enableTopic(topic) {
    enabledTopics.add(topic);
    const group = topicGroups.get(topic);
    if (group && !scene.children.includes(group)) {
      scene.add(group);
    }
  }

  function disableTopic(topic) {
    enabledTopics.delete(topic);
    const group = topicGroups.get(topic);
    if (group) scene.remove(group);
  }

  function clearAllTopics() {
    for (const [topic] of topicGroups) {
      clearGroup(topic);
    }
  }

  function resetCamera() {
    camera.position.set(-15, -25, 50);
    camera.up.set(0, 0, 1);
    camera.lookAt(10, 0, 0);
    controls.target.set(5, 0, 0);
    controls.update();
  }

  function destroy() {
    if (animId) cancelAnimationFrame(animId);
    resizeObs.disconnect();
    window.removeEventListener('resize', resize);
    for (const [topic] of topicGroups) clearGroup(topic);
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    renderSceneUpdate,
    renderGrid,
    enableTopic,
    disableTopic,
    clearAllTopics,
    resetCamera,
    destroy,
    get enabledTopics() { return enabledTopics; },
  };
}
