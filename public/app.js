import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Floor elevations (metres, relative to the MLO origin). `cut` is the height of the
// section plane used in "maquette" mode: it removes ceilings so the floor reads as a plan.
const LEVELS = [
  { id: 'ss',  name: 'Sous-sol',          short: '-1', floor: -6.5, cut: -3.7 },
  { id: 'rdc', name: 'Rez-de-chaussée',   short: '0',  floor: 2.1,  cut: 4.6 },
  { id: 'e1',  name: '1er étage',         short: '1',  floor: 6.4,  cut: 8.9 },
  { id: 'e2',  name: '2e étage',          short: '2',  floor: 10.8, cut: 13.3 },
  { id: 'e8',  name: 'Étage supérieur',   short: '+', floor: 36.6, cut: 39.2 },
];

// Friendly names for the MLO room identifiers.
const ROOM_NAMES = {
  R1accueil: 'Accueil', R2urgence: 'Urgences', R3rampe: 'Rampe d’accès', R4couloirbas: 'Couloir principal',
  R5pharmacie: 'Pharmacie', R6veterinaire: 'Vétérinaire', R7labo: 'Laboratoire', R8vestieres: 'Vestiaires',
  R9couloirplus1: 'Couloir du 1er', R10reeducation: 'Rééducation', R11petitsallehaut: 'Petite salle',
  R12operatoirehaut: 'Bloc opératoire', R13sallecomunelit1: 'Chambre commune', R14salleindivudual: 'Chambre individuelle',
  R15assenceur: 'Ascenseur', R16couloirchambreplus2: 'Couloir des chambres', R17chambreplus2: 'Chambres',
  R18passerelleplus2: 'Passerelle', R19couloirreunionplus2: 'Couloir réunion', R20sallereunion: 'Salle de réunion',
  R18couloir: 'Couloir', R19chiurgie: 'Chirurgie', R20morgue: 'Morgue', R21laverie: 'Laverie', assenseur: 'Ascenseur',
  R1passerelle: 'Passerelle', R2gauchecouloir: 'Couloir gauche', R3sallecouloir: 'Salle du couloir',
  R4partiedroite: 'Aile droite', R5assenceur: 'Ascenseur', MxRoomgarage1: 'Garage ambulances', escalier1: 'Escalier',
};

const EYE = 1.65, RADIUS = 0.3, STEP = 0.55, GRAVITY = 18;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const setStatus = (t) => { $('#status').textContent = t; };

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const container = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c8);
scene.fog = new THREE.Fog(0x9fb4c8, 250, 900);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8a99, 1.6));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
sun.position.set(60, 120, 40);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 3000);
camera.position.set(110, 90, 120);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.minDistance = 2;
orbit.maxDistance = 600;
orbit.target.set(0, 5, 0);

const fps = new PointerLockControls(camera, renderer.domElement);

const sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e5);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  mode: 'orbit',
  level: null,          // LEVELS entry or null = whole building
  room: null,
  labels: true,
  fly: false,
  bvhReady: false,
};
const groups = {};        // exterior / interior / doors
let colliders = [];       // meshes used for walk-mode collisions
let rooms = [];           // flattened room list
let bounds = new THREE.Box3();

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

async function load() {
  const roomsData = await fetch('model/rooms.json').then((r) => r.json());
  const gltf = await loader.loadAsync('model/hospital.glb', (e) => {
    const total = e.total || 55e6;
    const p = Math.min(1, e.loaded / total);
    $('#loader-bar').style.width = `${(p * 100).toFixed(0)}%`;
    $('#loader-text').textContent = `Chargement du modèle… ${(e.loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} Mo`;
  });
  $('#loader-text').textContent = 'Préparation de la scène…';
  await new Promise((r) => setTimeout(r, 30));

  const root = gltf.scene;
  root.traverse((o) => {
    if (o.name && ['exterior', 'interior', 'doors'].includes(o.name) && !groups[o.name]) groups[o.name] = o;
    if (!o.isMesh) return;
    const m = o.material;
    if (m.transparent || m.alphaMode === 'BLEND') { m.depthWrite = false; o.renderOrder = 2; }
    if (m.emissiveMap) m.emissiveIntensity = 0.7;
    m.side = THREE.DoubleSide;
    o.matrixAutoUpdate = false;
  });
  root.updateMatrixWorld(true);
  scene.add(root);
  bounds.setFromObject(root);

  for (const g of ['exterior', 'interior']) groups[g]?.traverse((o) => { if (o.isMesh) colliders.push(o); });

  buildRooms(roomsData);
  buildLevelsUI();
  buildRoomList();
  buildLabels();
  buildMinimap();
  setLevel(null, false);

  $('#loader').classList.add('done');
  setStatus(`${rooms.length} salles · ${countTris(root).toLocaleString('fr-FR')} triangles`);
  buildBVH();
}

