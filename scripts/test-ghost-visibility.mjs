import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

// Exercise the actual TypeScript classes without requiring a browser or GPU.
// Video decoding, canvas painting and unrelated world/audio services are boundary mocks.
const documentMock = {
  createElement(tag) {
    if (tag === 'video') return {
      readyState: 2, paused: true,
      addEventListener() {}, setAttribute() {}, load() {},
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
    };
    return { getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }), fillRect() {},
    }) };
  },
};

function loadTs(path, mocks) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (name === 'three') return THREE;
    if (name in mocks) return mocks[name];
    throw new Error(`Unmocked dependency: ${name}`);
  };
  new Function('require', 'module', 'exports', 'document', 'window', 'location', output)(
    require, module, module.exports, documentMock, { addEventListener() {} }, { search: '' },
  );
  return module.exports;
}

class FallbackFigure {
  root = new THREE.Group();
  update() {}
}
const { ClipEntry } = loadTs('src/ghost/VideoClipPool.ts', { './clips': { GHOST_CLIPS: [] } });
const { VideoGhost } = loadTs('src/ghost/VideoGhost.ts', {
  '../world/GhostFigure': { GhostFigure: FallbackFigure },
  './clips': { clipForRole: () => undefined },
});
const { Haunts } = loadTs('src/world/Haunts.ts', {
  '../audio/GhostVoice': { pickVoiceKind: () => 'croak' },
  '../ghost/clips': {}, '../ghost/VideoGhost': { VideoGhost },
  './Lighting': { LIGHT_FULL: 1 }, './Maze': {},
  './Textures': { rand: (low) => low },
});
const cameraPos = new THREE.Vector3(0, 1.62, 10);

function makeGhost() {
  const entry = new ClipEntry('/test.mp4', true);
  const clip = { src: '/test.mp4', frameHeightM: 1.8, aspect: 0.5, footV: 0 };
  const ghost = new VideoGhost('peeking', { get: () => entry }, { clip });
  return { entry, ghost };
}

function makeHaunt(kind = 'peek') {
  const { entry, ghost } = makeGhost();
  const scene = new THREE.Scene();
  scene.add(ghost.root);
  const manager = new Haunts(scene, { playFootstep() {} }, {}, { lightAt: () => 0.3 }, {});
  manager.center = () => new THREE.Vector3(0, 1, -10);
  manager.flatDist = () => 10;
  manager.isSeen = () => true;
  manager.presenceVoice = () => {};
  const haunt = {
    kind, ghost, seenTime: 0, unseenTime: 0, loadingTime: 0, everSeen: false,
    moved: 0, minDist: Infinity, voiceTimer: 2, peekDir: { x: 1, z: 0 },
  };
  manager.active = haunt;
  return { entry, ghost, manager, haunt };
}

test('stacked mask is uploaded as data, without sRGB decoding', () => {
  const entry = new ClipEntry('/test.mp4', true);
  assert.equal(entry.texture.colorSpace, THREE.NoColorSpace);
});

test('a cached frame receives a display update before encounters are enabled', () => {
  const { entry, ghost } = makeGhost();
  entry.ready = true;
  assert.equal(ghost.ready, false);
  ghost.update(0.1, 1, { cameraPos, light: 0.3 });
  assert.equal(ghost.ready, true);
  ghost.dispose();
  assert.equal(ghost.ready, false);
});

test('failed video can switch to a ready fallback instead of blocking forever', () => {
  const { entry, ghost } = makeGhost();
  entry.failed = true;
  assert.equal(ghost.ready, false);
  ghost.update(0.1, 1, { cameraPos, light: 0.3 });
  assert.equal(ghost.ready, true);
  assert.equal(entry.inUse, false);
  ghost.dispose();
});

test('ghost fill has an ambient floor, fades with distance, and cannot overexpose', () => {
  const { entry, ghost } = makeGhost();
  entry.ready = true;
  const brightnessAt = (distance, light = 0) => {
    ghost.update(0.1, 1, { cameraPos: new THREE.Vector3(0, 0, distance), light });
    return ghost.body.children[0].material.uniforms.uLight.value;
  };
  assert.equal(brightnessAt(10), 0.16);
  assert.ok(Math.abs(brightnessAt(1) - 0.3) < 1e-12);
  assert.ok(brightnessAt(3) > brightnessAt(5));
  assert.equal(brightnessAt(1, 1), 1);
  ghost.dispose();
});

test('slow-loading peek does not count observation or retreat before its frame is ready', () => {
  const { entry, ghost, manager, haunt } = makeHaunt();
  for (let i = 0; i < 20; i++) manager.step(haunt, 0.1, i / 10, false);
  assert.equal(haunt.seenTime, 0);
  assert.equal(haunt.everSeen, false);
  assert.equal(haunt.moved, 0);
  entry.ready = true;
  manager.step(haunt, 0.1, 2, false); // first frame gets its display opportunity
  assert.equal(haunt.everSeen, false);
  for (let i = 0; i < 5; i++) manager.step(haunt, 0.1, 2.1 + i / 10, false);
  assert.equal(haunt.everSeen, true);
  assert.ok(haunt.moved > 0);
  ghost.dispose();
});

test('loading approach cannot trigger a point-blank encounter', () => {
  const { ghost, manager, haunt } = makeHaunt('approach');
  manager.flatDist = () => 0.5;
  manager.updateApproach = () => assert.fail('Invisible ghost entered encounter behavior');
  manager.step(haunt, 0.1, 0.1, false);
  assert.equal(haunt.everSeen, false);
  ghost.dispose();
});

test('a stalled load releases its slot with a retry cooldown', () => {
  const { entry, manager, haunt } = makeHaunt();
  for (let i = 0; i < 13; i++) manager.step(haunt, 1, i, false);
  assert.equal(haunt.ghost, null);
  assert.equal(manager.active, null);
  assert.equal(entry.inUse, false);
  assert.ok(manager.cooldown >= 3);
});

test('a loading haunt is not swapped away before it can display', () => {
  const { ghost, manager, haunt } = makeHaunt();
  manager.inFront = () => false;
  manager.candidates = () => assert.fail('Loading ghost was considered for replacement');
  manager.maybeSwapToFront();
  assert.equal(manager.active, haunt);
  ghost.dispose();
});
