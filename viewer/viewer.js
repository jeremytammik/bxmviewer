import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { applyDepthBias, depthLayerOf, depthRange, planLayout, resolveCoplanarLayers, setDepthBias } from './depth-and-plans.mjs';

const MODELS = ['renov', 'warehouse', 'modelfile', 'model6282'];
const ASSETS = '../sample/';
const IMAGE_DIR = ASSETS + 'Images/';

const params = new URLSearchParams(location.search);
const modelName = params.get('model') ?? MODELS[0];
const stretchImages = params.has('stretch');

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.localClippingEnabled = true;
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
const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const sectionPlanes = [sectionPlane];
const sectionEnabled = document.getElementById('sectionEnabled');
const sectionAxis = document.getElementById('sectionAxis');
const sectionSide = document.getElementById('sectionSide');
const sectionPosition = document.getElementById('sectionPosition');
const sectionLabel = document.getElementById('sectionLabel');
let sectionRange = null;
const highlightColour = new THREE.Color(0xffc400);
let selected = null;
let bounds = new THREE.Box3();
const hiddenScopes = new Set(), hiddenTypes = new Set(), hiddenMeshes = new Set();
const planImages = [], imageFailures = [];
let isolatedMesh = null, depthReport;
const sizing = document.getElementById('imageSizing');
sizing.value = stretchImages ? 'declared' : 'aspect';

function updateDepthRange() {
  if (bounds.isEmpty()) return;
  const box = bounds.clone();
  for (const image of planImages) if (image.mesh?.visible) box.union(new THREE.Box3().setFromObject(image.mesh));
  const range = depthRange(camera, box, THREE);
  if (range && (Math.abs(camera.near - range.near) > 1e-6 || Math.abs(camera.far - range.far) > 1e-4)) {
    Object.assign(camera, range); camera.updateProjectionMatrix();
  }
}

function updateVisibility() {
  modelRoot.traverse(o => {
    if (o.isMesh) o.visible = !hiddenScopes.has(o.userData.ScopeID) && !hiddenTypes.has(o.userData.ObjectType)
      && !hiddenMeshes.has(o) && (!isolatedMesh || isolatedMesh === o);
  });
  for (const image of planImages) if (image.mesh) image.mesh.visible = image.enabled && image.valid && !hiddenScopes.has(image.data.scopeId);
  if (selected && !selected.visible) setSelected(null);
  document.getElementById('fitPlans').disabled = !planImages.some(i => i.mesh?.visible);
  updateDepthRange();
}

function updateSelectionButtons() {
  for (const [id, selector] of [['selectAllScopes', '#scopes input'], ['selectAllTypes', '#types input']]) {
    const boxes = [...document.querySelectorAll(selector)];
    const button = document.getElementById(id);
    button.disabled = boxes.length === 0;
    button.textContent = boxes.length && boxes.every(box => box.checked) ? 'Unselect all' : 'Select all';
  }
}

function applySectionClipping(material) {
  for (const part of Array.isArray(material) ? material : [material]) {
    const clippingPlanes = sectionEnabled.checked ? sectionPlanes : null;
    if (part.clippingPlanes !== clippingPlanes) {
      part.clippingPlanes = clippingPlanes;
      part.needsUpdate = true;
    }
  }
}

function updateSectionPlane() {
  if (!sectionRange) return;
  const axis = sectionAxis.value;
  const fraction = Number(sectionPosition.value) / Number(sectionPosition.max);
  const position = sectionRange.min + (sectionRange.max - sectionRange.min) * fraction;
  const direction = sectionSide.value === 'positive' ? 1 : -1;
  sectionPlane.normal.set(0, 0, 0);
  sectionPlane.normal[axis] = direction;
  sectionPlane.constant = -position * direction;
  sectionLabel.textContent = `Keep ${axis.toUpperCase()} ${direction > 0 ? '≥' : '≤'} ${position.toFixed(2)} m`;
}

