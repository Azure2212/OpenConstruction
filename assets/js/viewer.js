// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q3 — Client-side AEC viewer. Three.js scene + orbit controls. Parses ASCII point
// clouds (.xyz/.pts/.ply) directly; loads IFC via web-ifc (lazy, experimental). $0:
// everything runs in the browser, no upload.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const stage = document.getElementById('stage');
const statusEl = document.getElementById('status');
const pillType = document.getElementById('pillType');
const pillCount = document.getElementById('pillCount');
const dropHint = document.getElementById('dropHint');

function setStatus(msg) { statusEl.textContent = msg || ''; }
function setPills(type, count) {
  if (type) { pillType.textContent = type; pillType.classList.remove('d-none'); } else pillType.classList.add('d-none');
  if (count != null) { pillCount.textContent = count.toLocaleString() + ' pts'; pillCount.classList.remove('d-none'); } else pillCount.classList.add('d-none');
}

// ---- Three.js scene ------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1622);
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100000);
camera.position.set(8, 6, 12);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xcfe0f0, 0x223344, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.0); dir.position.set(10, 20, 10); scene.add(dir);
const grid = new THREE.GridHelper(40, 40, 0x274056, 0x1a2c3d); scene.add(grid);

let current = null; // current object (Points or Group)

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

(function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();

function clearCurrent() { if (current) { scene.remove(current); current.traverse?.(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); current = null; } }

function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(maxDim * 0.9, maxDim * 0.7, maxDim * 1.4));
  camera.near = maxDim / 1000; camera.far = maxDim * 1000; camera.updateProjectionMatrix();
  grid.position.set(center.x, box.min.y, center.z);
  const s = maxDim / 40; grid.scale.set(s, s, s);
}
document.getElementById('resetView').addEventListener('click', () => { if (current) frameObject(current); });

// ---- Point cloud parsing (.xyz / .pts / .ply ASCII) ----------------------
function parsePoints(text, ext) {
  const lines = text.split(/\r?\n/);
  let start = 0, hasRGB = false;
  if (ext === 'ply') {
    // skip header; detect red/green/blue props; assume vertex section follows end_header
    let i = 0; for (; i < lines.length; i++) { const l = lines[i].trim(); if (/red|green|blue/i.test(l)) hasRGB = true; if (l === 'end_header') { start = i + 1; break; } }
  }
  const pos = [], col = [];
  for (let i = start; i < lines.length; i++) {
    const p = lines[i].trim(); if (!p) continue;
    const a = p.split(/[\s,]+/).map(Number);
    if (a.length < 3 || !isFinite(a[0]) || !isFinite(a[1]) || !isFinite(a[2])) continue;
    pos.push(a[0], a[1], a[2]);
    if (a.length >= 6) { // x y z r g b  (0-255 or 0-1)
      const sc = (a[3] > 1 || a[4] > 1 || a[5] > 1) ? 1 / 255 : 1;
      col.push(a[3] * sc, a[4] * sc, a[5] * sc); hasRGB = true;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (hasRGB && col.length === pos.length) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingBox();
  const mat = new THREE.PointsMaterial({ size: 0.02, sizeAttenuation: true, vertexColors: hasRGB && col.length === pos.length });
  if (!mat.vertexColors) mat.color = new THREE.Color(0x7fd1b9);
  // scale point size to model extent
  const bb = geo.boundingBox; if (bb) { const d = bb.getSize(new THREE.Vector3()).length(); mat.size = Math.max(d / 600, 1e-4); }
  return { object: new THREE.Points(geo, mat), count: pos.length / 3 };
}

function loadPointText(text, ext, label) {
  clearCurrent();
  const { object, count } = parsePoints(text, ext);
  if (!count) { setStatus('No 3D points found in this file.'); return; }
  current = object; scene.add(current); frameObject(current);
  dropHint.style.display = 'none';
  setPills('Point cloud (.' + ext + ')', count);
  setStatus('Loaded ' + (label || '') + ' — ' + count.toLocaleString() + ' points. Drag to orbit, scroll to zoom.');
}

// ---- IFC (experimental, lazy) -------------------------------------------
async function loadIFC(buffer, label) {
  setStatus('Loading IFC engine (web-ifc)…');
  let WebIFC;
  try { WebIFC = await import('https://unpkg.com/web-ifc@0.0.57/web-ifc-api.js'); }
  catch (e) { setStatus('Could not load the IFC engine (offline or blocked). Point clouds still work.'); return; }
  try {
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath('https://unpkg.com/web-ifc@0.0.57/');
    await api.Init();
    const modelID = api.OpenModel(new Uint8Array(buffer));
    clearCurrent();
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xc9d6e3, side: THREE.DoubleSide });
    api.StreamAllMeshes(modelID, (mesh) => {
      const placed = mesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        const geom = api.GetGeometry(modelID, pg.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const positions = new Float32Array(verts.length / 2);
        const normals = new Float32Array(verts.length / 2);
        for (let v = 0, p = 0; v < verts.length; v += 6, p += 3) {
          positions[p] = verts[v]; positions[p + 1] = verts[v + 1]; positions[p + 2] = verts[v + 2];
          normals[p] = verts[v + 3]; normals[p + 1] = verts[v + 4]; normals[p + 2] = verts[v + 5];
        }
        const m = pg.flatTransformation;
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        bg.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        bg.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
        const meshObj = new THREE.Mesh(bg, mat);
        meshObj.applyMatrix4(new THREE.Matrix4().fromArray(m));
        group.add(meshObj);
      }
    });
    api.CloseModel(modelID);
    if (!group.children.length) { setStatus('IFC parsed but no geometry was produced.'); return; }
    current = group; scene.add(current); frameObject(current);
    dropHint.style.display = 'none';
    setPills('IFC / BIM', null); pillCount.textContent = group.children.length.toLocaleString() + ' meshes'; pillCount.classList.remove('d-none');
    setStatus('Loaded IFC ' + (label || '') + ' — ' + group.children.length + ' meshes. Experimental renderer.');
  } catch (e) {
    setStatus('Failed to render this IFC file (experimental). Error: ' + (e && e.message || e));
  }
}

