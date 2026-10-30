import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../viewer/vendor/three/three.module.js';
import { applyDepthBias, depthRange, planLayout, resolveCoplanarLayers } from '../viewer/depth-and-plans.mjs';

const image = { width: 10, height: 10, origin: [3, 2, -5], xAxis: [2, 0, 0] };
test('image sizing preserves pixels by default and uses declared dimensions only explicitly', () => {
  assert.deepEqual(planLayout(image, [200, 100]).height, 5);
  assert.equal(planLayout(image, [200, 100], 'declared').height, 10);
  assert.equal(planLayout(image, [200, 100]).sizeMismatch, true);
  assert.equal(planLayout({ ...image, height: 5 }, [200, 100]).sizeMismatch, false);
});
test('plan transform retains the origin and normalises a rotated horizontal axis', () => {
  const p = planLayout({ ...image, xAxis: [0, 0, -2] }, [200, 100]);
  assert.deepEqual(p.origin, [3, 2, -5]); assert.deepEqual(p.xAxis, [0, 0, -1]); assert.deepEqual(p.yAxis, [-1, 0, -0]);
});
test('invalid placement and unsupported tilt fail explicitly', () => {
  for (const bad of [{ ...image, width: 0 }, { ...image, origin: [0, NaN, 0] }, { ...image, xAxis: [0, 0, 0] }, { ...image, xAxis: [1, 1, 0] }]) {
    assert.throws(() => planLayout(bad, [200, 100]));
  }
  assert.throws(() => planLayout({ ...image, height: -1 }, [200, 100], 'declared'));
  assert.throws(() => planLayout(image, [0, 100]));
});
function plane(id, x = 0, z = 0, material = new THREE.MeshBasicMaterial()) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.userData.ID = id; mesh.position.set(x, 0, z); return mesh;
}
test('only overlapping coplanar meshes get a depth tie-break and geometry is untouched', async () => {
  const root = new THREE.Group(), shared = new THREE.MeshBasicMaterial();
  const a = plane('a', 0, 0, shared), b = plane('b', .5, 0, shared), c = plane('c', 5, 0, shared), d = plane('d', 0, .01, shared);
  root.add(a, b, c, d); const positions = b.geometry.attributes.position.array.slice();
  const report = await resolveCoplanarLayers(root, THREE);
  assert.equal(report.overlapPairs, 1); assert.equal(report.layeredMeshes, 1); assert.equal(report.maxLayer, 1);
  assert.equal(a.material, shared); assert.notEqual(b.material, shared); assert.equal(c.material, shared); assert.equal(d.material, shared);
  assert.deepEqual(b.geometry.attributes.position.array, positions); assert.equal(shared.polygonOffset, false);
  let disposed = 0; b.material.addEventListener('dispose', () => disposed++);
  report.dispose(); assert.equal(b.material, shared); assert.equal(disposed, 1); report.dispose(); assert.equal(disposed, 1);
});
test('depth priority is stable when source mesh order changes', async () => {
  for (const reverse of [false, true]) {
    const a = plane('a'), b = plane('b'), root = new THREE.Group(); root.add(...(reverse ? [b, a] : [a, b]));
    const report = await resolveCoplanarLayers(root, THREE);
    assert.equal(a.material.polygonOffset, false); assert.equal(b.material.polygonOffset, true); report.dispose();
  }
});
test('analysis limits leave the complete original scene intact', async () => {
  for (const options of [{ maxTriangles: 1 }, { maxPairs: 0 }, { maxLayers: 1 }, { maxTriangleChecks: 0 }]) {
    const a = plane('a'), b = plane('b'), original = b.material, root = new THREE.Group(); root.add(a, b);
    const report = await resolveCoplanarLayers(root, THREE, options);
    assert.ok(report.warnings.length); assert.equal(b.material, original); assert.equal(report.layeredMeshes, 0);
  }
});
test('overlapping bounding boxes alone do not imply overlapping triangles', async () => {
  const triangle = points => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3)); return new THREE.Mesh(g, new THREE.MeshBasicMaterial()); };
  const a = triangle([0,0,0, 2,0,0, 0,2,0]), b = triangle([2,2,0, 2,.5,0, .5,2,0]);
  const root = new THREE.Group(); root.add(a,b); const report = await resolveCoplanarLayers(root, THREE);
  assert.equal(report.overlapPairs, 0); assert.equal(report.layeredMeshes, 0);
});
test('depth uniforms differ per material while shader programs can be shared', () => {
  const a = applyDepthBias(new THREE.MeshBasicMaterial(), 1), b = applyDepthBias(new THREE.MeshBasicMaterial(), 2);
  const shaders = [a, b].map(material => { const shader = { uniforms: {}, fragmentShader: '#include <logdepthbuf_fragment>' }; material.onBeforeCompile(shader); return shader; });
  assert.equal(shaders[0].uniforms.bxmDepthLayer.value, 1); assert.equal(shaders[1].uniforms.bxmDepthLayer.value, 2);
  assert.equal(a.customProgramCacheKey(), b.customProgramCacheKey()); assert.match(shaders[0].fragmentShader, /gl_FragDepth = clamp/);
});
test('camera clipping encloses the model without an unnecessary far plane', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, .1, 5000); camera.position.z = 10; camera.lookAt(0, 0, 0);
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const range = depthRange(camera, box, THREE); assert.ok(range.near > 0 && range.near < 9); assert.ok(range.far > 11 && range.far < 15);
  camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1); const inside = depthRange(camera, box, THREE);
  assert.ok(inside.near > 0 && inside.near < 1 && inside.far > 1);
});