sectionEnabled.onchange = () => {
  modelRoot.traverse(o => {
    if (!o.isMesh) return;
    applySectionClipping(o.material);
    applySectionClipping(o.userData.material);
  });
  applySectionClipping(highlightMaterial);
  applySectionClipping(greyMaterial);
  if (outline) applySectionClipping(outline.material);
  updateSectionPlane();
};
sectionAxis.onchange = () => {
  if (sectionRange) sectionRange = { min: bounds.min[sectionAxis.value], max: bounds.max[sectionAxis.value] };
  updateSectionPlane();
};
sectionSide.onchange = updateSectionPlane;
sectionPosition.oninput = updateSectionPlane;

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
  setStatus('Resolving overlapping surfaces ...');
  depthReport = await resolveCoplanarLayers(modelRoot, THREE);
  setDepthBias(highlightMaterial, depthReport.maxLayer + 2);
  document.getElementById('depthWarnings').textContent = depthReport.warnings.join('\n');
  // Record the prepared materials so selection restores their depth policies.
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    o.userData.material = o.material;
    applySectionClipping(o.material);
  });
  bounds = new THREE.Box3().setFromObject(modelRoot);
  sectionRange = { min: bounds.min[sectionAxis.value], max: bounds.max[sectionAxis.value] };
  for (const control of [sectionEnabled, sectionAxis, sectionSide, sectionPosition]) control.disabled = false;
  updateSectionPlane();
  buildTypeList();
  setView('iso');
  setStatus(`${modelName}: ${countMeshes()} elements`);
}

function countMeshes() {
  let n = 0;
  modelRoot.traverse(o => { if (o.isMesh) n++; });
  return n;
}

function updateImageWarnings() {
  const mismatches = planImages.filter(i => i.mesh && i.layout?.sizeMismatch).length;
  const messages = [...imageFailures, ...planImages.filter(i => i.error).map(i => `${i.data.name}: ${i.error}`)];
  if (mismatches) messages.push(`${mismatches} image(s): declared dimensions differ from JPG proportions. Choose the sizing used by your source calibration.`);
  document.getElementById('imageWarnings').textContent = messages.join('\n');
}

function layoutPlan(image) {
  try {
    const pixels = image.texture.image;
    const layout = planLayout(image.data, [pixels.width, pixels.height], sizing.value);
    const geometry = new THREE.PlaneGeometry(layout.width, layout.height).translate(layout.width / 2, layout.height / 2, 0);
    image.mesh.geometry.dispose(); image.mesh.geometry = geometry;
    image.mesh.matrix.makeBasis(new THREE.Vector3(...layout.xAxis), new THREE.Vector3(...layout.yAxis), new THREE.Vector3(0, 1, 0));
    image.mesh.matrix.setPosition(...layout.origin); image.mesh.updateMatrixWorld(true);
    image.layout = layout; image.valid = true; image.error = null;
    image.label.title = `Rendered ${layout.width.toFixed(3)} x ${layout.height.toFixed(3)} model units; declared ${image.data.width} x ${image.data.height}.`;
  } catch (error) {
    image.valid = false;
    image.error = error.message;
  }
}

function orderPlans() {
  // Depth testing retains real 3D occlusion. No image writes depth, so nearby or
  // coincident plans blend in this explicit order rather than camera-dependent order.
  planImages.forEach((image, i) => { if (image.mesh) image.mesh.renderOrder = 1000 + i; });
}

