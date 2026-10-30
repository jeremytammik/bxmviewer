import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODELS = ['renov', 'warehouse', 'modelfile', 'model6282'];
const ASSETS = '../sample/';
const IMAGE_DIR = ASSETS + 'Images/';

const params = new URLSearchParams(location.search);
const modelName = params.get('model') ?? MODELS[0];
const stretchImages = params.has('stretch');

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xecebe5);
scene.add(new THREE.HemisphereLight(0xffffff, 0x888899, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-1, 2, 1);
scene.add(sun);

const perspective = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
let camera = perspective;
let orthoHalfHeight = 10;
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

// The plan view is orthographic so the 2D plan lines match the vertical projection of the 3D elements.
function useCamera(next) {
  if (next === camera) return;
  camera = next;
  controls.object = camera;
  resize();
}

const modelRoot = new THREE.Group();
const planGroup = new THREE.Group();
scene.add(modelRoot, planGroup);

const greyMaterial = new THREE.MeshBasicMaterial({ color: 0xbbbbbb, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide });
const highlightColour = new THREE.Color(0xffc400);
let selected = null;
let bounds = new THREE.Box3();

const select = document.getElementById('model');
for (const name of MODELS) select.add(new Option(name, name, false, name === modelName));
select.onchange = () => { params.set('model', select.value); location.search = params.toString(); };

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  const aspect = innerWidth / innerHeight;
  perspective.aspect = aspect;
  perspective.updateProjectionMatrix();
  Object.assign(orthographic, {
    left: -orthoHalfHeight * aspect, right: orthoHalfHeight * aspect, top: orthoHalfHeight, bottom: -orthoHalfHeight,
  });
  orthographic.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

function setStatus(text) { document.getElementById('status').textContent = text; }

async function loadModel() {
  setStatus(`Loading ${modelName}.glb ...`);
  const gltf = await new GLTFLoader().loadAsync(`${ASSETS}${modelName}.glb`);
  modelRoot.add(gltf.scene);
  gltf.scene.traverse(o => {
    if (o.isMesh) {
      // glTF defaults to fully metallic, which renders black without an environment map.
      if (o.material.metalness !== undefined) { o.material.metalness = 0; o.material.roughness = 0.8; }
      o.userData.material = o.material;
    }
  });
  bounds = new THREE.Box3().setFromObject(modelRoot);
  buildTypeList();
  setView('iso');
  setStatus(`${modelName}: ${countMeshes()} elements`);
}

function countMeshes() {
  let n = 0;
  modelRoot.traverse(o => { if (o.isMesh) n++; });
  return n;
}

async function loadPlanImages() {
  const list = document.getElementById('images');
  let sidecar;
  try {
    const response = await fetch(`${ASSETS}${modelName}.images.json`);
    if (!response.ok) throw new Error(response.statusText);
    sidecar = await response.json();
  } catch {
    return;
  }

  const loader = new THREE.TextureLoader();
  list.textContent = '';
  const missing = [];
  for (const image of sidecar.images) {
    let texture;
    try {
      texture = await loader.loadAsync(IMAGE_DIR + image.file);
    } catch {
      missing.push(image.name);
      continue;
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const { width: pixelsX, height: pixelsY } = texture.image;
    const height = stretchImages ? image.height : image.width * pixelsY / pixelsX;
    const material = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const geometry = new THREE.PlaneGeometry(image.width, height).translate(image.width / 2, height / 2, 0);
    const mesh = new THREE.Mesh(geometry, material);

    const [ax, , az] = image.xAxis;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeBasis(new THREE.Vector3(ax, 0, az), new THREE.Vector3(az, 0, -ax), new THREE.Vector3(0, 1, 0));
    mesh.matrix.setPosition(...image.origin);
    mesh.userData.scopeId = image.scopeId;
    planGroup.add(mesh);

    const label = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    box.onchange = () => { mesh.visible = box.checked; };
    label.append(box, ' ', image.name);
    list.append(label);
  }
  buildScopeList(sidecar.scopes ?? []);
  if (missing.length) setStatus(`Missing image files: ${missing.join(', ')}`);
}

function buildScopeList(scopes) {
  const used = new Set();
  modelRoot.traverse(o => { if (o.isMesh && o.userData.ScopeID) used.add(o.userData.ScopeID); });
  for (const mesh of planGroup.children) used.add(mesh.userData.scopeId);
  const list = document.getElementById('scopes');
  const byName = new Map();
  for (const scope of scopes.filter(s => used.has(s.id))) {
    if (!byName.has(scope.name)) byName.set(scope.name, []);
    byName.get(scope.name).push(scope.id);
  }
  if (!byName.size) return;
  list.textContent = '';
  for (const [name, ids] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    box.onchange = () => ids.forEach(id => setScopeVisible(id, box.checked));
    label.append(box, ' ', name);
    list.append(label);
  }
}

function setScopeVisible(scopeId, visible) {
  modelRoot.traverse(o => { if (o.isMesh && o.userData.ScopeID === scopeId) o.visible = visible; });
  for (const mesh of planGroup.children) if (mesh.userData.scopeId === scopeId) mesh.visible = visible;
}

document.getElementById('opacity').oninput = e => {
  for (const mesh of planGroup.children) mesh.material.opacity = Number(e.target.value);
};

function setView(kind) {
  const centre = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(perspective.fov / 2)) * 0.9;
  const direction = {
    plan: new THREE.Vector3(0, 1, 0.0001),
    iso: new THREE.Vector3(1, 1, 1).normalize(),
    front: new THREE.Vector3(0, 0, 1),
    side: new THREE.Vector3(1, 0, 0),
  }[kind];

  if (kind === 'plan') {
    const aspect = innerWidth / innerHeight;
    orthoHalfHeight = Math.max(size.z / 2, size.x / 2 / aspect, 1) * 1.1;
    useCamera(orthographic);
    resize();
  } else {
    useCamera(perspective);
  }
  camera.position.copy(centre).addScaledVector(direction, distance);
  camera.near = distance / 1000;
  camera.far = distance * 20;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();
}
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => setView(b.dataset.view); });

