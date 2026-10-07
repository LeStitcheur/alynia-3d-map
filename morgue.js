// Procedural reconstruction of the morgue (room "R20morgue" of the v_oceanml2 MLO).
// The FiveM resource declares the room but ships no geometry for it: the space is bounded by
// the existing hospital shell (north, with a door) and the garage wall (east); west/south walls,
// floor, ceiling and furniture are rebuilt here. Coordinates are scene space (Y-up, metres).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Floor outline following the existing walls (x, z).
const OUTLINE = [
  [-14.6, 27.6], [-13.0, 26.0], [-10.0, 26.0], [-7.8, 27.8], [-4.4, 30.7],
  [0.0, 34.7], [3.8, 38.0], [-4.1, 47.6], [-14.6, 47.6],
];
const WEST_X = -14.6, SOUTH_Z = 47.6, WALL_T = 0.25;

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

const tiles = (base, grout, n) => (g, w, h) => {
  g.fillStyle = grout; g.fillRect(0, 0, w, h);
  const s = w / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    g.fillStyle = base; g.globalAlpha = 0.92 + ((i * 7 + j * 3) % 5) * 0.02;
    g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4);
  }
  g.globalAlpha = 1;
};

function materials() {
  const wallTex = canvasTexture(256, 256, tiles('#eef2f3', '#c3cbcf', 4));
  const floorTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#9fb0b6'; g.fillRect(0, 0, w, h);
    for (let k = 0; k < 900; k++) {
      g.fillStyle = k % 2 ? 'rgba(255,255,255,0.18)' : 'rgba(40,60,70,0.15)';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    g.strokeStyle = 'rgba(60,80,90,0.35)'; g.lineWidth = 2; g.strokeRect(0, 0, w, h);
  });
  const ceilTex = canvasTexture(128, 128, tiles('#f4f6f6', '#d4d9db', 2));
  const doorsTex = canvasTexture(1024, 384, (g, w, h) => {
    // 8 x 3 refrigerated body compartments
    g.fillStyle = '#9aa3a8'; g.fillRect(0, 0, w, h);
    const cols = 8, rows = 3, cw = w / cols, rh = h / rows;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const x = i * cw + 6, y = j * rh + 6, dw = cw - 12, dh = rh - 12;
      const grd = g.createLinearGradient(x, y, x + dw, y + dh);
      grd.addColorStop(0, '#dde2e5'); grd.addColorStop(1, '#b4bcc1');
      g.fillStyle = grd; g.fillRect(x, y, dw, dh);
      g.strokeStyle = '#7d868b'; g.lineWidth = 4; g.strokeRect(x, y, dw, dh);
      g.fillStyle = '#5d666b'; g.fillRect(x + dw - 26, y + dh / 2 - 22, 10, 44);          // handle
      g.fillStyle = '#ffffff'; g.fillRect(x + 12, y + 12, 40, 18);                         // label holder
      g.fillStyle = '#4a5358'; g.font = 'bold 13px sans-serif';
      g.fillText(String(j * cols + i + 1).padStart(2, '0'), x + 22, y + 26);
    }
  });
  return {
    wall: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.35 }),
    floor: new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.55 }),
    ceiling: new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.9, side: THREE.DoubleSide }),
    steel: new THREE.MeshStandardMaterial({ color: 0xc9d0d4, metalness: 0.75, roughness: 0.3 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: 0x6e777c, metalness: 0.7, roughness: 0.4 }),
    doors: new THREE.MeshStandardMaterial({ map: doorsTex, metalness: 0.55, roughness: 0.35 }),
    light: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4fbff, emissiveIntensity: 1.2 }),
    sheet: new THREE.MeshStandardMaterial({ color: 0xdfe9ee, roughness: 0.95 }),
  };
}

// Box with world-sized UVs so tiled textures keep a constant scale (1 repeat = `unit` metres).
function box(w, h, d, mat, unit = 1.2) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv, n = g.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    const su = ax > 0.5 ? d : w, sv = ay > 0.5 ? d : h;
    uv.setXY(i, (uv.getX(i) * su) / unit, (uv.getY(i) * sv) / unit);
  }
  return new THREE.Mesh(g, mat);
}

// Horizontal polygon (floor / ceiling) from the outline, UVs in metres / unit.
function slab(mat, y, unit) {
  const s = new THREE.Shape();
  OUTLINE.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z)));
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);                 // (x, -z) in XY -> (x, 0, z)
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / unit, pos.getZ(i) / unit);
  const m = new THREE.Mesh(g, mat);
  m.position.y = y;
  return m;
}