async function loadPlanImages() {
  const list = document.getElementById('images');
  let sidecar;
  try {
    const response = await fetch(`${ASSETS}${modelName}.images.json`);
    if (response.status === 404) return;
    if (!response.ok) throw Error(response.statusText);
    sidecar = await response.json();
    if (!Array.isArray(sidecar.images)) throw Error('Expected an images array');
  } catch (error) {
    imageFailures.push(`Could not read plan metadata: ${error.message}`); updateImageWarnings(); return;
  }
  const loader = new THREE.TextureLoader();
  list.textContent = '';
  for (const raw of sidecar.images) {
    if (!raw || typeof raw !== 'object' || typeof raw.file !== 'string' || !raw.file.trim()) {
      imageFailures.push('An image entry has no usable JPG filename.'); continue;
    }
    const data = { ...raw, name: raw.name || raw.file };
    const image = { data, enabled: true, valid: false, mesh: null, texture: null };
    planImages.push(image);
    const row = document.createElement('div'); row.className = 'image-row';
    const label = document.createElement('label'); image.label = label;
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, disabled: true });
    const name = document.createElement('span'); name.textContent = ' ' + data.name;
    label.append(box, name); row.append(label); list.append(row);
    try {
      image.texture = await loader.loadAsync(IMAGE_DIR + data.file);
      image.texture.colorSpace = THREE.SRGBColorSpace;
      image.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const material = applyDepthBias(new THREE.MeshBasicMaterial({
        map: image.texture, transparent: true, opacity: Number(document.getElementById('opacity').value),
        side: THREE.DoubleSide, depthTest: true, depthWrite: false,
      }), depthReport.maxLayer + 1);
      image.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      image.mesh.matrixAutoUpdate = false; image.mesh.userData.scopeId = data.scopeId;
      layoutPlan(image);
      planGroup.add(image.mesh); box.disabled = false;
      box.onchange = () => { image.enabled = box.checked; updateVisibility(); };
      const front = document.createElement('button'); front.textContent = 'Front';
      front.title = 'Draw this plan above the other plans without changing its position';
      front.setAttribute('aria-label', `Bring ${data.name} to front`);
      front.onclick = () => { planImages.splice(planImages.indexOf(image), 1); planImages.push(image); orderPlans(); };
      row.append(front);
    } catch (error) {
      image.enabled = false; box.checked = false;
      name.textContent += image.texture ? ' (invalid placement)' : ' (unavailable JPG)';
      imageFailures.push(`${data.name}: ${image.texture ? error.message : 'could not load ' + data.file}`);
      image.mesh?.geometry.dispose(); image.mesh?.material.dispose(); image.texture?.dispose();
      image.mesh = null; image.texture = null;
    }
  }
  orderPlans(); buildScopeList(sidecar.scopes ?? []); updateImageWarnings(); updateVisibility();
}

sizing.onchange = () => {
  for (const image of planImages) if (image.mesh) layoutPlan(image);
  if (sizing.value === 'declared') params.set('stretch', ''); else params.delete('stretch');
  history.replaceState(null, '', location.pathname + '?' + params.toString());
  updateImageWarnings(); updateVisibility();
};
document.getElementById('fitPlans').onclick = () => {
  const box = new THREE.Box3();
  for (const image of planImages) if (image.mesh?.visible) box.union(new THREE.Box3().setFromObject(image.mesh));
  if (!box.isEmpty()) setView('plan', box);
};

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
  if (!byName.size) { updateSelectionButtons(); return; }
  list.textContent = '';
  for (const [name, ids] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    box.dataset.scopeIds = JSON.stringify(ids);
    box.onchange = () => { for (const id of ids) box.checked ? hiddenScopes.delete(id) : hiddenScopes.add(id); updateSelectionButtons(); updateVisibility(); };
    label.append(box, ' ', name);
    list.append(label);
  }
  updateSelectionButtons();
}

document.getElementById('selectAllScopes').onclick = () => {
  const boxes = [...document.querySelectorAll('#scopes input')];
  const select = boxes.some(box => !box.checked);
  for (const box of boxes) {
    box.checked = select;
    for (const id of JSON.parse(box.dataset.scopeIds)) select ? hiddenScopes.delete(id) : hiddenScopes.add(id);
  }
  updateSelectionButtons();
  updateVisibility();
};

document.getElementById('opacity').oninput = e => {
  for (const mesh of planGroup.children) mesh.material.opacity = Number(e.target.value);
};

function setView(kind, fitBounds = bounds) {
  const centre = fitBounds.getCenter(new THREE.Vector3());
  const size = fitBounds.getSize(new THREE.Vector3());
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
  // Actual content depth is updated below; avoid the old fixed far/near ratio.
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();
  updateDepthRange();
}
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => setView(b.dataset.view); });

function pick(event) {
  const rect = canvas.getBoundingClientRect();
  const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(modelRoot, true).filter(h => isPickable(h.object)
    && (!sectionEnabled.checked || sectionPlane.distanceToPoint(h.point) >= -1e-7));
  // Zones are large transparent volumes; prefer the solid element in front of or inside them.
  const solid = hits.find(h => !h.object.material.transparent && h.object.userData.ObjectType !== 'Zone');
  const first = solid ?? hits[0];
  const epsilon = Math.max(bounds.getSize(new THREE.Vector3()).length() * 1e-7, 1e-7);
  const tied = first && hits.filter(h => Math.abs(h.distance - first.distance) <= epsilon
    && (!solid || (!h.object.material.transparent && h.object.userData.ObjectType !== 'Zone')));
  // The object visible at a coplanar tie should also win the pick.
  const hit = tied?.reduce((best, h) => depthLayerOf(h.object) > depthLayerOf(best.object) ? h : best, first);
  setSelected(hit?.object ?? null);
}

