// Geometry and image policies shared by the viewer and its small regression suite.
// No DOM or renderer dependency: callers provide their existing Three.js instance.
export const MAX_DEPTH_LAYERS = 32;
const depthUniforms = new WeakMap();
const meshLayers = new WeakMap();
export const depthLayerOf = mesh => meshLayers.get(mesh) || 0;
const finiteVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

function trianglesOverlap(a, b, epsilon) {
  for (const triangle of [a, b]) for (let i = 0; i < 3; i++) {
    const p = triangle[i], q = triangle[(i + 1) % 3], x = p[1] - q[1], y = q[0] - p[0];
    const pa = a.map(p => p[0] * x + p[1] * y), pb = b.map(p => p[0] * x + p[1] * y);
    if (Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= epsilon * Math.hypot(x, y)) return false;
  }
  return true;
}

export function planLayout(image, pixels, mode = 'aspect') {
  if (!Number.isFinite(image.width) || image.width <= 0) throw Error('Invalid image width');
  if (!finiteVector(image.origin) || !finiteVector(image.xAxis)) throw Error('Invalid image origin or axis');
  const [x, y, z] = image.xAxis, length = Math.hypot(x, y, z);
  if (!length || Math.abs(y) > length * 1e-6) throw Error('Only horizontal plan axes are supported');
  if (!Array.isArray(pixels) || pixels.length !== 2 || !pixels.every(v => Number.isFinite(v) && v > 0)) throw Error('Invalid image pixel size');
  if (!['aspect', 'declared'].includes(mode)) throw Error('Unknown image sizing mode');
  const aspectHeight = image.width * pixels[1] / pixels[0];
  if (mode === 'declared' && (!Number.isFinite(image.height) || image.height <= 0)) throw Error('Invalid declared image height');
  return {
    width: image.width, height: mode === 'declared' ? image.height : aspectHeight,
    xAxis: [x / length, 0, z / length], yAxis: [z / length, 0, -x / length],
    origin: [...image.origin],
    sizeMismatch: Number.isFinite(image.height) && Math.abs(image.height - aspectHeight) > Math.max(image.height, aspectHeight) * .001,
  };
}

export function depthRange(camera, box, THREE) {
  if (box.isEmpty()) return null;
  camera.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  let nearest = Infinity, furthest = -Infinity;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const distance = -p.set(x, y, z).applyMatrix4(camera.matrixWorldInverse).z;
    nearest = Math.min(nearest, distance); furthest = Math.max(furthest, distance);
  }
  const span = box.getSize(p).length();
  const near = nearest > 0 ? Math.max(.001, nearest * .5) : Math.max(.001, Math.min(.05, span / 100000));
  return { near, far: Math.max(near + 1, furthest * 1.1, span * .01) };
}

// Logarithmic depth keeps precision useful at both ends of a BIM scene. A tiny
// fragment-depth tie-break also works with log depth, unlike polygon offset alone.
// Uniforms vary per material; shader programs are shared between depth layers.
export function applyDepthBias(material, layer) {
  const before = material.onBeforeCompile, key = material.customProgramCacheKey();
  const uniform = { value: layer };
  depthUniforms.set(material, { uniform, baseUnits: material.polygonOffsetUnits });
  material.onBeforeCompile = function(shader, renderer) {
    before.call(this, shader, renderer);
    shader.uniforms.bxmDepthLayer = uniform;
    shader.fragmentShader = 'uniform float bxmDepthLayer;\n' + shader.fragmentShader.replace(
      '#include <logdepthbuf_fragment>',
      '#include <logdepthbuf_fragment>\n#ifdef USE_LOGDEPTHBUF\ngl_FragDepth = clamp(gl_FragDepth - bxmDepthLayer * (32.0 / 16777216.0), 0.0, 1.0);\n#endif',
    );
  };
  material.customProgramCacheKey = () => key + '|bxm-depth-bias-v1';
  material.polygonOffset = true;
  material.polygonOffsetUnits -= layer * 2; // Fallback for non-logarithmic renderers.
  return material;
}

export function setDepthBias(material, layer) {
  const data = depthUniforms.get(material);
  if (!data) throw Error('Material has no depth policy');
  data.uniform.value = layer;
  material.polygonOffsetUnits = data.baseUnits - layer * 2;
}

export function installDepthLayer(mesh, layer, cache = new Map()) {
  meshLayers.set(mesh, layer);
  if (!layer) return () => {};
  const original = mesh.material;
  const materials = [].concat(original).map(material => {
    if (!cache.has(material)) cache.set(material, new Map());
    const layers = cache.get(material);
    if (!layers.has(layer)) {
      const copy = material.clone();
      copy.onBeforeCompile = material.onBeforeCompile;
      copy.customProgramCacheKey = material.customProgramCacheKey;
      layers.set(layer, applyDepthBias(copy, layer));
    }
    return layers.get(layer);
  });
  mesh.material = Array.isArray(original) ? materials : materials[0];
  return () => { mesh.material = original; meshLayers.delete(mesh); };
}

