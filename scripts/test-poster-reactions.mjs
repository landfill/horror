import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

const source = readFileSync(new URL('../src/world/PosterReactions.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture() {
  const cache = new Map();
  let requests = 0;
  let visible = true;
  const poster = (v, frame = 'neutral') => {
    requests++;
    const key = `${v}:${frame}`;
    if (!cache.has(key)) { const mat = new THREE.MeshBasicMaterial(); mat.name = key; cache.set(key, mat); }
    return cache.get(key);
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    if (name === 'three') return THREE;
    if (name === './Textures') return { Mat: { poster } };
    if (name === './Maze') return { hasLineOfSight: () => visible };
    throw new Error(name);
  }, module, module.exports);
  const controller = new module.exports.PosterReactions();
  const spec = (z = -2, variant = 0) => ({ x: -1.55, y: 1.5, z, normalX: 1, normalZ: 0,
    variant, mesh: new THREE.Mesh(new THREE.PlaneGeometry(.48, .66), poster(variant)) });
  return { controller, spec, cache, requests: () => requests, setVisibility: (v) => visible = v };
}
const identity = (x, z) => ({ x, z });
const position = new THREE.Vector3(0, 1.62, 0);
const forward = new THREE.Vector3(0, 0, -1);
function withRandom(values, fn) {
  const random = Math.random;
  let index = 0;
  Math.random = () => values[Math.min(index++, values.length - 1)];
  try { return fn(() => index); } finally { Math.random = random; }
}

test('passing selects only one nearby poster and blink returns to the neutral image', () => {
  const { controller, spec, requests } = fixture();
  const a = spec(); const b = spec(-2.8);
  controller.add('row', [a, b], identity);
  const original = a.mesh.material;
  const prepared = requests();
  withRandom([0, 0, 0], () => controller.update(.15, position, forward, true));
  assert.equal(controller.count, 1);
  assert.equal(a.mesh.material.name, '0:blink-half');
  assert.equal(b.mesh.material, original, 'shared neutral material does not animate the whole row');
  controller.update(.09, position, forward, false);
  assert.equal(a.mesh.material.name, '0:blink');
  controller.update(.13, position, forward, false);
  assert.equal(a.mesh.material.name, '0:blink', 'closed eyelids remain visible long enough while passing');
  controller.update(.24, position, forward, false);
  assert.equal(a.mesh.material.name, '0:blink-half');
  controller.update(.3, position, forward, false);
  assert.equal(a.mesh.material, original);
  assert.equal(controller.isReacting, false);
  assert.equal(requests(), prepared, 'animation creates no new materials or textures');
});

test('a missed lottery is not retried until the visitor leaves and returns', () => {
  const { controller, spec } = fixture();
  controller.add('one', [spec()], identity);
  withRandom([.9], (calls) => {
    for (let i = 0; i < 80; i++) controller.update(.2, position, forward, true);
    assert.equal(calls(), 1);
    assert.equal(controller.count, 0);
  });
  controller.update(.2, new THREE.Vector3(0, 1.62, 8), forward, true);
  withRandom([0, 0, 0], () => controller.update(.2, position, forward, true));
  assert.equal(controller.count, 1);
});

test('standing still cannot start a reaction and global cooldown prevents adjacent retriggers', () => {
  const { controller, spec } = fixture();
  controller.add('row', [spec(), spec(-2.5)], identity);
  withRandom([0, 0, 0], () => {
    controller.update(20, position, forward, false);
    assert.equal(controller.count, 0);
    controller.update(.2, position, forward, true);
    assert.equal(controller.count, 1);
    controller.update(.5, position, forward, true);
    controller.update(5, position, forward, true);
    assert.equal(controller.count, 1);
  });
});