function pick(event) {
  const rect = canvas.getBoundingClientRect();
  const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(modelRoot, true).filter(h => isPickable(h.object));
  // Zones are large transparent volumes; prefer the solid element in front of or inside them.
  const solid = hits.find(h => !h.object.material.transparent && h.object.userData.ObjectType !== 'Zone');
  setSelected((solid ?? hits[0])?.object ?? null);
}

function isPickable(mesh) {
  for (let o = mesh; o; o = o.parent) if (!o.visible) return false;
  return true;
}

// The depth bias keeps the selection stable where another element occupies the same space (e.g. a demolition wall over an existing wall).
const highlightMaterial = new THREE.MeshBasicMaterial({
  color: 0xff9900, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
});
let outline = null;

function setSelected(mesh) {
  selected = mesh;
  outline?.removeFromParent();
  outline?.geometry.dispose();
  outline = null;
  if (mesh) {
    outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 20), new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false }));
    outline.renderOrder = 10;
    outline.raycast = () => {};
    mesh.add(outline);
  }
  const isolate = document.getElementById('isolate').checked;
  modelRoot.traverse(o => {
    if (!o.isMesh) return;
    o.material = o === selected ? highlightMaterial : !selected || !isolate ? o.userData.material : greyMaterial;
  });
  showProperties(mesh);
}

const KEY_PROPERTIES = ['Name', 'ObjectType', 'Level', 'Length', 'Width', 'Height', 'Thickness', 'Area', 'AreaGross', 'Volume', 'VolumeGross', 'Perimeter', 'Weight', 'FamilyName', 'ItemMasterCode', 'ID', 'ScopeID'];

function showProperties(mesh) {
  const info = document.getElementById('info');
  info.textContent = '';
  if (!mesh) { info.textContent = 'Click an element to select it.'; return; }

  const properties = mesh.userData.Properties ?? {};
  const title = document.createElement('strong');
  title.textContent = `${mesh.name} (${mesh.userData.ObjectType ?? 'element'})`;
  info.append(title);

  const table = document.createElement('table');
  const addRow = (key, value) => {
    const row = table.insertRow();
    row.insertCell().textContent = key;
    row.insertCell().textContent = value;
  };
  const shown = new Set();
  for (const key of KEY_PROPERTIES) if (properties[key] !== undefined) { addRow(key, properties[key]); shown.add(key); }
  for (const [key, value] of Object.entries(mesh.userData.Custom ?? {})) addRow(key, value);
  const rest = Object.keys(properties).filter(k => !shown.has(k)).sort();
  const details = document.createElement('details');
  details.innerHTML = '<summary>All attributes</summary>';
  const more = document.createElement('table');
  for (const key of rest) {
    const row = more.insertRow();
    row.insertCell().textContent = key;
    row.insertCell().textContent = properties[key];
  }
  details.append(more);
  info.append(table, details);
}

function buildTypeList() {
  const counts = new Map();
  modelRoot.traverse(o => { if (o.isMesh) counts.set(o.userData.ObjectType, (counts.get(o.userData.ObjectType) ?? 0) + 1); });
  const list = document.getElementById('types');
  list.textContent = '';
  for (const [type, count] of [...counts].sort()) {
    const label = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    box.onchange = () => modelRoot.traverse(o => { if (o.isMesh && o.userData.ObjectType === type) o.visible = box.checked; });
    label.append(box, ` ${type} (${count})`);
    list.append(label);
  }
}

document.getElementById('isolate').onchange = () => setSelected(selected);

const menu = document.getElementById('menu');
const hideMenu = () => { menu.style.display = 'none'; };
function menuItem(text, action, cls) {
  const item = document.createElement('div');
  item.textContent = text;
  if (cls) item.className = cls; else item.onclick = () => { hideMenu(); action(); };
  menu.append(item);
}
function hideType(type) {
  modelRoot.traverse(o => { if (o.isMesh && o.userData.ObjectType === type) o.visible = false; });
  setSelected(null);
}
function showAll() {
  modelRoot.traverse(o => { o.visible = true; });
  document.querySelectorAll('#types input, #scopes input').forEach(b => { b.checked = true; });
  setSelected(null);
}

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) >= 4) return;
  pick(e);
  menu.textContent = '';
  if (selected) {
    const type = selected.userData.ObjectType ?? 'element';
    menuItem(selected.name, null, 'title');
    menuItem('Hide', () => { selected.visible = false; setSelected(null); });
    menuItem(`Hide all ${type}`, () => hideType(type));
    menuItem('Isolate (hide everything else)', () => {
      const keep = selected;
      modelRoot.traverse(o => { if (o.isMesh) o.visible = o === keep; });
      setSelected(keep);
    });
  }
  menuItem('Show all', showAll);
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.style.display = 'block';
});
window.addEventListener('pointerdown', e => { if (!menu.contains(e.target)) hideMenu(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu(); });

let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 4) pick(e);
});

document.getElementById('hide').onclick = () => {
  if (selected) { selected.visible = false; setSelected(null); }
};
document.getElementById('showAll').onclick = showAll;

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

await loadModel();
await loadPlanImages();
window.viewer = { setView, scene, controls, THREE, get camera() { return camera; } };