function countTris(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return Math.round(n);
}

// Building the BVH for 3M+ triangles takes a moment: do it mesh by mesh without blocking the UI.
async function buildBVH() {
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  let done = 0;
  for (const m of meshes) {
    m.geometry.computeBoundsTree();
    done++;
    if (done % 4 === 0) {
      setStatus(`Préparation des collisions… ${Math.round((done / meshes.length) * 100)} %`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  state.bvhReady = true;
  setStatus(`${rooms.length} salles · ${countTris(scene).toLocaleString('fr-FR')} triangles · prêt`);
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
function prettify(id) {
  return ROOM_NAMES[id] || id.replace(/^R\d+/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function buildRooms(data) {
  let stair = 0;
  for (const mlo of data.mlos) {
    for (const r of mlo.rooms) {
      if (r.name === 'limbo') continue;
      // rooms.json is Z-up (GTA); the scene is Y-up: (x, y, z) -> (x, z, -y)
      const box = new THREE.Box3(
        new THREE.Vector3(r.min[0], r.min[2], -r.max[1]),
        new THREE.Vector3(r.max[0], r.max[2], -r.min[1]),
      );
      const size = box.getSize(new THREE.Vector3());
      const circulation = size.y > 10 || /escalier|assen|rampe/i.test(r.name);
      let level = null;
      if (!circulation || (/assen/i.test(r.name) && size.y < 10)) {
        let best = Infinity;
        for (const L of LEVELS) { const d = Math.abs(box.min.y - L.floor); if (d < best && d < 1.6) { best = d; level = L; } }
      }
      let name = prettify(r.name);
      if (r.name === 'escalier1') name = `Escalier ${++stair}`;
      rooms.push({ id: `${mlo.name}/${r.name}`, key: r.name, name, box, size, level, circulation, mlo: mlo.name });
    }
  }
  rooms.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

const roomsOfLevel = (L) => rooms.filter((r) => (L ? r.level === L : true));

function roomAt(point) {
  let best = null, bestVol = Infinity;
  for (const r of rooms) {
    if (!r.box.containsPoint(point)) continue;
    const vol = r.size.x * r.size.y * r.size.z * (r.circulation ? 50 : 1); // prefer real rooms over stair wells
    if (vol < bestVol) { bestVol = vol; best = r; }
  }
  return best;
}

function levelAtHeight(y) {
  let best = LEVELS[0];
  for (const L of LEVELS) if (y >= L.floor - 0.8) best = L;
  return best;
}

// ---------------------------------------------------------------------------
// UI: levels / rooms list / labels
// ---------------------------------------------------------------------------
function buildLevelsUI() {
  const wrap = $('#levels');
  const mk = (L, label, count) => {
    const b = el('button');
    b.append(el('span', null, label), el('span', 'count', count));
    b.onclick = () => setLevel(L);
    b.dataset.level = L ? L.id : 'all';
    wrap.append(b);
  };
  mk(null, 'Tout le bâtiment', 'vue 3D');
  for (const L of [...LEVELS].reverse()) mk(L, L.name, `${roomsOfLevel(L).length} salles`);
}

function buildRoomList() {
  const ul = $('#rooms');
  const q = $('#search').value.trim().toLowerCase();
  ul.innerHTML = '';
  const groupsList = [...LEVELS].reverse().map((L) => ({ title: L.name, items: rooms.filter((r) => r.level === L) }));
  groupsList.push({ title: 'Circulations', items: rooms.filter((r) => !r.level) });
  for (const g of groupsList) {
    let items = g.items.filter((r) => !q || r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q));
    if (state.level && !q) items = items.filter((r) => r.level === state.level || !r.level);
    if (!items.length) continue;
    ul.append(el('li', 'group', g.title));
    for (const r of items) {
      const li = el('li', 'room');
      li.append(el('span', null, r.name), el('small', null, `${(r.size.x * r.size.z).toFixed(0)} m²`));
      li.dataset.id = r.id;
      if (state.room === r) li.classList.add('active');
      li.onclick = () => selectRoom(r, true);
      ul.append(li);
    }
  }
}

function buildLabels() {
  for (const r of rooms) {
    const div = el('div', 'room-label', r.name);
    div.onclick = (e) => { e.stopPropagation(); selectRoom(r, true); };
    const obj = new CSS2DObject(div);
    const c = r.box.getCenter(new THREE.Vector3());
    obj.position.set(c.x, (r.level ? r.level.floor : r.box.min.y) + 1.2, c.z);
    obj.userData.room = r;
    r.label = obj;
    scene.add(obj);
  }
}

function updateLabels() {
  for (const r of rooms) {
    const show = state.labels && state.mode === 'orbit' && state.level && r.level === state.level;
    r.label.visible = !!show;
    r.label.element.classList.toggle('active', state.room === r);
  }
}

// ---------------------------------------------------------------------------
// Minimap (SVG floor plan of the current level)
// ---------------------------------------------------------------------------
let mm = null;
function buildMinimap() {
  const svg = $('#minimap-svg');
  const all = new THREE.Box3();
  for (const r of rooms) if (!r.circulation || r.level) all.union(r.box);
  const pad = 6;
  const w = all.max.x - all.min.x + pad * 2, h = all.max.z - all.min.z + pad * 2;
  const s = Math.max(w, h);
  svg.setAttribute('viewBox', `${all.min.x - pad - (s - w) / 2} ${all.min.z - pad - (s - h) / 2} ${s} ${s}`);
  const gRooms = svgEl('g', {});
  const cone = svgEl('path', { class: 'cone' });
  const me = svgEl('circle', { class: 'me', r: 1.6 });
  svg.append(gRooms, cone, me);
  mm = { svg, gRooms, cone, me, level: undefined };
}

function drawMinimap(L) {
  if (!mm || mm.level === L) return;
  mm.level = L;
  mm.gRooms.innerHTML = '';
  const list = L ? rooms.filter((r) => r.level === L || (r.circulation && r.box.min.y <= L.floor + 1 && r.box.max.y >= L.floor + 1)) : rooms.filter((r) => r.level);
  list.sort((a, b) => b.size.x * b.size.z - a.size.x * a.size.z); // big rooms first so small ones stay clickable
  for (const r of list) {
    const rect = svgEl('rect', {
      x: r.box.min.x, y: r.box.min.z, width: r.size.x, height: r.size.z, rx: 0.6,
      class: `room${r.circulation ? ' circ' : ''}${state.room === r ? ' active' : ''}`,
    });
    rect.dataset.id = r.id;
    rect.append(svgEl('title', {}));
    rect.firstChild.textContent = r.name;
    rect.onclick = () => selectRoom(r, true);
    mm.gRooms.append(rect);
  }
  for (const r of list) {
    if (r.circulation) continue;
    const c = r.box.getCenter(new THREE.Vector3());
    const t = svgEl('text', { x: c.x, y: c.z });
    t.textContent = r.name;
    mm.gRooms.append(t);
  }
  $('#minimap-title').textContent = L ? L.name : 'Plan général';
}

function updateMinimap() {
  if (!mm) return;
  const p = state.mode === 'walk' ? camera.position : orbit.target;
  const L = state.mode === 'walk' ? levelAtHeight(camera.position.y - EYE) : state.level;
  drawMinimap(L);
  mm.me.setAttribute('cx', p.x);
  mm.me.setAttribute('cy', p.z);
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const a = Math.atan2(dir.z, dir.x), len = 9, spread = 0.55;
  mm.cone.setAttribute('d', `M${p.x},${p.z} L${p.x + Math.cos(a - spread) * len},${p.z + Math.sin(a - spread) * len} A${len},${len} 0 0 1 ${p.x + Math.cos(a + spread) * len},${p.z + Math.sin(a + spread) * len} Z`);
  for (const rect of mm.gRooms.querySelectorAll('rect')) rect.classList.toggle('active', state.room?.id === rect.dataset.id);
}

// ---------------------------------------------------------------------------
// Level / room selection
// ---------------------------------------------------------------------------
function setLevel(L, animate = true) {
  state.level = L;
  for (const b of document.querySelectorAll('#levels button')) b.classList.toggle('active', b.dataset.level === (L ? L.id : 'all'));
  applySection();
  buildRoomList();
  updateLabels();
  if (state.mode === 'orbit' && animate) {
    if (L) {
      const box = new THREE.Box3();
      for (const r of roomsOfLevel(L)) box.union(r.box);
      const c = box.getCenter(new THREE.Vector3()); c.y = L.floor;
      const size = box.getSize(new THREE.Vector3());
      const dist = Math.max(size.x, size.z) * 0.95 + 10;
      flyTo(c, dist, 1.0);
    } else {
      flyTo(new THREE.Vector3(0, 8, -10), 150, 0.95);
    }
  } else if (state.mode === 'walk' && L) {
    // jump to the level: reuse the first room of this level as spawn point
    const r = roomsOfLevel(L).sort((a, b) => b.size.x * b.size.z - a.size.x * a.size.z)[0];
    if (r) teleportTo(r);
  }
}

function applySection() {
  const clip = state.mode === 'orbit' && state.level;
  sectionPlane.constant = clip ? state.level.cut : 1e5;
  renderer.clippingPlanes = clip ? [sectionPlane] : [];
}

function selectRoom(r, focus) {
  state.room = r;
  for (const li of document.querySelectorAll('#rooms li.room')) li.classList.toggle('active', li.dataset.id === r?.id);
  updateLabels();
  const card = $('#room-card');
  if (!r) { card.hidden = true; return; }
  card.hidden = false;
  $('#rc-name').textContent = r.name;
  $('#rc-level').textContent = r.level ? r.level.name : 'Circulation verticale';
  $('#rc-dims').textContent = `${r.size.x.toFixed(1)} × ${r.size.z.toFixed(1)} × ${r.size.y.toFixed(1)} m`;
  $('#rc-area').textContent = `${(r.size.x * r.size.z).toFixed(0)} m²`;
  if (!focus) return;
  if (state.mode === 'walk') { teleportTo(r); return; }
  if (r.level && r.level !== state.level) setLevel(r.level, false);
  const c = r.box.getCenter(new THREE.Vector3());
  c.y = r.level ? r.level.floor + 0.5 : c.y;
  flyTo(c, Math.max(r.size.x, r.size.z) * 1.3 + 8, 0.9);
}

// Smooth camera move in orbit mode: keep the current heading, look down at ~55°.
let tween = null;
function flyTo(target, distance, polar = 0.95) {
  const az = Math.atan2(camera.position.x - orbit.target.x, camera.position.z - orbit.target.z);
  const end = new THREE.Vector3(
    target.x + Math.sin(az) * Math.sin(polar) * distance,
    target.y + Math.cos(polar) * distance,
    target.z + Math.cos(az) * Math.sin(polar) * distance,
  );
  tween = { t: 0, dur: 0.9, p0: camera.position.clone(), p1: end, t0: orbit.target.clone(), t1: target.clone() };
}

function stepTween(dt) {
  if (!tween) return;
  tween.t = Math.min(1, tween.t + dt / tween.dur);
  const k = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
  camera.position.lerpVectors(tween.p0, tween.p1, k);
  orbit.target.lerpVectors(tween.t0, tween.t1, k);
  if (tween.t >= 1) tween = null;
}

// ---------------------------------------------------------------------------
// Picking (hover + click on the 3D model in orbit mode)
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const pointer = new THREE.Vector2();
let lastPick = 0, downPos = null;

function pick(clientX, clientY) {
  if (!state.bvhReady) return null;
  pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  raycaster.far = Infinity;
  raycaster.firstHitOnly = false;
  const hits = raycaster.intersectObjects(colliders, false);
  raycaster.firstHitOnly = true;
  const limit = renderer.clippingPlanes.length ? sectionPlane.constant : Infinity;
  const hit = hits.find((h) => h.point.y <= limit + 0.01 && isVisible(h.object));
  if (!hit) return null;
  // nudge the point slightly into the room (hits are usually on floors/walls)
  const p = hit.point.clone();
  p.y += 0.3;
  return roomAt(p);
}

function isVisible(o) {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (state.mode !== 'orbit' || e.buttons) { $('#tooltip').hidden = true; return; }
  const now = performance.now();
  if (now - lastPick < 60) return;
  lastPick = now;
  const r = pick(e.clientX, e.clientY);
  const tip = $('#tooltip');
  if (r) {
    tip.hidden = false; tip.textContent = r.name;
    tip.style.left = `${e.clientX}px`; tip.style.top = `${e.clientY}px`;
    renderer.domElement.style.cursor = 'pointer';
  } else { tip.hidden = true; renderer.domElement.style.cursor = ''; }
});
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (state.mode !== 'orbit' || !downPos) return;
  if (Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 5) return; // it was a drag
  const r = pick(e.clientX, e.clientY);
  if (r) selectRoom(r, true);
});

// ---------------------------------------------------------------------------
// Walk mode
// ---------------------------------------------------------------------------
const keys = new Set();
const player = { feet: new THREE.Vector3(), velY: 0, onGround: false };
const touchMove = new THREE.Vector2();

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  for (const b of document.querySelectorAll('#mode-seg button')) b.classList.toggle('active', b.dataset.mode === mode);
  for (const d of document.querySelectorAll('#help [data-for]')) d.hidden = d.dataset.for !== mode;
  $('#crosshair').hidden = mode !== 'walk';
  $('#touch-pad').hidden = !(mode === 'walk' && matchMedia('(pointer: coarse)').matches);
  $('#tooltip').hidden = true;
  orbit.enabled = mode === 'orbit';
  tween = null;
  if (mode === 'walk') {
    scene.fog.near = 60; scene.fog.far = 400;
    const r = state.room || rooms.find((x) => x.key === 'R1accueil') || rooms[0];
    teleportTo(r);
  } else {
    fps.unlock();
    scene.fog.near = 250; scene.fog.far = 900;
    const c = camera.position.clone();
    const dir = camera.getWorldDirection(new THREE.Vector3());
    orbit.target.copy(c).addScaledVector(dir, 10);
    setLevel(levelAtHeight(c.y - EYE), false);
    flyTo(orbit.target.clone(), 45, 0.95);
  }
  applySection();
  updateLabels();
}

function castFirst(origin, dir, far) {
  raycaster.set(origin, dir);
  raycaster.far = far;
  return raycaster.intersectObjects(colliders, false)[0] || null;
}

// Find a free standing spot near the room centre and the most open viewing direction.
function findSpawn(r) {
  const c = r.box.getCenter(new THREE.Vector3());
  const floor = r.level ? r.level.floor : r.box.min.y;
  const fallback = { pos: new THREE.Vector3(c.x, floor + 0.05, c.z), yaw: 0 };
  if (!state.bvhReady) return fallback;
  const dirs = Array.from({ length: 12 }, (_, i) => new THREE.Vector3(Math.cos((i / 12) * Math.PI * 2), 0, Math.sin((i / 12) * Math.PI * 2)));
  const candidates = [];
  const step = 1.2, n = 6;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const x = c.x + i * step, z = c.z + j * step;
    if (x < r.box.min.x + 0.5 || x > r.box.max.x - 0.5 || z < r.box.min.z + 0.5 || z > r.box.max.z - 0.5) continue;
    candidates.push(new THREE.Vector3(x, 0, z));
  }
  candidates.sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
  for (const p of candidates.slice(0, 60)) {
    const g = castFirst(_p.set(p.x, floor + 1.6, p.z), _down, 2.4);
    if (!g || g.point.y > floor + 1.0) continue;               // no floor, or standing on furniture
    const head = _p.set(p.x, g.point.y + 0.15, p.z);
    if (castFirst(head, new THREE.Vector3(0, 1, 0), 1.9)) continue; // something above our head
    let minD = Infinity, bestD = -1, bestDir = null;
    for (const d of dirs) {
      let dist = 12;
      for (const hgt of [0.6, 1.5]) {
        const h = castFirst(new THREE.Vector3(p.x, g.point.y + hgt, p.z), d, 12);
        if (h) dist = Math.min(dist, h.distance);
      }
      minD = Math.min(minD, dist);
      if (dist > bestD) { bestD = dist; bestDir = d; }
    }
    if (minD < 0.6) continue;
    return { pos: new THREE.Vector3(p.x, g.point.y, p.z), yaw: Math.atan2(-bestDir.x, -bestDir.z) };
  }
  return fallback;
}

function teleportTo(r) {
  const spawn = findSpawn(r);
  player.feet.copy(spawn.pos);
  player.velY = 0;
  camera.position.copy(player.feet).add(new THREE.Vector3(0, EYE, 0));
  if (state.mode === 'walk') {
    camera.quaternion.setFromEuler(new THREE.Euler(-0.05, spawn.yaw, 0, 'YXZ'));
    selectRoom(r, false);
  }
}

renderer.domElement.addEventListener('click', () => {
  if (state.mode === 'walk' && !matchMedia('(pointer: coarse)').matches) fps.lock();
});

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
  keys.add(e.code);
  if (e.code === 'KeyE' && state.mode === 'orbit') toggleOpt('#opt-exterior');
  if (e.code === 'KeyL') toggleOpt('#opt-labels');
  if (e.code === 'KeyF') toggleOpt('#opt-fly');
  if (e.code === 'KeyV') setMode(state.mode === 'walk' ? 'orbit' : 'walk');
  if (state.mode === 'orbit' && /^Digit[0-5]$/.test(e.code)) {
    const n = +e.code.slice(5);
    setLevel(n === 0 ? null : LEVELS[n - 1]);
  }
  if (e.code === 'Space' && state.mode === 'walk') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function toggleOpt(sel) { const c = $(sel); c.checked = !c.checked; c.dispatchEvent(new Event('change')); }

const _v = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _down = new THREE.Vector3(0, -1, 0), _p = new THREE.Vector3();

function walk(dt) {
  dt = Math.min(dt, 0.05);
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + touchMove.y;
  const s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + touchMove.x;
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');

  camera.getWorldDirection(_fwd);
  if (state.fly) {
    _right.crossVectors(_fwd, camera.up).normalize();
    const speed = run ? 22 : 8;
    _v.set(0, 0, 0).addScaledVector(_fwd, f).addScaledVector(_right, s);
    if (keys.has('Space')) _v.y += 1;
    if (keys.has('KeyC') || keys.has('ControlLeft')) _v.y -= 1;
    if (_v.lengthSq() > 0) camera.position.addScaledVector(_v.normalize(), speed * dt);
    player.feet.copy(camera.position).y -= EYE;
    player.velY = 0;
    trackRoom();
    return;
  }

  _fwd.y = 0; _fwd.normalize();
  _right.crossVectors(_fwd, camera.up).normalize();
  const speed = run ? 6 : 2.8;
  _v.set(0, 0, 0).addScaledVector(_fwd, f).addScaledVector(_right, s);
  if (_v.lengthSq() > 1) _v.normalize();
  _v.multiplyScalar(speed * dt);

  if (state.bvhReady && _v.lengthSq() > 0) {
    // horizontal collisions: probe at knee and chest height, slide along walls
    for (let iter = 0; iter < 3; iter++) {
      const len = _v.length();
      if (len < 1e-6) break;
      const dir = _v.clone().divideScalar(len);
      let blocked = null;
      for (const hgt of [STEP + 0.1, 1.2]) {
        raycaster.set(_p.set(player.feet.x, player.feet.y + hgt, player.feet.z), dir);
        raycaster.far = len + RADIUS;
        const h = raycaster.intersectObjects(colliders, false)[0];
        if (h && (!blocked || h.distance < blocked.distance)) blocked = h;
      }
      if (!blocked || !blocked.face) break;
      const n = blocked.face.normal.clone().transformDirection(blocked.object.matrixWorld);
      n.y = 0;
      if (n.lengthSq() < 1e-4) { _v.set(0, 0, 0); break; }
      n.normalize();
      if (n.dot(dir) > 0) n.negate();          // double-sided geometry: face the mover
      _v.addScaledVector(n, -_v.dot(n));       // keep only the tangential part (slide)
    }
  }
  player.feet.add(_v);

  // gravity + ground following (handles stairs/ramps up to STEP)
  player.velY -= GRAVITY * dt;
  let dy = player.velY * dt;
  if (state.bvhReady) {
    raycaster.set(_p.set(player.feet.x, player.feet.y + STEP, player.feet.z), _down);
    raycaster.far = STEP + Math.max(0.05, -dy) + 0.05;
    const g = raycaster.intersectObjects(colliders, false)[0];
    if (g) { player.feet.y = g.point.y; player.velY = 0; player.onGround = true; dy = 0; }
    else player.onGround = false;
  } else dy = 0;
  player.feet.y += dy;
  if (player.feet.y < bounds.min.y - 30) teleportTo(state.room || rooms[0]);

  camera.position.set(player.feet.x, player.feet.y + EYE, player.feet.z);
  trackRoom();
}

// keep the "current room" card in sync while walking
let lastTrack = 0;
function trackRoom() {
  const now = performance.now();
  if (now - lastTrack < 250) return;
  lastTrack = now;
  const r = roomAt(_p.set(player.feet.x, player.feet.y + 1, player.feet.z));
  if (r && r !== state.room) selectRoom(r, false);
}

// touch: joystick for movement, drag elsewhere to look
(function touchControls() {
  const pad = $('#touch-pad'), stick = $('#touch-stick');
  let padId = null, lookId = null, last = null;
  pad.addEventListener('pointerdown', (e) => { padId = e.pointerId; pad.setPointerCapture(e.pointerId); });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== padId) return;
    const r = pad.getBoundingClientRect();
    let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    touchMove.set(x, -y);
    stick.style.transform = `translate(${x * 36}px, ${y * 36}px)`;
  });
  const end = (e) => { if (e.pointerId === padId) { padId = null; touchMove.set(0, 0); stick.style.transform = ''; } };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'walk' || e.pointerType !== 'touch') return;
    lookId = e.pointerId; last = [e.clientX, e.clientY];
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    const dx = e.clientX - last[0], dy = e.clientY - last[1]; last = [e.clientX, e.clientY];
    const eul = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    eul.y -= dx * 0.005; eul.x = Math.max(-1.5, Math.min(1.5, eul.x - dy * 0.005));
    camera.quaternion.setFromEuler(eul);
  });
  renderer.domElement.addEventListener('pointerup', (e) => { if (e.pointerId === lookId) lookId = null; });
})();

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
for (const b of document.querySelectorAll('#mode-seg button')) b.onclick = () => setMode(b.dataset.mode);
$('#search').addEventListener('input', buildRoomList);
$('#opt-exterior').addEventListener('change', (e) => { if (groups.exterior) groups.exterior.visible = e.target.checked; });
$('#opt-doors').addEventListener('change', (e) => { if (groups.doors) groups.doors.visible = e.target.checked; });
$('#opt-labels').addEventListener('change', (e) => { state.labels = e.target.checked; updateLabels(); });
$('#opt-fly').addEventListener('change', (e) => { state.fly = e.target.checked; player.velY = 0; });
$('#room-card-close').onclick = () => selectRoom(null);
$('#rc-visit').onclick = () => { const r = state.room; setMode('walk'); if (r) teleportTo(r); };
$('#panel-toggle').onclick = () => $('#panel').classList.add('hidden');
$('#panel-open').onclick = () => $('#panel').classList.remove('hidden');
if (innerWidth < 640) $('#panel').classList.add('hidden');

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let mmTimer = 0;
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (state.mode === 'orbit') { stepTween(dt); orbit.update(); }
  else walk(dt);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  if ((mmTimer += dt) > 0.1) { mmTimer = 0; updateMinimap(); }
});

// handle for debugging from the browser console
window.viewer = { THREE, scene, camera, state, player, rooms, keys, walk, setMode, setLevel, selectRoom, teleportTo };

load().catch((err) => {
  console.error(err);
  $('#loader-text').textContent = `Erreur de chargement : ${err.message}. Le site doit être servi par un serveur HTTP (npm start).`;
});
