import * as THREE from 'three';
import { applyDepthBias, depthRange, MAX_DEPTH_LAYERS, resolveCoplanarLayers } from '../viewer/depth-and-plans.mjs';
const result = document.getElementById('result'), reports = [];
function assert(value, message) { if (!value) throw Error(message); }
function setup(fixed) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: fixed });
  renderer.setSize(256, 256); renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  document.getElementById('views').append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0);
  const root = new THREE.Group(); scene.add(root);
  const camera = new THREE.PerspectiveCamera(45, 1, .01, 5000);
  const red = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshBasicMaterial({color:0xff0000,side:THREE.DoubleSide})); red.userData.ID = 'a';
  const green = new THREE.Mesh(new THREE.PlaneGeometry(8, 8, 19, 17), new THREE.MeshBasicMaterial({color:0x00ff00,side:THREE.DoubleSide})); green.userData.ID = 'b';
  root.add(red, green); root.rotation.y = .19; root.updateMatrixWorld(true);
  return { renderer, scene, root, camera, red, green };
}
function pixels(test, frame, whole = false) {
  test.camera.position.set(5 + frame * .001, 3 + Math.sin(frame) * .01, 14); test.camera.lookAt(0, 0, 0);
  if (test.fixed) Object.assign(test.camera, depthRange(test.camera, new THREE.Box3().setFromObject(test.root), THREE));
  test.camera.updateProjectionMatrix(); test.renderer.render(test.scene, test.camera);
  const size = whole ? 256 : 32, offset = whole ? 0 : 112;
  const rgba = new Uint8Array(size * size * 4); test.renderer.getContext().readPixels(offset, offset, size, size, test.renderer.getContext().RGBA, test.renderer.getContext().UNSIGNED_BYTE, rgba);
  return rgba;
}
try {
  const baseline = setup(false), fixed = setup(true); fixed.fixed = true;
  const layers = await resolveCoplanarLayers(fixed.root, THREE);
  assert(layers.overlapPairs === 1 && layers.layeredMeshes === 1, 'The overlap fixture must be detected');
  let baselineRed = 0, fixedRed = 0;
  for (let frame = 0; frame < 32; frame++) {
    for (const [test, label] of [[baseline, 'baseline'], [fixed, 'fixed']]) {
      const p = pixels(test, frame, true); let count = 0;
      // Exclude a two-pixel silhouette where triangulations can differ in coverage.
      for (let y = 2; y < 254; y++) for (let x = 2; x < 254; x++) {
        const i = (y * 256 + x) * 4;
        const inside = [[-2,0],[2,0],[0,-2],[0,2]].every(([dx,dy]) => {const j=((y+dy)*256+x+dx)*4;return p[j]+p[j+1]>100;});
        if (inside && p[i] > p[i+1]) count++;
      }
      if (label === 'baseline') baselineRed += count; else fixedRed += count;
    }
  }
  assert(fixedRed === 0, `Coplanar winner must remain green across camera perturbations (baseline ${baselineRed}, fixed ${fixedRed})`);
  reports.push({test:'Coplanar surfaces with different triangulation across32views',passed:true,baselineRedPixels:baselineRed,fixedRedPixels:fixedRed,sampledPixelsPerVersion:2097152,coverage:"Whole overlap interior, excluding a two-pixel silhouette"});
  for(const [test,label]of[[baseline,'Original depth policy'],[fixed,'Corrected depth policy']]){
    const figure=document.createElement('figure');figure.style.display='inline-block';figure.style.margin='8px';
    const image=new Image();image.src=test.renderer.domElement.toDataURL();const caption=document.createElement('figcaption');caption.textContent=label;
    figure.append(image,caption);document.getElementById('views').append(figure);test.renderer.domElement.style.display='none';
  }
  const blue = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({color:0x0000ff,side:THREE.DoubleSide}));
  blue.position.z = .05; fixed.root.add(blue); fixed.root.updateMatrixWorld(true);
  const front = pixels(fixed, 0), center = (16 * 32 + 16) * 4;
  assert(front[center + 2] > 200 && front[center + 1] < 10, 'A genuinely closer surface must still occlude the depth-biased layer');
  blue.position.z = -.05; fixed.root.updateMatrixWorld(true); const behind = pixels(fixed, 0);
  assert(behind[center + 1] > 200 && behind[center + 2] < 10, 'A genuinely farther surface must not cover the depth-biased layer');
  reports.push({test:'Real front and back occlusion at50mm separation',passed:true});
  // A second biased material must share the program without sharing its uniform.
  fixed.root.remove(blue);
  const winner=new THREE.Mesh(new THREE.PlaneGeometry(8,8,11,13),applyDepthBias(new THREE.MeshBasicMaterial({color:0x0000ff,side:THREE.DoubleSide}),2));
  fixed.root.add(winner);fixed.root.updateMatrixWorld(true);
  for(let frame=0;frame<32;frame++){const p=pixels(fixed,frame);assert(p[center+2]>200&&p[center]<10&&p[center+1]<10,'Multiple depth-layer uniforms must remain independent');}
  reports.push({test:'Multiple biased materials sharing a shader program',passed:true});fixed.root.remove(winner);
  fixed.root.remove(blue); fixed.red.visible = fixed.green.visible = false;
  const plans = [0xff0000,0x0000ff].map((color,i)=>{
    const material=applyDepthBias(new THREE.MeshBasicMaterial({color,transparent:true,opacity:.5,depthWrite:false,side:THREE.DoubleSide}),MAX_DEPTH_LAYERS+1);
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(8,8),material);mesh.renderOrder=1000+i;fixed.root.add(mesh);return mesh;
  });
  let rangeR=[255,0],rangeB=[255,0];
  for(let frame=0;frame<32;frame++){
    const p=pixels(fixed,frame);const r=p[center],b=p[center+2];rangeR=[Math.min(rangeR[0],r),Math.max(rangeR[1],r)];rangeB=[Math.min(rangeB[0],b),Math.max(rangeB[1],b)];
    assert(Math.abs(r-64)<=2&&Math.abs(b-128)<=2,'Transparent plans must blend once in their explicit order');
  }
  plans[0].renderOrder=1002;const swapped=pixels(fixed,0);
  assert(Math.abs(swapped[center]-128)<=2&&Math.abs(swapped[center+2]-64)<=2,'Bring-to-front must change compositing order');
  reports.push({test:'Transparent coincident image layers and bring-to-front',passed:true,redRange:rangeR,blueRange:rangeB});
  result.textContent=JSON.stringify({passed:true,reports},null,2);result.dataset.passed='true';
  window.depthRegression={passed:true,reports};
} catch(error) { result.textContent=JSON.stringify({passed:false,reports,error:error.stack},null,2);result.dataset.passed='false';window.depthRegression={passed:false,reports,error:error.stack}; }