function isPickable(mesh) {
  for (let o = mesh; o; o = o.parent) if (!o.visible) return false;
  return true;
}

// The depth bias keeps the selection stable where another element occupies the same space (e.g. a demolition wall over an existing wall).
const highlightMaterial = applyDepthBias(new THREE.MeshBasicMaterial({
  color: 0xff9900, side: THREE.DoubleSide,
}), 1);
let outline = null;

function setSelected(mesh) {
  selected = mesh;
  outline?.removeFromParent();
  outline?.geometry.dispose();
  outline?.material.dispose();
  outline = null;
  if (mesh) {
    outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 20), new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false, depthWrite: false, transparent: true }));
    applySectionClipping(outline.material);
    outline.renderOrder = 2000 + planImages.length;
    outline.raycast = () => {};
    mesh.add(outline);
  }
  const isolate = document.getElementById('isolate').checked;
  modelRoot.traverse(o => {
    if (!o.isMesh) return;
    o.material = o === selected ? highlightMaterial : !selected || !isolate ? o.userData.material : greyMaterial;
    applySectionClipping(o.material);
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
    box.dataset.type = String(type);
    box.onchange = () => { box.checked ? hiddenTypes.delete(type) : hiddenTypes.add(type); updateSelectionButtons(); updateVisibility(); };
    label.append(box, ` ${type} (${count})`);
    list.append(label);
  }
  updateSelectionButtons();
}

document.getElementById('selectAllTypes').onclick = () => {
  const boxes = [...document.querySelectorAll('#types input')];
  const select = boxes.some(box => !box.checked);
  for (const box of boxes) {
    box.checked = select;
    select ? hiddenTypes.delete(box.dataset.type) : hiddenTypes.add(box.dataset.type);
  }
  updateSelectionButtons();
  updateVisibility();
};

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
  hiddenTypes.add(type);
  document.querySelectorAll('#types input').forEach(box => { box.checked = !hiddenTypes.has(box.dataset.type); });
  updateSelectionButtons(); setSelected(null); updateVisibility();
}
function showAll() {
  hiddenScopes.clear(); hiddenTypes.clear(); hiddenMeshes.clear(); isolatedMesh = null;
  document.querySelectorAll('#types input, #scopes input').forEach(b => { b.checked = true; });
  updateSelectionButtons(); setSelected(null); updateVisibility();
}

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) >= 4) return;
  pick(e);
  menu.textContent = '';
  if (selected) {
    const type = selected.userData.ObjectType ?? 'element';
    menuItem(selected.name, null, 'title');
    menuItem('Hide', () => { hiddenMeshes.add(selected); setSelected(null); updateVisibility(); });
    menuItem(`Hide all ${type}`, () => hideType(type));
    menuItem('Isolate (hide everything else)', () => {
      const keep = selected;
      isolatedMesh = keep; updateVisibility(); setSelected(keep);
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
  if (selected) { hiddenMeshes.add(selected); setSelected(null); updateVisibility(); }
};
document.getElementById('showAll').onclick = showAll;

renderer.setAnimationLoop(() => {
  controls.update();
  updateDepthRange();
  renderer.render(scene, camera);
});

await loadModel();
await loadPlanImages();
window.viewer = { setView, scene, controls, THREE, sectionPlane, renderer, get camera() { return camera; } };

// Release the extra owned materials and image resources when the page is closed.
addEventListener('pagehide', event => {
  if (event.persisted) return;
  renderer.setAnimationLoop(null);
  depthReport?.dispose();
  outline?.geometry.dispose(); outline?.material.dispose();
  for (const image of planImages) { image.mesh?.geometry.dispose(); image.mesh?.material.dispose(); image.texture?.dispose(); }
});
