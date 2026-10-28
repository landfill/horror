import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

// Test the real builders/transform callbacks; canvas painting is the only mocked boundary.
const materials = new Map();
const Mat = new Proxy({}, { get: (_, name) => (...args) => {
  const key = `${name}:${JSON.stringify(args)}`;
  if (!materials.has(key)) {
    const material = new THREE.MeshLambertMaterial();
    material.name = key;
    materials.set(key, material);
  }
  return materials.get(key);
} });
const textures = {
  Mat, POSTER_VARIANTS: 4, VARIANT_COUNT: 4,
  rand: (a, b) => a + Math.random() * (b - a),
  pick: (items) => items[Math.floor(Math.random() * items.length)],
  variantOf: (material) => material,
  signMaterial: () => Mat.sign(),
};
function loadTs(path, mocks, search = '') {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'location', output)(
    (name) => {
      if (name === 'three') return THREE;
      if (name in mocks) return mocks[name];
      throw new Error(`Unexpected dependency ${name}`);
    }, module, module.exports, { search },
  );
  return module.exports;
}
const maze = loadTs('src/world/Maze.ts', {});
const props = loadTs('src/world/Props.ts', { './Textures': textures, './Maze': maze });
const stories = loadTs('src/world/StoryProps.ts', { './Props': props, './Textures': textures, './Maze': maze });
function builder(search) {
  return loadTs('src/world/CorridorBuilder.ts', {
    './Props': props, './Textures': textures, './Maze': maze, './StoryProps': stories,
  }, search);
}
function objectCount(root) {
  let count = 0;
  root.traverse(() => count++);
  return count;
}
function seeded(seed, fn) {
  const random = Math.random;
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
  try { return fn(); } finally { Math.random = random; }
}

test('404 story opens the closed door, then turns existing slippers outwards on both walls', () => {
  for (const side of [-1, 1]) {
    const group = new THREE.Group();
    const door = props.makeSwingDoor(Mat.door(), true);
    group.add(door.group);
    const spot = stories.addRoom404Story(group, door, side, -7.8);
    const shoes = group.getObjectByName('room404-slippers');
    const facing = () => new THREE.Vector3(0, 0, 1).applyEuler(shoes.rotation).x;
    const count = objectCount(group);
    assert.equal(door.isOpen(), false);
    assert.ok(facing() * side > 0.99, 'slippers initially point into the door');
    assert.equal(shoes.visible, true);
    spot.stages[0].apply();
    assert.equal(door.isOpen(), true);
    assert.equal(spot.animatedDoor, true);
    assert.equal(spot.opening, true);
    assert.equal(spot.stages[0].duration, props.DOOR_MOTION_SEC);
    const hinge = door.group.getObjectByName('door-hinge');
    assert.equal(hinge.rotation.y, 0, 'the first stage starts motion without snapping');
    assert.equal(spot.update(props.DOOR_MOTION_SEC / 2), true);
    const middleAngle = hinge.rotation.y;
    assert.ok(middleAngle > 0 && middleAngle < 0.3);
    assert.equal(spot.update(props.DOOR_MOTION_SEC / 2), false);
    assert.ok(hinge.rotation.y > middleAngle);
    assert.ok(facing() * side > 0.99, 'opening the door does not also turn slippers');
    spot.stages[1].apply();
    assert.ok(facing() * side < -0.99);
    assert.equal(door.group.userData.stage, 2);
    assert.equal(objectCount(group), count, 'stages reuse existing objects');
  }
});