export async function resolveCoplanarLayers(root, THREE, { maxTriangles = 500000, maxPairs = 200000, maxLayers = MAX_DEPTH_LAYERS, maxTriangleChecks = 2000000 } = {}) {
  const meshes = []; root.updateMatrixWorld(true);
  root.traverse(o => { if (o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh) meshes.push(o); });
  const triangles = meshes.reduce((n, m) => n + (m.geometry.index?.count || m.geometry.attributes.position?.count || 0) / 3, 0);
  const report = { triangles, overlapPairs: 0, layeredMeshes: 0, maxLayer: 0, warnings: [], dispose() {} };
  if (triangles > maxTriangles) {
    report.warnings.push(`Coplanar analysis skipped above ${maxTriangles.toLocaleString()} triangles; camera depth precision is still improved.`);
    return report;
  }
  const box = new THREE.Box3().setFromObject(root), epsilon = Math.max(box.getSize(new THREE.Vector3()).length() * 1e-7, 1e-7);
  const groups = new Map(), graph = new Map(meshes.map(m => [m, new Set()]));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3(), edge = new THREE.Vector3();
  let processed = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry, position = geometry.attributes.position, index = geometry.index;
    if (!position || geometry.morphAttributes.position?.length) continue;
    const faces = new Map(), count = index?.count || position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
      normal.subVectors(b, a).cross(edge.subVectors(c, a));
      if (normal.lengthSq() <= epsilon ** 4) continue;
      normal.normalize();
      const first = [normal.x, normal.y, normal.z].find(v => Math.abs(v) > 1e-6);
      if (first < 0) normal.negate();
      const distance = normal.dot(a), n = normal.toArray();
      const key = n.map(v => Math.round(v / 1e-5)).concat(Math.round(distance / epsilon)).join(',');
      const drop = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs))), axes = [0, 1, 2].filter(x => x !== drop);
      const points = [a.toArray(), b.toArray(), c.toArray()];
      const u = points.map(p => p[axes[0]]), v = points.map(p => p[axes[1]]);
      const face = faces.get(key) || { mesh, minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity, triangles: [] };
      face.minU = Math.min(face.minU, ...u); face.maxU = Math.max(face.maxU, ...u);
      face.minV = Math.min(face.minV, ...v); face.maxV = Math.max(face.maxV, ...v);
      face.triangles.push(points.map(p => [p[axes[0]], p[axes[1]]]));
      faces.set(key, face);
      if (++processed % 4096 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    for (const [key, face] of faces) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(face);
    }
  }
  // A broad phase followed by triangle intersection avoids assigning depth layers
  // to disjoint patches or to geometry inside the empty hole of another surface.
  let triangleChecks = 0;
  for (const faces of groups.values()) {
    faces.sort((a, b) => a.minU - b.minU);
    for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length && faces[j].minU < faces[i].maxU - epsilon; j++) {
      const a = faces[i], b = faces[j];
      if (Math.min(a.maxV, b.maxV) - Math.max(a.minV, b.minV) <= epsilon || graph.get(a.mesh).has(b.mesh)) continue;
      let overlap = false;
      for (const ta of a.triangles) {
        for (const tb of b.triangles) {
          if (++triangleChecks > maxTriangleChecks) {
            report.warnings.push('Coplanar comparison limit reached; automatic depth layers were not applied.'); return report;
          }
          if (triangleChecks % 2048 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          if (trianglesOverlap(ta, tb, epsilon)) { overlap = true; break; }
        }
        if (overlap) break;
      }
      if (!overlap) continue;
      if (report.overlapPairs >= maxPairs) {
        report.warnings.push('Coplanar overlap limit reached; automatic depth layers were not applied.');
        return report;
      }
      graph.get(a.mesh).add(b.mesh); graph.get(b.mesh).add(a.mesh); report.overlapPairs++;
    }
  }
  const keys = new Map(meshes.map((mesh, i) => [mesh, String(mesh.userData.ID || mesh.name || '') + ':' + i]));
  const key = mesh => keys.get(mesh);
  const ordered = [...meshes].sort((a, b) => graph.get(b).size - graph.get(a).size || key(a).localeCompare(key(b), 'en'));
  const layers = new Map(), disposers = [];
  for (const mesh of ordered) {
    const used = new Set([...graph.get(mesh)].map(m => layers.get(m)));
    let layer = 0; while (used.has(layer) && layer < maxLayers) layer++;
    if (layer === maxLayers) {
      report.warnings.push('Coplanar layer limit reached; automatic depth layers were not applied.');
      return report;
    }
    layers.set(mesh, layer);
  }
  const cache = new Map();
  for (const [mesh, layer] of layers) if (layer) {
    disposers.push(installDepthLayer(mesh, layer, cache)); report.layeredMeshes++; report.maxLayer = Math.max(report.maxLayer, layer);
  }
  report.dispose = () => {
    disposers.splice(0).forEach(dispose => dispose());
    for (const layers of cache.values()) for (const material of layers.values()) material.dispose();
    cache.clear();
  };
  return report;
}
