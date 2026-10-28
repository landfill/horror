import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

// Exercise the real meshes without a browser. The cached material provider is the
// only rendering boundary mocked here; geometry, transforms and raycasts are real.
const materials = new Map();
const Mat = new Proxy({}, { get: (_, name) => (...args) => {
  const key = `${name}:${JSON.stringify(args)}`;
  if (!materials.has(key)) materials.set(key, new THREE.MeshLambertMaterial());
  return materials.get(key);
} });
const source = readFileSync(new URL('../src/world/Props.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', output)((name) => {
  if (name === 'three') return THREE;
  if (name === './Textures') return { Mat, rand: (a, b) => (a + b) / 2 };
  if (name === './Maze') return { SEG_H: 3.1 };
  throw new Error(`Unexpected dependency ${name}`);
}, module, module.exports);
const { makeProp } = module.exports;
const partNames = ['slipper-sole', 'slipper-insole', 'slipper-upper'];

function pair() {
  const root = makeProp('shoes');
  root.updateMatrixWorld(true);
  return root;
}
function meshes(root) {
  const result = [];
  root.traverse((object) => { if (object.isMesh) result.push(object); });
  return result;
}
function downward(root, x, z) {
  return new THREE.Raycaster(new THREE.Vector3(x, 0.3, z), new THREE.Vector3(0, -1, 0))
    .intersectObject(root, true)[0];
}

test('slippers have a distinct left/right sole, recessed insole and curved upper', () => {
  const root = pair();
  assert.equal(meshes(root).length, 6, 'each pair uses only six meshes');
  for (const [name, x] of [['slipper-left', -0.087], ['slipper-right', 0.087]]) {
    const slipper = root.getObjectByName(name);
    assert.ok(slipper?.isGroup, `${name} is a named group`);
    assert.ok(Math.abs(slipper.position.x - x) < 1e-12);
    for (const partName of partNames) {
      assert.ok(slipper.getObjectByName(partName)?.isMesh, `${name} contains ${partName}`);
    }
    const soleBounds = new THREE.Box3().setFromObject(slipper.getObjectByName('slipper-sole'));
    const insoleBounds = new THREE.Box3().setFromObject(slipper.getObjectByName('slipper-insole'));
    const upperBounds = new THREE.Box3().setFromObject(slipper.getObjectByName('slipper-upper'));
    assert.ok(soleBounds.min.y >= -1e-6 && soleBounds.max.y <= 0.018001);
    assert.ok(insoleBounds.min.y >= 0.018 && insoleBounds.max.y < 0.03);
    assert.ok(upperBounds.min.z > -0.06, 'the upper leaves the rear half of the slipper open');
    assert.ok(upperBounds.max.z > 0.14 && upperBounds.max.z < 0.17);
  }
});

test('slipper pair stays small enough for the door threshold and clear corridor path', () => {
  const bounds = new THREE.Box3().setFromObject(pair());
  const size = bounds.getSize(new THREE.Vector3());
  assert.ok(size.x >= 0.30 && size.x <= 0.34, `pair width ${size.x}`);
  assert.ok(size.z >= 0.30 && size.z <= 0.33, `pair length ${size.z}`);
  assert.ok(bounds.min.y >= -1e-6 && size.y <= 0.11, `pair height ${size.y}`);
});

test('all instances reuse three shared geometries and their cached materials', () => {
  const first = pair();
  const firstMeshes = meshes(first);
  const geometries = new Set(firstMeshes.map((mesh) => mesh.geometry));
  const materialSet = new Set(firstMeshes.map((mesh) => mesh.material));
  const cachedMaterialCount = materials.size;
  assert.equal(geometries.size, 3);
  assert.ok([...geometries].every((geometry) => geometry.userData.shared === true));
  for (let i = 0; i < 32; i++) {
    const next = pair();
    assert.notEqual(next, first, 'only transforms/mesh instances are local to a pair');
    for (const mesh of meshes(next)) {
      assert.ok(geometries.has(mesh.geometry), 'no instance-specific geometry');
      assert.ok(materialSet.has(mesh.material), 'no instance-specific material');
    }
  }
  assert.equal(materials.size, cachedMaterialCount);
});

test('heel openings expose the insole while the toe is covered by a raised upper', () => {
  const root = pair();
  for (const x of [-0.087, 0.087]) {
    const heel = downward(root, x, -0.10);
    assert.ok(heel, 'heel has a visible insole');
    assert.equal(heel.object.name, 'slipper-insole');
    assert.ok(heel.point.y < 0.03, 'heel opening is not capped by the upper');
    const toe = downward(root, x, 0.07);
    assert.ok(toe, 'toe is covered');
    assert.equal(toe.object.name, 'slipper-upper');
    assert.ok(toe.point.y > 0.06, 'toe upper is visibly raised above the sole');
  }
});

test('the rear opening has space for a foot rather than a solid upper block', () => {
  const root = pair();
  const doubleSided = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  try {
    for (const name of ['slipper-left', 'slipper-right']) {
      const slipper = root.getObjectByName(name);
      const upper = slipper.getObjectByName('slipper-upper');
      // Include backfaces to see the inside of the shell independent of display material.
      const shell = new THREE.Mesh(upper.geometry, doubleSided);
      shell.matrixWorld.copy(upper.matrixWorld);
      const ray = new THREE.Raycaster(
        new THREE.Vector3(slipper.position.x, 0.05, -0.3), new THREE.Vector3(0, 0, 1),
      );
      const hits = ray.intersectObject(shell);
      assert.ok(hits.length > 0, 'upper closes around the toe');
      assert.ok(hits[0].point.z > 0, 'rear opening and inner arch are clear at foot height');
    }
  } finally {
    doubleSided.dispose();
  }
});