function isInside(x, z) {
  let inside = false;
  for (let i = 0, j = OUTLINE.length - 1; i < OUTLINE.length; j = i++) {
    const [xi, zi] = OUTLINE[i], [xj, zj] = OUTLINE[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function buildMorgue(room) {
  const M = materials();
  const group = new THREE.Group();
  group.name = 'tile|interior|L0';
  const floorY = room.box.min.y, ceilY = room.box.max.y, H = ceilY - floorY;
  const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); group.add(mesh); return mesh; };

  // shell: floor, ceiling, the two missing walls
  group.add(slab(M.floor, floorY + 0.01, 1.6));
  group.add(slab(M.ceiling, ceilY - 0.01, 1.2));
  const westLen = SOUTH_Z - OUTLINE[0][1] + WALL_T;
  add(box(WALL_T, H, westLen, M.wall), WEST_X - WALL_T / 2, floorY + H / 2, OUTLINE[0][1] + westLen / 2 - WALL_T / 2);
  const southLen = -4.1 - WEST_X + 0.6;
  add(box(southLen, H, WALL_T, M.wall), WEST_X + southLen / 2, floorY + H / 2, SOUTH_Z + WALL_T / 2);

  // cold chamber: 24 compartments against the west wall (front face = +x, plain 0..1 UVs)
  const ccDepth = 1.1, ccLen = 9, ccH = 2.25;
  const cc = new THREE.Mesh(new THREE.BoxGeometry(ccDepth, ccH, ccLen), [M.doors, M.steel, M.steel, M.steel, M.steel, M.steel]);
  add(cc, WEST_X + ccDepth / 2, floorY + ccH / 2, 36.0);
  add(box(ccDepth + 0.05, 0.12, ccLen + 0.05, M.darkSteel), WEST_X + ccDepth / 2, floorY + ccH + 0.06, 36.0);

  // autopsy tables with surgical lights
  for (const z of [34.5, 40.0]) {
    const x = -8.2;
    add(box(0.85, 0.06, 2.3, M.steel), x, floorY + 0.9, z);
    add(box(0.85, 0.06, 0.04, M.steel), x, floorY + 0.95, z - 1.13);
    add(box(0.85, 0.06, 0.04, M.steel), x, floorY + 0.95, z + 1.13);
    add(box(0.04, 0.06, 2.3, M.steel), x - 0.41, floorY + 0.95, z);
    add(box(0.04, 0.06, 2.3, M.steel), x + 0.41, floorY + 0.95, z);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.86, 20), M.steel), x, floorY + 0.43, z);
    add(box(0.7, 0.05, 0.9, M.darkSteel), x, floorY + 0.025, z);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.42, 0.08, 28), M.light), x, ceilY - 0.55, z);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), M.darkSteel), x, ceilY - 0.27, z);
  }

  // sink counter + wall cabinet along the south wall
  const sinkX = -11.6;
  add(box(4.2, 0.86, 0.62, M.steel), sinkX, floorY + 0.43, SOUTH_Z - 0.31);
  add(box(4.24, 0.04, 0.66, M.steel), sinkX, floorY + 0.88, SOUTH_Z - 0.33);
  for (const dx of [-1.1, 1.1]) {
    add(box(0.7, 0.02, 0.42, M.darkSteel), sinkX + dx, floorY + 0.905, SOUTH_Z - 0.35);
    add(box(0.04, 0.35, 0.04, M.darkSteel), sinkX + dx, floorY + 1.08, SOUTH_Z - 0.08);
  }
  add(box(4.2, 0.7, 0.35, M.steel), sinkX, floorY + 1.9, SOUTH_Z - 0.18);

  // stretcher with a sheet
  const sx = -4.8, sz = 40.5;
  add(box(0.62, 0.05, 1.95, M.steel), sx, floorY + 0.82, sz);
  add(box(0.6, 0.08, 1.85, M.sheet), sx, floorY + 0.89, sz);
  for (const [dx, dz] of [[-0.27, -0.9], [0.27, -0.9], [-0.27, 0.9], [0.27, 0.9]]) {
    add(box(0.035, 0.8, 0.035, M.darkSteel), sx + dx, floorY + 0.42, sz + dz);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12).rotateZ(Math.PI / 2), M.darkSteel), sx + dx, floorY + 0.04, sz + dz);
  }

  // ceiling light panels
  for (let x = -12.5; x <= -1; x += 3.2) for (let z = 29.5; z <= 46.5; z += 3.2) {
    if (isInside(x, z) && isInside(x - 0.5, z - 0.8) && isInside(x + 0.5, z + 0.8)) add(box(0.6, 0.03, 1.2, M.light), x, ceilY - 0.03, z);
  }

  return mergeByMaterial(group);
}

// Bake the many small parts into one mesh per material (one draw call each).
function mergeByMaterial(group) {
  const byMat = new Map();
  const out = new THREE.Group();
  out.name = group.name;
  group.updateMatrixWorld(true);
  for (const m of [...group.children]) {
    if (Array.isArray(m.material)) { out.add(m); continue; } // multi-material (cold chamber)
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(g);
  }
  for (const [mat, geoms] of byMat) out.add(new THREE.Mesh(mergeGeometries(geoms), mat));
  return out;
}