test('swing doors animate one stable leaf with eased motion and immediate initial placement', () => {
  const door = props.makeSwingDoor(Mat.door(), true);
  const hinge = door.group.getObjectByName('door-hinge');
  const leaf = door.group.getObjectByName('door-leaf');
  const geometry = leaf.geometry;
  const material = leaf.material;
  const openAngle = hinge.rotation.y;
  const count = objectCount(door.group);
  assert.ok(openAngle >= 0.3 && openAngle <= 0.42);
  assert.equal(door.isMoving(), false);
  door.setOpen(false);
  assert.equal(hinge.rotation.y, 0);
  assert.equal(door.update(1), false);
  door.animateTo(true);
  assert.equal(door.isOpen(), true, 'isOpen reports the target state');
  assert.equal(hinge.rotation.y, 0);
  assert.equal(door.update(props.DOOR_MOTION_SEC * 0.1), true);
  assert.ok(hinge.rotation.y > 0 && hinge.rotation.y < openAngle * 0.1, 'motion starts slowly');
  assert.equal(door.update(props.DOOR_MOTION_SEC * 0.4), true);
  assert.ok(Math.abs(hinge.rotation.y - openAngle * 0.5) < 1e-12);
  const middleAngle = hinge.rotation.y;
  door.animateTo(true);
  assert.equal(door.update(props.DOOR_MOTION_SEC * 0.5), false, 'repeated target does not restart motion');
  assert.ok(hinge.rotation.y > middleAngle);
  assert.equal(hinge.rotation.y, openAngle);
  assert.equal(door.isMoving(), false);
  assert.equal(leaf.visible, true);
  assert.equal(hinge.visible, true);
  assert.equal(leaf.geometry, geometry);
  assert.equal(leaf.material, material);
  assert.equal(objectCount(door.group), count);
  door.group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(leaf);
  assert.ok(bounds.min.z > 0, 'the moving leaf stays in front of its supporting wall');
  assert.ok(bounds.max.z < 0.48, 'the opened leaf keeps its narrow corridor footprint');
});

test('door reversal and immediate setOpen do not teleport or leave an animation running', () => {
  const door = props.makeSwingDoor(Mat.door(), false);
  const hinge = door.group.getObjectByName('door-hinge');
  door.animateTo(true);
  door.update(props.DOOR_MOTION_SEC / 2);
  const middleAngle = hinge.rotation.y;
  door.animateTo(false);
  assert.equal(hinge.rotation.y, middleAngle);
  assert.equal(door.isOpen(), false);
  assert.equal(door.update(0), true);
  assert.equal(door.update(NaN), true);
  assert.equal(hinge.rotation.y, middleAngle);
  door.update(props.DOOR_MOTION_SEC / 2);
  assert.ok(hinge.rotation.y > 0 && hinge.rotation.y < middleAngle);
  door.setOpen(true);
  assert.equal(door.isMoving(), false);
  assert.equal(door.update(100), false);
});

test('sliding closets reuse their panel while opening and closing gradually', () => {
  const door = props.makeSlidingCloset(1.6, false);
  const panel = door.group.getObjectByName('closet-moving-panel');
  const count = objectCount(door.group);
  assert.equal(panel.position.x, -0.4);
  door.animateTo(true);
  assert.equal(panel.position.x, -0.4);
  assert.equal(door.update(props.DOOR_MOTION_SEC / 2), true);
  assert.ok(Math.abs(panel.position.x) < 1e-12);
  assert.equal(door.update(props.DOOR_MOTION_SEC / 2), false);
  assert.equal(panel.position.x, 0.4);
  door.animateTo(false);
  door.update(props.DOOR_MOTION_SEC);
  assert.equal(panel.position.x, -0.4);
  assert.equal(objectCount(door.group), count);
});

