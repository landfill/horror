import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

// Test the real scheduler, with visibility rays and audio as external boundaries.
function scheduler(search = '') {
  const source = readFileSync(new URL('../src/world/Anomalies.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (name === 'three') return THREE;
    if (name === './Maze') return { hasLineOfSight: () => true };
    if (name === './Textures') return { pick: (items) => items[0], rand: (low) => low };
    throw new Error(`Unexpected runtime dependency ${name}`);
  };
  new Function('require', 'module', 'exports', 'location', output)(require, module, module.exports, { search });
  const sounds = [];
  const sound = {
    playCreak: (...args) => sounds.push(['creak', ...args]),
    playFootstep: (...args) => sounds.push(['wetstep', ...args]),
  };
  const app = new module.exports.Anomalies(sound, { killFarthestBehind: () => false });
  return { app, sounds };
}

const here = new THREE.Vector3(0, 1.62, 0);
const north = new THREE.Vector3(0, 0, -1);
const south = new THREE.Vector3(0, 0, 1);
const identity = (x, z) => ({ x, z });

function prepare() {
  const { app, sounds } = scheduler();
  const applied = [];
  app.add('room', [{
    x: 0, z: -6, kind: 'room404', safetyPoints: [{ x: 1, z: -6 }],
    stages: [
      { apply: () => applied.push('door'), sound: 'creak' },
      { apply: () => applied.push('shoes'), delay: 12 },
    ],
  }], identity);
  // Existing one-scan seen rule remains sufficient; no dwell/light condition.
  app.update(0.01, here, north, false);
  assert.equal(app.spots[0].seen, true);
  app.timer = 0;
  app.update(0.01, here, south, false);
  assert.deepEqual(applied, ['door']);
  return { app, sounds, applied };
}

test('a story continues after its delay without a new observation and plays each cue once', () => {
  const { app, sounds, applied } = prepare();
  app.update(11, here, south, false);
  assert.deepEqual(applied, ['door']);
  app.update(1, here, south, false);
  assert.deepEqual(applied, ['door', 'shoes']);
  assert.equal(app.pending, null);
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0][0], 'creak');
  app.update(90, here, south, false);
  assert.deepEqual(applied, ['door', 'shoes'], 'finished story cannot replay');
});

test('a visible safety point blocks the next step even when its anchor is behind', () => {
  const { app, applied } = prepare();
  app.spots[0].safetyPoints.push({ x: 0, z: 7 });
  app.update(12, here, south, false);
  assert.deepEqual(applied, ['door']);
  app.spots[0].safetyPoints.pop();
  app.update(0.3, here, south, false);
  assert.deepEqual(applied, ['door', 'shoes']);
});

test('changes stay away from the viewer and wait while the object is in view', () => {
  const { app, applied } = prepare();
  app.update(12, here, north, false);
  assert.deepEqual(applied, ['door']);
  const tooClose = new THREE.Vector3(0, 1.62, -5);
  app.update(1, tooClose, south, false);
  assert.deepEqual(applied, ['door']);
  app.update(0.3, here, south, false);
  assert.deepEqual(applied, ['door', 'shoes']);
});

test('ghost presence and the following quiet period suspend the story', () => {
  const { app, applied } = prepare();
  app.update(20, here, south, true);
  app.update(14, here, south, false);
  assert.deepEqual(applied, ['door']);
  app.update(1, here, south, false);
  assert.deepEqual(applied, ['door']);
  app.update(11, here, south, false);
  assert.deepEqual(applied, ['door', 'shoes']);
});

test('disposing a piece cancels callbacks and audio for its pending story', () => {
  const { app, applied, sounds } = prepare();
  app.removePiece('room');
  assert.equal(app.pending, null);
  app.update(100, here, south, false);
  assert.deepEqual(applied, ['door']);
  assert.equal(sounds.length, 1);
});

test('leaving a story releases its slot and keeps the first change', () => {
  const { app, applied } = prepare();
  const away = new THREE.Vector3(0, 1.62, 30);
  app.update(1, away, south, false);
  assert.equal(app.pending, null);
  assert.deepEqual(applied, ['door']);
  app.add('next', [{ x: 0, z: 24, kind: 'chair', apply: () => applied.push('chair') }], identity);
  app.update(0.3, away, north, false);
  app.timer = 0;
  app.update(0.3, away, south, false);
  assert.deepEqual(applied, ['door', 'chair']);
});

test('all safety points follow the same translation and rotation as an east corridor', () => {
  const { app } = scheduler();
  app.add('east', [{ x: 1, z: -6, kind: 'footsteps', safetyPoints: [{ x: -1, z: -5 }] }],
    (x, z) => ({ x: 21.2 - z, z: 42.4 + x }));
  assert.deepEqual({ x: app.spots[0].x, z: app.spots[0].z }, { x: 27.2, z: 43.4 });
  assert.deepEqual(app.spots[0].safetyPoints, [{ x: 26.2, z: 41.4 }]);
});