// ---- File intake ---------------------------------------------------------
function handleFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  setStatus('Reading ' + file.name + '…');
  const reader = new FileReader();
  if (ext === 'ifc') {
    reader.onload = () => loadIFC(reader.result, file.name);
    reader.readAsArrayBuffer(file);
  } else if (['xyz', 'pts', 'ply'].includes(ext)) {
    reader.onload = () => loadPointText(reader.result, ext, file.name);
    reader.readAsText(file);
  } else {
    setStatus('Unsupported file type: .' + ext + ' — try .xyz, .pts, .ply or .ifc');
  }
}

document.getElementById('openBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

['dragenter', 'dragover'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); stage.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); stage.classList.remove('drag'); }));
stage.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

// ---- Sample point cloud (procedural — a little "building corner") --------
document.getElementById('sampleBtn').addEventListener('click', () => {
  const lines = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  // two walls + a floor, lightly noised, colored by height
  for (let i = 0; i < 9000; i++) {
    let x, y, z;
    const k = Math.random();
    if (k < 0.4) { x = rnd(0, 8); y = rnd(0, 4); z = rnd(-0.05, 0.05); }       // wall A
    else if (k < 0.8) { x = rnd(-0.05, 0.05); y = rnd(0, 4); z = rnd(0, 6); }   // wall B
    else { x = rnd(0, 8); y = rnd(-0.05, 0.05); z = rnd(0, 6); }                // floor
    const t = y / 4;
    lines.push([x.toFixed(3), y.toFixed(3), z.toFixed(3),
      Math.round(60 + 150 * t), Math.round(120 + 80 * t), Math.round(180 - 60 * t)].join(' '));
  }
  loadPointText(lines.join('\n'), 'xyz', 'sample scan');
});

// Deep link context (title from a resource page).
try {
  const t = new URLSearchParams(location.search).get('title');
  if (t) document.getElementById('subtitle').insertAdjacentHTML('beforeend',
    '<br><span class="text-muted">Context: <strong>' + t.replace(/[<>&]/g, '') + '</strong> — load its point cloud / IFC asset below.</span>');
} catch (e) {}

setStatus('Ready. Open a file or load the sample point cloud.');