test('wet footprint pairs extend from the door, stay inside the corridor, and share GPU resources', () => {
  for (const side of [-1, 1]) {
    const group = new THREE.Group();
    const spot = stories.addFootstepStory(group, side, -7.8);
    const trail = group.getObjectByName('footsteps-trail');
    const [incoming, first, second] = trail.children;
    const count = objectCount(group);
    assert.deepEqual(trail.children.map((mesh) => mesh.visible), [true, false, false]);
    assert.ok(incoming.geometry.userData.shared);
    assert.equal(first.geometry, second.geometry);
    assert.equal(first.material, incoming.material);
    assert.equal(first.scale.x, 0.65);
    assert.equal(first.scale.y, 1.1);
    const toes = (mesh) => new THREE.Vector3(0, 1, 0).applyEuler(mesh.rotation);
    assert.ok(toes(incoming).x * side > 0);
    assert.ok(toes(first).x * side < 0 && toes(first).z > 0);
    assert.ok(Math.abs(second.position.x) < Math.abs(first.position.x), 'next pair comes further into the corridor');
    // Rectangle SAT: diagonal decals can have overlapping AABBs while the actual planes are separate.
    const rectangle = (mesh) => {
      mesh.updateMatrix();
      return [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(([x, y]) =>
        new THREE.Vector3(x, y, 0).applyMatrix4(mesh.matrix));
    };
    const separated = (a, b) => {
      const axes = [a[1].clone().sub(a[0]), a[3].clone().sub(a[0]),
        b[1].clone().sub(b[0]), b[3].clone().sub(b[0])].map((axis) => axis.normalize());
      return axes.some((axis) => {
        const pa = a.map((p) => p.dot(axis));
        const pb = b.map((p) => p.dot(axis));
        return Math.min(...pa) - Math.max(...pb) > 0.03 || Math.min(...pb) - Math.max(...pa) > 0.03;
      });
    };
    assert.ok(separated(rectangle(incoming), rectangle(first)), 'incoming/outgoing decals do not overlap');
    assert.ok(separated(rectangle(first), rectangle(second)), 'enlarged outgoing pairs retain a gap');
    for (const mesh of trail.children) {
      const bounds = new THREE.Box3().setFromObject(mesh);
      assert.ok(bounds.min.x > -maze.HALF && bounds.max.x < maze.HALF);
      assert.ok(bounds.min.z > -maze.SEG_LEN && bounds.max.z < 0);
      if (mesh === incoming) continue;
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const xs = spot.safetyPoints.map((p) => p.x);
          const zs = spot.safetyPoints.map((p) => p.z);
          assert.ok(x >= Math.min(...xs) && x <= Math.max(...xs));
          assert.ok(z >= Math.min(...zs) && z <= Math.max(...zs));
        }
      }
    }
    spot.stages[0].apply();
    assert.deepEqual(trail.children.map((mesh) => mesh.visible), [true, true, false]);
    spot.stages[1].apply();
    assert.deepEqual(trail.children.map((mesh) => mesh.visible), [true, true, true]);
    assert.equal(objectCount(group), count);
  }
});

test('slippers stay clear of the complete door swing and fit their safety area on either corridor axis', () => {
  for (const side of [-1, 1]) {
    for (const yaw of [0, -Math.PI / 2]) {
      const corridor = new THREE.Group();
      corridor.position.set(21.2, 0, 42.4);
      corridor.rotation.y = yaw;
      const z = -7.8;
      const door = props.makeSwingDoor(Mat.door(), false);
      door.group.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
      door.group.position.set(side * (maze.HALF - 0.005), 0, z);
      corridor.add(door.group);
      const spot = stories.addRoom404Story(corridor, door, side, z);
      const shoes = corridor.getObjectByName('room404-slippers');
      const hinge = door.group.getObjectByName('door-hinge');
      const leaf = door.group.getObjectByName('door-leaf');
      const shoeBox = new THREE.Box3();
      const leafBox = new THREE.Box3();
      const bounds = new THREE.Box3();
      const safe = spot.safetyPoints.map((point) => corridor.localToWorld(new THREE.Vector3(point.x, 0, point.z)));
      bounds.setFromPoints(safe);
      for (let angle = 0; angle <= 42; angle++) {
        hinge.rotation.y = angle / 100;
        for (let turn = 0; turn <= 12; turn++) {
          shoes.rotation.y = -side * Math.PI / 2 + turn * Math.PI / 12;
          corridor.updateMatrixWorld(true);
          leafBox.setFromObject(leaf).expandByScalar(0.08);
          shoeBox.setFromObject(shoes);
          assert.equal(leafBox.intersectsBox(shoeBox), false, 'slippers keep at least 8cm from the leaf');
          assert.ok(shoeBox.min.x >= bounds.min.x && shoeBox.max.x <= bounds.max.x);
          assert.ok(shoeBox.min.z >= bounds.min.z && shoeBox.max.z <= bounds.max.z);
        }
      }
    }
  }
});