test('legacy single-step anomalies retain their observation and one-shot behavior', () => {
  const { app } = scheduler();
  let count = 0;
  app.add('legacy', [{ x: 0, z: -6, kind: 'chair', apply: () => count++ }], identity);
  app.timer = 0;
  app.update(0.3, here, south, false);
  assert.equal(count, 0, 'unseen legacy prop stays unchanged');
  app.update(0.3, here, north, false);
  app.timer = 0;
  app.update(0.3, here, south, false);
  assert.equal(count, 1);
  assert.equal(app.pending, null);
});

test('a story holds the event slot and wet steps are emitted only on their designated stage', () => {
  const { app, sounds } = scheduler();
  let steps = 0;
  let other = 0;
  app.add('prints', [{ x: 0, z: -6, kind: 'footsteps', stages: [
    { apply: () => steps++, sound: 'wetstep' },
    { apply: () => steps++, delay: 12 },
  ] }, { x: 1, z: -6, kind: 'chair', apply: () => other++ }], identity);
  app.update(0.1, here, north, false);
  app.timer = 0;
  app.update(0.1, here, south, false);
  app.timer = 0;
  app.update(5, here, south, false);
  assert.equal(other, 0);
  app.update(7, here, south, false);
  assert.equal(steps, 2);
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0][0], 'wetstep');
  assert.equal(sounds[0][1], true);
});

function movingRoom() {
  const { app, sounds } = scheduler();
  const events = [];
  let elapsed = 0;
  let moving = false;
  let updates = 0;
  app.add('moving-room', [{ x: 0, z: -6, kind: 'room404', animatedDoor: true,
    motionDuration: 2.8,
    update: (dt) => { updates++; if (moving) elapsed += dt; moving = moving && elapsed < 2.8; return moving; },
    stages: [
      { apply: () => { moving = true; events.push('open'); }, sound: 'creak', duration: 2.8 },
      { apply: () => events.push('shoes'), delay: 14 },
    ],
  }], identity);
  app.update(0.01, here, north, false);
  app.doorTimer = 0;
  app.update(0.01, here, north, false);
  return { app, sounds, events, elapsed: () => elapsed, updates: () => updates };
}

test('door opening can begin in view and its creak lasts for the motion', () => {
  const { app, sounds, events, elapsed } = movingRoom();
  assert.deepEqual(events, ['open']);
  assert.equal(app.hasMovingDoor, true);
  assert.equal(elapsed(), 0, 'triggering does not jump ahead in the motion');
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0][3], 2.8);
  app.update(0.7, here, north, false);
  assert.equal(elapsed(), 0.7);
  assert.equal(app.hasMovingDoor, true);
  app.update(2.2, here, north, true);
  assert.equal(app.hasMovingDoor, false, 'an existing motion completes even during ghost presence');
  assert.deepEqual(events, ['open']);
  assert.equal(sounds.length, 1, 'continuous motion does not repeatedly start the sound');
});

test('slippers wait until the door has finished before counting their delay', () => {
  const { app, events } = movingRoom();
  app.update(2.5, here, south, false);
  assert.equal(app.pending.wait, 14);
  assert.deepEqual(events, ['open']);
  app.update(0.5, here, south, false);
  app.update(13, here, south, false);
  assert.deepEqual(events, ['open']);
  app.update(1, here, south, false);
  assert.deepEqual(events, ['open', 'shoes']);
});

test('disposing a moving door removes it from frame updates', () => {
  const { app, updates } = movingRoom();
  app.update(0.5, here, north, false);
  const before = updates();
  app.removePiece('moving-room');
  app.update(10, here, north, false);
  assert.equal(updates(), before);
  assert.equal(app.hasMovingDoor, false);
  assert.equal(app.pending, null);
});

test('nearby doors open on the shorter door clock without speeding up other anomalies', () => {
  const { app } = scheduler();
  const opened = [];
  let other = 0;
  const door = (z) => {
    let remaining = 0;
    return { x: 0, z, kind: 'door', animatedDoor: true, opening: true, motionDuration: 2.8,
      apply: () => { opened.push(z); remaining = 2.8; },
      update: (dt) => { remaining -= dt; return remaining > 0; },
    };
  };
  app.add('doors', [door(-6), door(-8), { x: 1, z: -6, kind: 'chair', apply: () => other++ }], identity);
  app.update(0.01, here, north, false);
  app.doorTimer = 0;
  app.update(0.01, here, north, false);
  assert.deepEqual(opened, [-6], 'nearest door is selected');
  app.update(3, here, north, false);
  app.update(8, here, north, false);
  assert.deepEqual(opened, [-6]);
  app.update(1, here, north, false);
  assert.deepEqual(opened, [-6, -8], 'next eligible door starts at the 12s minimum');
  assert.equal(other, 0);
});

test('waiting for slippers offscreen does not block another ordinary door from opening', () => {
  const { app, events } = movingRoom();
  let otherOpened = false;
  let remaining = 0;
  app.add('other-door', [{ x: 1, z: -8, kind: 'door', animatedDoor: true, opening: true,
    apply: () => { otherOpened = true; remaining = 2.8; },
    update: (dt) => { remaining -= dt; return remaining > 0; },
  }], identity);
  app.update(3, here, north, false);
  app.update(14, here, north, false);
  assert.equal(otherOpened, true);
  assert.deepEqual(events, ['open'], 'slippers still wait while they are visible');
  assert.equal(app.pending.spot.piece, 'moving-room', 'the original follow-up is not overwritten');
});