test('smile reaches its peak early and returns without changing other posters', () => {
  const { controller, spec } = fixture();
  const a = spec(); const b = spec(-3);
  controller.add('row', [a, b], identity);
  const neutral = a.mesh.material;
  assert.equal(controller.preview(a.mesh, 'smile'), true);
  assert.equal(controller.preview(b.mesh, 'blink'), false);
  controller.update(.25, position, forward, false);
  assert.equal(a.mesh.material.name, '0:smile');
  assert.equal(b.mesh.material, neutral);
  controller.update(1.3, position, forward, false);
  assert.equal(a.mesh.material.name, '0:smile-half');
  controller.update(.5, position, forward, false);
  assert.equal(a.mesh.material, neutral);
});

test('a poster changed by another anomaly is never overwritten by expression cleanup', () => {
  const { controller, spec } = fixture();
  const a = spec();
  controller.add('one', [a], identity);
  controller.preview(a.mesh, 'blink');
  const back = new THREE.MeshBasicMaterial();
  a.mesh.material = back;
  controller.update(1, position, forward, true);
  assert.equal(a.mesh.material, back);
  assert.equal(controller.isReacting, false);
  assert.equal(controller.preview(a.mesh, 'smile'), false);
  controller.removePiece('one');
  assert.equal(a.mesh.material, back);
});

test('streaming out an active piece restores its owned frame and stops future updates', () => {
  const { controller, spec } = fixture();
  const a = spec(); const neutral = a.mesh.material;
  controller.add('one', [a], identity);
  controller.preview(a.mesh, 'smile');
  controller.removePiece('one');
  assert.equal(a.mesh.material, neutral);
  assert.equal(controller.isReacting, false);
  controller.update(30, position, forward, true);
  assert.equal(controller.count, 1);
  assert.equal(controller.preview(a.mesh, 'blink'), false);
});

test('walls and the back of a poster prevent triggering without consuming the visit', () => {
  const { controller, spec, setVisibility } = fixture();
  const a = spec();
  controller.add('one', [a], identity);
  withRandom([0, 0, 0], () => {
    setVisibility(false);
    controller.update(.2, position, forward, true);
    assert.equal(controller.count, 0);
    setVisibility(true);
    controller.update(.2, new THREE.Vector3(-2, 1.62, 0), forward, true);
    assert.equal(controller.count, 0);
    controller.update(.2, position, forward, true);
    assert.equal(controller.count, 1);
  });
});

test('poster positions and front normals rotate together in east corridors', () => {
  const { controller, spec } = fixture();
  const a = spec();
  controller.add('east', [a], (x, z) => ({ x: 20 - z, z: 40 + x }));
  withRandom([0, 0, 0], () => controller.update(.2, new THREE.Vector3(22, 1.62, 40), new THREE.Vector3(0, 0, -1), true));
  assert.equal(controller.count, 1);
});

test('the actual camera viewport prevents an offscreen blink on narrow screens', () => {
  const { controller, spec } = fixture();
  controller.add('one', [spec()], identity);
  const camera = new THREE.PerspectiveCamera(64, .5, .08, 36);
  camera.position.copy(position);
  withRandom([0, 0, 0], () => {
    controller.update(.2, position, forward, true, camera);
    assert.equal(controller.count, 0);
    camera.lookAt(-1.55, 1.5, -2);
    controller.update(.2, position, forward, true, camera);
    assert.equal(controller.count, 1, 'turning to a still-eligible poster can reveal the passing reaction');
  });
});

test('repeated corridor streaming keeps a bounded frame cache and drops removed registrations', () => {
  const { controller, spec, cache } = fixture();
  let disposed = 0;
  for (let i = 0; i < 32; i++) {
    const item = spec(-2, i % 4);
    controller.add(`piece-${i}`, [item], identity);
    for (const material of cache.values()) {
      if (!material.userData.watched) {
        material.userData.watched = true;
        material.addEventListener('dispose', () => disposed++);
      }
    }
    controller.preview(item.mesh, 'smile');
    controller.removePiece(`piece-${i}`);
    assert.equal(controller.posters.length, 0);
    assert.equal(controller.isReacting, false);
  }
  assert.equal(cache.size, 20, 'only four identities times five cached frames');
  assert.equal(disposed, 0, 'streaming never disposes a shared frame material');
});