test('debug story placement is deterministic and owns its door without competing anomalies', () => {
  for (const [zone, kind] of [['apt404', 'room404'], ['apt404', 'footsteps'], ['school', 'footsteps']]) {
    const { buildCorridor } = builder(`?debug=anomaly&story=${kind}`);
    const built = seeded(444, () => buildCorridor(zone, 6));
    const spots = built.spots.filter((s) => s.kind === kind);
    assert.equal(spots.length, 1);
    const spot = spots[0];
    assert.equal(spot.z, -7.8);
    assert.ok(spot.x < 0);
    assert.equal(spot.stages.length, 2);
    assert.equal(built.spots.some((s) => s.kind === 'door' && s.x < 0 && Math.abs(s.z - spot.z) < 0.01), false);
    assert.equal(built.spots.some((s) => s.kind === 'shoes'), false);
    if (kind === 'room404') {
      assert.equal(built.spots.some((s) => s.kind === 'footsteps'), false);
      assert.ok(built.group.children.some((obj) => obj.position.z === -7.8 && obj.position.y === 2.2 && obj.material?.name.startsWith('label:["404"')));
    } else if (zone === 'apt404') {
      assert.equal(built.spots.some((s) => s.kind === 'room404'), false);
    }
  }
});

test('ordinary 404 corridors keep the two stories on separate doors', () => {
  const { buildCorridor } = builder('');
  let footprintCount = 0;
  seeded(404, () => {
    for (let i = 0; i < 30; i++) {
      const { spots } = buildCorridor('apt404', 6);
      for (const spot of spots.filter((s) => s.kind === 'door')) {
        assert.equal(spot.animatedDoor, true);
        assert.equal(typeof spot.opening, 'boolean');
        assert.equal(typeof spot.update, 'function');
        assert.equal(spot.motionDuration, props.DOOR_MOTION_SEC);
      }
      const room = spots.find((s) => s.kind === 'room404');
      const feet = spots.find((s) => s.kind === 'footsteps');
      if (!feet) continue;
      footprintCount++;
      assert.ok(!room || room.x !== feet.x || room.z !== feet.z);
    }
  });
  assert.ok(footprintCount > 0, 'footsteps are available without a debug query');
});

test('tatami closet anomaly spots also drive gradual door motion', () => {
  const { buildCorridor } = builder('');
  let animatedClosets = 0;
  seeded(444, () => {
    for (let i = 0; i < 10; i++) {
      const built = buildCorridor('tatami', 6);
      for (const spot of built.spots.filter((s) => s.kind === 'door')) {
        animatedClosets++;
        assert.equal(spot.animatedDoor, true);
        assert.equal(spot.opening, true);
        const panels = [];
        built.group.traverse((obj) => { if (obj.name === 'closet-moving-panel') panels.push(obj); });
        const before = panels.map((panel) => panel.position.x);
        spot.apply();
        assert.deepEqual(panels.map((panel) => panel.position.x), before, 'event start does not snap a closet panel');
        assert.equal(spot.update(props.DOOR_MOTION_SEC / 2), true);
        assert.notDeepEqual(panels.map((panel) => panel.position.x), before);
        assert.equal(spot.update(props.DOOR_MOTION_SEC / 2), false);
      }
    }
  });
  assert.ok(animatedClosets > 0);
});

test('door eyes are opt-in, appear gradually with opening and hide on close', () => {
  const door = props.makeSwingDoor(Mat.door(), false);
  assert.equal(door.group.getObjectByName('door-eyes'), undefined);
  door.setEyes(false);
  assert.equal(door.group.getObjectByName('door-eyes'), undefined);
  door.setEyes(true);
  const eyes = door.group.getObjectByName('door-eyes');
  const [left, right] = eyes.children;
  const material = left.material;
  const count = objectCount(door.group);
  assert.equal(eyes.parent, door.group, 'eyes remain in the room instead of rotating with the hinge');
  assert.equal(eyes.visible, false);
  assert.equal(material.opacity, 0);
  assert.equal(material.depthTest, true);
  assert.equal(material.depthWrite, false);
  assert.equal(left.geometry, right.geometry);
  assert.equal(left.material, right.material);
  assert.ok(left.geometry.userData.shared);
  assert.equal(eyes.children.filter((eye) => eye.userData.disposeMaterial).length, 1);
  door.animateTo(true);
  door.update(props.DOOR_MOTION_SEC * 0.2);
  assert.equal(eyes.visible, false, 'early opening does not reveal the eyes suddenly');
  door.update(props.DOOR_MOTION_SEC * 0.4);
  assert.equal(eyes.visible, true);
  assert.ok(material.opacity > 0 && material.opacity < 0.72);
  door.update(props.DOOR_MOTION_SEC * 0.4);
  assert.equal(material.opacity, 0.72);
  door.setEyes(true);
  assert.equal(objectCount(door.group), count);
  door.animateTo(false);
  door.update(props.DOOR_MOTION_SEC);
  assert.equal(eyes.visible, false);
  assert.equal(material.opacity, 0);
  door.setEyes(false);
  door.setOpen(true);
  assert.equal(eyes.visible, false);
  door.setEyes(true);
  assert.equal(eyes.visible, true);
  assert.equal(left.material, material);
  assert.equal(objectCount(door.group), count, 'showing the eyes again reuses the pair');
});

