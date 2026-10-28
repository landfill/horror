import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/audio/SoundManager.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', output)(() => ({}), module, module.exports);
const { SoundManager } = module.exports;

class Parameter {
  events = [];
  setValueAtTime(value, time) { this.events.push({ method: 'set', value, time }); }
  linearRampToValueAtTime(value, time) { this.events.push({ method: 'linear', value, time }); }
  exponentialRampToValueAtTime(value, time) { this.events.push({ method: 'exponential', value, time }); }
}

class AudioNodeMock {
  frequency = new Parameter();
  gain = new Parameter();
  Q = new Parameter();
  positionX = new Parameter();
  positionY = new Parameter();
  positionZ = new Parameter();
  connections = [];
  disconnected = false;
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnected = true; }
  start(time) { this.startedAt = time; }
  stop(time) { this.stoppedAt = time; }
}

function setup() {
  const nodes = [];
  const create = (kind) => {
    const node = new AudioNodeMock();
    node.kind = kind;
    nodes.push(node);
    return node;
  };
  const manager = new SoundManager();
  manager.ctx = {
    currentTime: 10,
    createPanner: () => create('panner'),
    createOscillator: () => create('oscillator'),
    createBiquadFilter: () => create('filter'),
    createGain: () => create('gain'),
  };
  manager.masterGain = new AudioNodeMock();
  manager.fxBus = new AudioNodeMock();
  const subtitles = [];
  manager.setSubtitleHandler((label) => subtitles.push(label));
  return { manager, nodes, subtitles };
}

test('door creak sustains through 2.8 seconds with gentle ends and spatial position', () => {
  const { manager, nodes, subtitles } = setup();
  manager.playCreak({ x: 2, y: 1, z: -5 }, '[문이 천천히 열림]', 2.8);
  const oscillators = nodes.filter((node) => node.kind === 'oscillator');
  assert.equal(oscillators.length, 2);
  for (const node of oscillators) {
    assert.equal(node.startedAt, 10);
    assert.equal(node.stoppedAt, 12.8);
  }
  const envelope = nodes.filter((node) => node.kind === 'gain').at(-1).gain.events;
  assert.deepEqual(envelope[0], { method: 'set', value: 0, time: 10 });
  assert.deepEqual(envelope.at(-1), { method: 'linear', value: 0, time: 12.8 });
  assert.ok(envelope.some((event) => event.time > 12 && event.value >= 0.1), 'audible near end of motion');
  assert.ok(envelope.every((event, index) => index === 0 || event.time > envelope[index - 1].time));
  const panner = nodes.find((node) => node.kind === 'panner');
  assert.deepEqual(panner.positionZ.events, [{ method: 'set', value: -5, time: 10 }]);
  assert.deepEqual(subtitles, ['[문이 천천히 열림]']);
});

test('duration omitted preserves the short ambience envelope', () => {
  const { manager, nodes, subtitles } = setup();
  manager.playCreak();
  const carrier = nodes.find((node) => node.kind === 'oscillator');
  assert.ok(carrier.stoppedAt >= 10.85 && carrier.stoppedAt <= 11.45);
  const envelope = nodes.filter((node) => node.kind === 'gain').at(-1).gain.events;
  assert.equal(envelope[1].value, 0.22);
  assert.equal(envelope[1].time, 10.08);
  assert.equal(envelope.at(-1).method, 'exponential');
  assert.deepEqual(subtitles, ['[문이 끼익거림]']);
});

test('finished spatial creak disconnects private nodes and preserves shared reverb bus', () => {
  const { manager, nodes } = setup();
  manager.playCreak({ x: 0, y: 1, z: -3 }, undefined, 2.8);
  nodes.find((node) => node.kind === 'oscillator').onended();
  assert.ok(nodes.every((node) => node.disconnected));
  assert.equal(manager.fxBus.disconnected, false);
  assert.equal(manager.masterGain.disconnected, false);
});

test('finished nonspatial creak never disconnects the shared destination', () => {
  const { manager, nodes } = setup();
  manager.fxBus = null; // Also exercise the master-gain fallback.
  manager.playCreak(undefined, undefined, 2.8);
  nodes.find((node) => node.kind === 'oscillator').onended();
  assert.ok(nodes.every((node) => node.disconnected));
  assert.equal(manager.masterGain.disconnected, false);
});

test('muted or uninitialized sound creates neither nodes nor subtitles', () => {
  const { manager, nodes, subtitles } = setup();
  manager.isMuted = true;
  manager.playCreak(undefined, undefined, 2.8);
  manager.isMuted = false;
  manager.ctx = null;
  manager.playCreak(undefined, undefined, 2.8);
  assert.equal(nodes.length, 0);
  assert.equal(subtitles.length, 0);
});

test('invalid duration falls back to safe ambience scheduling', () => {
  for (const duration of [NaN, Infinity, -1, 0]) {
    const { manager, nodes } = setup();
    manager.playCreak(undefined, undefined, duration);
    const carrier = nodes.find((node) => node.kind === 'oscillator');
    assert.ok(carrier.stoppedAt >= 10.85 && carrier.stoppedAt <= 11.45);
  }
});
