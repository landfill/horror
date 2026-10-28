// Run with: node scripts/test-world-performance.mjs
// Bundle the real TS modules in memory; no browser, video decode, or WebGL is needed.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as THREE from 'three';

globalThis.location = { search: '' };
const bundle = await build({
  stdin: {
    contents: `export { LightPool, LIGHT_FULL } from './src/world/Lighting.ts';
      export { EndlessWorld } from './src/world/EndlessWorld.ts';
      export { makeSwingDoor } from './src/world/Props.ts';
      export { GRID } from './src/world/Maze.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'share-three',
    setup(plugin) {
      plugin.onResolve({ filter: /^three$/ }, () => ({ path: import.meta.resolve('three'), external: true }));
    },
  }],
});
const { LightPool, LIGHT_FULL, EndlessWorld, GRID, makeSwingDoor } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

function fixture(x, { dead = false, base = LIGHT_FULL } = {}) {
  return { x, y: 2.9, z: 0, dead, base, seed: 0, current: base, dist: 0, mat: new THREE.MeshBasicMaterial() };
}

const scene = new THREE.Scene();
const lights = new LightPool(scene);
const pooledLights = scene.children.filter((child) => child.isPointLight);
const dark = Array.from({ length: 12 }, (_, i) => fixture(i * 0.01, { dead: true }));
const zero = fixture(0.2, { base: 0 });
const live = Array.from({ length: 13 }, (_, i) => fixture(i + 1));
lights.add('test', [...dark, zero, ...live]);
lights.update(0, 0, 0, true);
assert.equal(pooledLights.length, 12, 'the scene keeps a fixed 12-light pool');
assert.deepEqual(pooledLights.map((light) => light.position.x), live.slice(0, 12).map((f) => f.x),
  'nearby dead and zero-base fixtures must not displace live fixtures');

lights.killNearest(1, 0);
lights.update(0, 0, 0, true);
assert.deepEqual(pooledLights.map((light) => light.position.x), live.slice(1).map((f) => f.x),
  'killing the nearest fixture fills the vacant slot with the next live fixture');
assert.deepEqual(scene.children, pooledLights, 'light selection never adds/removes lights');

lights.remove('test');
lights.update(0, 0, 0, true);
assert.ok(pooledLights.every((light) => light.intensity === 0), 'unused slots switch off');
assert.equal(lights.lightAt(0, 2.9, 0), 0.05, 'empty pool retains the ambient floor');
lights.add('near', Array.from({ length: 12 }, (_, i) => fixture(i * 0.01)));
lights.add('unassigned', [fixture(20)]);
lights.update(0, 0, 0, true);
assert.equal(lights.lightAt(20, 2.9, 0), 0.05, 'unassigned fixtures cannot illuminate video ghosts');
lights.remove('near');
lights.update(0, 0, 0, true);
assert.ok(lights.lightAt(20, 2.9, 0) > 0.05 && lights.lightAt(20, 2.9, 0) < 1,
  'assigned light sampling includes the player-distance fade');

// Exercise the real streaming method with builders replaced by counters to isolate
// its boundary/retention behavior from canvas textures and ghost initialization.
class CountedSet extends Set {
  checks = 0;
  has(key) { this.checks++; return super.has(key); }
}
const world = Object.create(EndlessWorld.prototype);
world.loadedNodes = new CountedSet();
world.streamedNodeI = NaN;
world.streamedNodeJ = NaN;
world.lastValid = new THREE.Vector3();
let builds = 0;
let removals = 0;
world.buildJunctionPiece = () => builds++;
world.buildCorridorPiece = () => {};
world.removePiece = () => removals++;
world.stream(0, 0);
assert.equal(builds, 13, 'initial stream builds the Manhattan radius of two');
const initialChecks = world.loadedNodes.checks;
for (let i = 0; i < 100; i++) world.stream(GRID / 2 - 0.01, 0);
assert.equal(world.loadedNodes.checks, initialChecks, 'movement inside one node performs no loaded-node scans');
assert.equal(builds, 13);
world.stream(GRID / 2 + 0.01, 0);
assert.equal(builds, 18, 'crossing the nearest-node boundary creates five new junctions');
assert.equal(removals, 0, 'keep radius retains the previous boundary');
world.teleport(new THREE.Vector3(), GRID * -8, GRID * 6);
assert.equal(world.loadedNodes.size, 13, 'distant teleport rebuilds and prunes the streamed area');
assert.equal(world.streamedNodeI, -8);
assert.equal(world.streamedNodeJ, 6);
assert.ok(removals > 0, 'distant pieces are disposed after teleport');
// A streamed-out doorway releases its independent fade material once, retaining cached eye geometry.
const eyeWorld = Object.create(EndlessWorld.prototype);
const eyeRoot = new THREE.Group();
const eyeDoor = makeSwingDoor(new THREE.MeshBasicMaterial(), false);
eyeDoor.setEyes(true);
eyeRoot.add(eyeDoor.group);
const eyeMeshes = eyeDoor.group.getObjectByName('door-eyes').children;
let materialDisposals = 0;
let geometryDisposals = 0;
eyeMeshes[0].material.addEventListener('dispose', () => materialDisposals++);
eyeMeshes[0].geometry.addEventListener('dispose', () => geometryDisposals++);
eyeWorld.scene = new THREE.Scene();
eyeWorld.scene.add(eyeRoot);
eyeWorld.pieces = new Map([['eyes', { key: 'eyes', root: eyeRoot }]]);
eyeWorld.haunts = { onCellDisposed() {} };
eyeWorld.anomalies = { removePiece() {} };
eyeWorld.posters = { removePiece() {} };
eyeWorld.lights = { remove() {} };
eyeWorld.removePiece('eyes');
assert.equal(materialDisposals, 1);
assert.equal(geometryDisposals, 0);
assert.equal(eyeWorld.pieces.size, 0);
console.log('World performance regressions passed: light slots, streaming, teleport and eye-material cleanup.');