test('real door depth hides the eyes when closed and reveals both from the open latch side', () => {
  for (const side of [-1, 1]) {
    for (const corridorYaw of [0, -Math.PI / 2]) {
      const corridor = new THREE.Group();
      corridor.position.set(21.2, 0, 42.4);
      corridor.rotation.y = corridorYaw;
      const door = props.makeSwingDoor(Mat.door(), false);
      door.group.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
      door.group.position.set(side * (maze.HALF - 0.005), 0, -7.8);
      corridor.add(door.group);
      door.setEyes(true);
      const eyes = door.group.getObjectByName('door-eyes');
      const leaf = door.group.getObjectByName('door-leaf');
      const hinge = door.group.getObjectByName('door-hinge');
      assert.ok(eyes.position.z > 0.01 && eyes.position.z < 0.03);
      assert.ok(eyes.position.y > 1.4 && eyes.position.y < 1.7);
      const blocked = (eye, cameraX) => {
        corridor.updateMatrixWorld(true);
        const from = door.group.localToWorld(new THREE.Vector3(cameraX, 1.62, side === -1 ? 1.845 : 1.345));
        const target = eye.getWorldPosition(new THREE.Vector3());
        const distance = from.distanceTo(target);
        const ray = new THREE.Raycaster(from, target.sub(from).normalize(), 0, distance);
        return ray.intersectObject(leaf, false).length > 0;
      };
      for (const eye of eyes.children) assert.equal(blocked(eye, -2.2), true);
      door.setOpen(true);
      for (const angle of [0.3, 0.36, 0.42]) {
        hinge.rotation.y = angle;
        for (const eye of eyes.children) {
          assert.equal(blocked(eye, -2.2), false, 'both eyes are visible from the actual opening');
          assert.equal(blocked(eye, 0), true, 'eyes are not drawn through the leaf in a straight-on view');
          assert.equal(blocked(eye, 2.2), true, 'the hinge-side view stays occluded');
        }
      }
    }
  }
});

test('404 stories enable the eyes before the door event without adding lights or animated objects', () => {
  const { buildCorridor } = builder('?debug=anomaly&story=room404');
  const built = seeded(404, () => buildCorridor('apt404', 6));
  const eyes = built.group.getObjectByName('door-eyes');
  assert.ok(eyes);
  assert.equal(eyes.visible, false);
  const story = built.spots.find((spot) => spot.kind === 'room404');
  const count = objectCount(built.group);
  story.stages[0].apply();
  story.update(props.DOOR_MOTION_SEC);
  assert.equal(eyes.visible, true);
  assert.equal(objectCount(built.group), count);
  let extraLights = 0;
  built.group.traverse((object) => { if (object.isLight) extraLights++; });
  assert.equal(extraLights, 0);
});

test('wall posters register individual meshes and correct facing for passing reactions', () => {
  for (const zone of ['subway', 'video']) {
    const { buildCorridor } = builder('?debug=posters');
    const built = seeded(814, () => buildCorridor(zone, 6));
    assert.equal(built.posters.length, 3);
    const meshes = new Set(built.posters.map((entry) => entry.mesh));
    assert.equal(meshes.size, 3);
    for (const entry of built.posters) {
      assert.equal(entry.normalX, 1);
      assert.equal(entry.normalZ, 0);
      assert.equal(entry.variant, 0);
      assert.equal(entry.y, entry.mesh.position.y);
      assert.equal(entry.mesh.name, 'wall-poster');
      assert.equal(entry.mesh.scale.x, zone === 'subway' ? .42 : .4);
      assert.equal(entry.mesh.scale.y, zone === 'subway' ? .58 : .55);
      assert.ok(entry.x > -maze.HALF, 'visibility point stays inside the corridor wall');
    }
  }
});
