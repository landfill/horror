import * as THREE from 'three';
import { Mat, POSTER_VARIANTS, SignPhrases, VARIANT_COUNT, pick, rand, signMaterial, variantOf } from './Textures';
import { DIRS, Dir, DOOR_WALL_Z, HALF, SEG_H, SEG_LEN, SEG_W, ZoneKind, edgeOpen } from './Maze';
import {
  DoorUnit,
  DOOR_MOTION_SEC,
  LANDMARK_KINDS,
  PropKind,
  makeCeilingHole,
  makeProp,
  makeSlidingCloset,
  makeStain,
  makeSwingDoor,
  makeTV,
  boxMesh,
  plane,
} from './Props';
import type { SpotSpec } from './Anomalies';
import { addFootstepStory, addRoom404Story } from './StoryProps';

/** 로컬 좌표의 형광등 위치와 세기 */
export interface FixtureSpec {
  x: number;
  y: number;
  z: number;
  base: number;
  mat: THREE.MeshBasicMaterial;
  /** 처음부터 꺼져 있는 등 */
  dead?: boolean;
}

export interface BuiltPiece {
  group: THREE.Group;
  fixtures: FixtureSpec[];
  /** 이 구간의 밝기 (만들 때 한 번 정함) */
  light: SegmentLight;
  /** 이상 현상이 일어날 수 있는 자리 (로컬 좌표) */
  spots: SpotSpec[];
}

/**
 * 복도 변주 원칙
 * - 모든 변주는 조각을 만들 때 한 번만 정합니다. 조각은 안개 너머(또는 시야 밖)에서 만들어지므로
 *   플레이어가 보는 동안 모양이 바뀌지 않습니다.
 * - 소품은 벽에 붙여(벽에서 0.5m 이내) 놓아 걷는 길(가운데 약 2.5m)과 문틀 통로를 막지 않습니다.
 * - 재질은 캐시된 공유 재질과 소수의 변형(variantOf)만 씁니다.
 */
const WALL_PROP_X = HALF - 0.32; // 벽에 붙여 놓는 바닥 소품의 x
const KEEP_CLEAR_Z = -SEG_LEN + 1.6; // 이보다 깊은 곳(문틀 앞)에는 바닥 소품을 두지 않음
const storyParams = new URLSearchParams(location.search);
const DEBUG_STORY = storyParams.get('debug') === 'anomaly' ? storyParams.get('story') : null;

function wallMatFor(zone: ZoneKind): THREE.Material {
  return zone === 'school'
    ? Mat.schoolWall()
    : zone === 'apt404'
      ? Mat.wallpaper()
      : zone === 'tatami'
        ? Mat.shoji()
        : zone === 'subway'
          ? Mat.subwayTile()
          : Mat.darkConcrete();
}

function floorMatFor(zone: ZoneKind): THREE.Material {
  return zone === 'school'
    ? Mat.tileFloor()
    : zone === 'apt404'
      ? Mat.carpet()
      : zone === 'tatami'
        ? Mat.woodFloor()
        : Mat.concrete();
}

function ceilMatFor(zone: ZoneKind): THREE.Material {
  return zone === 'tatami' ? Mat.darkWood() : Mat.ceilingTile();
}

function doorMatFor(zone: ZoneKind): THREE.Material {
  return zone === 'apt404' || zone === 'subway' ? Mat.steelDoor() : Mat.woodDoor();
}

const variant = () => Math.floor(Math.random() * VARIANT_COUNT);

function addFixture(group: THREE.Group, out: FixtureSpec[], x: number, z: number, base: number, dead = false, hanging = false): void {
  const mat = new THREE.MeshBasicMaterial({ color: dead ? 0x181818 : 0xd8d8d2 });
  const tube = boxMesh(0.65, 0.04, 0.14, mat);
  tube.userData.fixture = true;
  if (hanging) {
    // 한쪽 고정이 빠져 비스듬히 매달린 등
    tube.position.set(x, SEG_H - 0.2, z);
    tube.rotation.z = rand(0.45, 0.6) * (Math.random() < 0.5 ? -1 : 1);
    const wire = boxMesh(0.01, 0.2, 0.01, Mat.darkMetal());
    wire.position.set(x + Math.sign(tube.rotation.z) * 0.29, SEG_H - 0.1, z);
    group.add(wire);
  } else {
    tube.position.set(x, SEG_H - 0.03, z);
  }
  group.add(tube);
  out.push({ x, y: SEG_H - 0.18, z, base, mat, dead });
}

/**
 * 구간(복도 하나·교차로 하나) 밝기.
 * 너무 어두우면 오히려 무섭지 않으므로 밝은 구간이 더 많음 (밝음 65 : 어두움 35).
 * 어두운 구간 중 일부만 완전히 깜깜함.
 */
export type SegmentLight = 'bright' | 'dark' | 'black';
/**
 * 40장짜리 카드 묶음을 섞어 차례로 뽑음: 밝음 26 / 어두움 11 / 깜깜함 3 (= 65 : 35, 깜깜함은 어두운 구간의 약 1/5).
 * 매번 동전을 던지는 것보다 짧게 걸어도 비율이 지켜지고, 어두운 구간이 길게 이어지는 일이 적음.
 */
const LIGHT_DECK: SegmentLight[] = [
  ...Array<SegmentLight>(26).fill('bright'),
  ...Array<SegmentLight>(11).fill('dark'),
  ...Array<SegmentLight>(3).fill('black'),
];
let lightDeck: SegmentLight[] = [];

export function chooseSegmentLight(): SegmentLight {
  if (lightDeck.length === 0) {
    lightDeck = [...LIGHT_DECK];
    for (let i = lightDeck.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      [lightDeck[i], lightDeck[k]] = [lightDeck[k], lightDeck[i]];
    }
  }
  return lightDeck.pop()!;
}

/** 형광등 상태: 밝은 구간은 거의 다 켜짐, 어두운 구간은 흐림·꺼짐 위주 */
function fixtureState(light: SegmentLight, lightFull: number, first: boolean): { base: number; dead: boolean } {
  const r = Math.random();
  if (light === 'black') return { base: lightFull, dead: true };
  if (light === 'bright') {
    // 첫 등은 늘 환하고, 나머지 중 가끔 조금 흐린 등 (깜빡임은 LightPool이 모든 등에 줌)
    return !first && r < 0.15 ? { base: lightFull * rand(0.65, 0.8), dead: false } : { base: lightFull, dead: false };
  }
  if (r < 0.4) return { base: lightFull, dead: true };
  return { base: lightFull * rand(0.25, 0.45), dead: false };
}

/** 복도 벽(side: -1 왼쪽 / 1 오른쪽)에 로컬 평면(앞면 +z)을 붙이는 변환 */
function onWall(obj: THREE.Object3D, side: number, z: number, inset = 0): void {
  obj.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
  obj.position.set(side * (HALF - inset), obj.position.y, z);
}

/** 바닥 소품을 벽에 붙여 놓고 방향을 정함 (facing: 'corridor' | 'wall' | 'along') */
function placeOnFloor(obj: THREE.Object3D, side: number, z: number, facing: 'corridor' | 'wall' | 'along' = 'corridor'): void {
  obj.position.set(side * WALL_PROP_X, 0, z);
  const toCorridor = side === -1 ? Math.PI / 2 : -Math.PI / 2;
  obj.rotation.y = facing === 'corridor' ? toCorridor : facing === 'wall' ? toCorridor + Math.PI : rand(-0.3, 0.3);
}

/** 얼룩 붙이기. walls=false면 바닥·천장에만 (교차로는 뚫린 방향에 벽이 없으므로) */
function addStains(group: THREE.Group, count: number, length: number, z0: number, walls = true): void {
  for (let k = 0; k < count; k++) {
    const r = walls ? Math.random() : 0.6 + Math.random() * 0.4;
    const s = makeStain(rand(0.6, 1.6), rand(0.6, 1.4));
    const z = z0 - rand(0.5, length - 0.5);
    if (r < 0.6) {
      const side = Math.random() < 0.5 ? -1 : 1;
      s.position.y = rand(0.8, SEG_H - 0.6);
      onWall(s, side, z, 0.006);
    } else if (r < 0.8) {
      s.rotation.x = Math.PI / 2;
      s.position.set(rand(-0.8, 0.8), SEG_H - 0.006, z);
    } else {
      s.rotation.x = -Math.PI / 2;
      s.position.set(rand(-0.9, 0.9), 0.006, z);
    }
    group.add(s);
  }
}

/**
 * 복도 하나 (로컬 원점 = 소유 교차로 가장자리, 로컬 -z 방향으로 18m).
 * 반환된 group은 호출 측에서 월드 위치/회전을 지정합니다.
 */
export function buildCorridor(zone: ZoneKind, lightFull: number): BuiltPiece {
  const group = new THREE.Group();
  const fixtures: FixtureSpec[] = [];
  const spots: SpotSpec[] = [];

  const floor = plane(SEG_W, SEG_LEN, variantOf(floorMatFor(zone), variant()));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -SEG_LEN / 2);
  group.add(floor);

  const ceil = plane(SEG_W, SEG_LEN, variantOf(ceilMatFor(zone), variant()));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, SEG_H, -SEG_LEN / 2);
  group.add(ceil);

  // 좌우 벽도 서로 다른 변형일 수 있음
  const wallGeo = new THREE.PlaneGeometry(SEG_LEN, SEG_H);
  const leftWall = new THREE.Mesh(wallGeo, variantOf(wallMatFor(zone), variant()));
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-HALF, SEG_H / 2, -SEG_LEN / 2);
  const rightWall = new THREE.Mesh(wallGeo.clone(), variantOf(wallMatFor(zone), variant()));
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.position.set(HALF, SEG_H / 2, -SEG_LEN / 2);
  group.add(leftWall, rightWall);

  buildThresholdDoorway(group, DOOR_WALL_Z);

  // 형광등 개수·위치·상태가 복도마다 다름. 밝은 복도는 2~3개, 어두운 복도는 1~2개
  const light = chooseSegmentLight();
  const r = Math.random();
  const count = light === 'bright' ? (r < 0.55 ? 2 : 3) : r < 0.45 ? 1 : 2;
  for (let k = 0; k < count; k++) {
    const z = -SEG_LEN * ((k + 0.5) / count) + rand(-1.2, 1.2);
    const st = fixtureState(light, lightFull, k === 0);
    addFixture(group, fixtures, 0, z, st.base, st.dead, Math.random() < 0.1);
  }
  // 깜깜한 구간이 아니면 적어도 하나는 켜져 있음
  if (light === 'dark' && fixtures.every((f) => f.dead)) {
    fixtures[0].dead = false;
    fixtures[0].base = lightFull * rand(0.25, 0.45);
    fixtures[0].mat.color.setHex(0xd8d8d2);
  }

  addStains(group, Math.floor(rand(0, 4)), SEG_LEN, 0);
  const holes = Math.random() < 0.35 ? (Math.random() < 0.3 ? 2 : 1) : 0;
  for (let k = 0; k < holes; k++) {
    const h = makeCeilingHole();
    h.position.set(rand(-0.7, 0.7), 0, -rand(2, SEG_LEN - 2));
    group.add(h);
  }

  populateZoneDetails(group, zone, spots);
  return { group, fixtures, spots, light };
}

/**
 * 교차로 (월드 좌표 중심 기준 로컬). 복도가 없는 방향은 벽으로 막음.
 * 막힌 벽에는 가끔 어디로도 이어지지 않는 문이 달려 있습니다.
 */
export function buildJunction(i: number, j: number, zone: ZoneKind, lightFull: number): BuiltPiece {
  const group = new THREE.Group();
  const fixtures: FixtureSpec[] = [];
  const spots: SpotSpec[] = [];

  const floor = plane(SEG_W, SEG_W, variantOf(floorMatFor(zone), variant()));
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const ceil = plane(SEG_W, SEG_W, variantOf(ceilMatFor(zone), variant()));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = SEG_H;
  group.add(ceil);

  const wallMat = variantOf(wallMatFor(zone), variant());
  const closedDirs: Dir[] = [];
  (Object.keys(DIRS) as Dir[]).forEach((dir) => {
    if (edgeOpen(i, j, dir)) return;
    closedDirs.push(dir);
    const w = plane(SEG_W, SEG_H, wallMat);
    const { di, dj } = DIRS[dir];
    w.position.set(di * HALF, SEG_H / 2, dj * HALF);
    // 벽이 교차로 안쪽을 보도록 회전
    w.rotation.y = Math.atan2(-di, -dj);
    group.add(w);

    // 막다른 벽의 문 (25%): 열려 있으면 그 너머는 칠흑
    if (Math.random() < 0.25) {
      const door = makeSwingDoor(doorMatFor(zone), Math.random() < 0.15);
      door.group.position.set(di * (HALF - 0.005), 0, dj * (HALF - 0.005));
      door.group.rotation.y = w.rotation.y;
      group.add(door.group);
      spots.push(doorSpot(door, di * (HALF - 0.5), dj * (HALF - 0.5)));
    }
  });

  // 교차로 등 하나: 밝은 교차로는 거의 다 켜짐, 어두운 교차로는 흐림, 깜깜한 교차로는 등이 없음
  const light = chooseSegmentLight();
  if (light === 'bright') addFixture(group, fixtures, 0, 0, lightFull * rand(0.85, 1), false, Math.random() < 0.08);
  else if (light === 'dark') addFixture(group, fixtures, 0, 0, lightFull * rand(0.2, 0.35), false, Math.random() < 0.08);

  addStains(group, Math.floor(rand(0, 2.6)), SEG_W, HALF, false);
  if (Math.random() < 0.12) {
    const h = makeCeilingHole();
    h.position.set(rand(-0.6, 0.6), 0, rand(-0.6, 0.6));
    group.add(h);
  }

  // 모퉁이: 가끔 눈에 띄는 사물(기억해 둘 만한 것) 하나, 아니면 같은 사물이 나중에 나타날 수 있는 빈자리
  const c = HALF - 0.45;
  const corners = [
    [c, c],
    [-c, c],
    [c, -c],
    [-c, -c],
  ];
  const [cx, cz] = pick(corners);
  // 모퉁이 사물은 가장 가까운 벽(구석)을 바라봄
  const faceCorner = Math.atan2(Math.sign(cx), Math.sign(cz));
  if (Math.random() < 0.16) {
    const kind = pick(LANDMARK_KINDS);
    const prop = makeProp(kind);
    prop.position.set(cx, 0, cz);
    prop.rotation.y = faceCorner;
    group.add(prop);
    spots.push({ x: cx, z: cz, kind: 'landmark', prop: kind });
  } else {
    spots.push({
      x: cx,
      z: cz,
      kind: 'echo',
      apply: (kind?: PropKind) => {
        if (!kind) return;
        const prop = makeProp(kind);
        prop.position.set(cx, 0, cz);
        prop.rotation.y = faceCorner;
        group.add(prop);
      },
    });
  }

  return { group, fixtures, spots, light };
}

function doorSpot(door: DoorUnit, x: number, z: number): SpotSpec {
  const initial = door.isOpen();
  return {
    x, z, kind: 'door',
    opening: !initial,
    animatedDoor: true,
    motionDuration: DOOR_MOTION_SEC,
    update: (dt) => door.update?.(dt) ?? false,
    apply: () => {
      if (door.animateTo) door.animateTo(!initial);
      else door.setOpen(!initial);
    },
  };
}

/**
 * 구간과 구간 사이를 잇는 좁은 문틀과 반쯤 열린 문짝.
 * 엘리베이터 없이 걸어갈수록 학교 → 아파트 → 여관 → 비디오가게 → 지하철 통로가 기괴하게 직결됩니다.
 * 문짝이 달린 쪽과 열린 각도는 문틀마다 다르고, 가끔 문짝이 아예 없습니다.
 */
export function buildThresholdDoorway(group: THREE.Group, zLocal: number): void {
  const doorOpenW = 1.35;
  const sideW = (SEG_W - doorOpenW) / 2;
  const doorH = 2.25;
  const topH = SEG_H - doorH;

  const frameMat = Mat.darkConcrete();

  const leftWall = boxMesh(sideW, SEG_H, 0.28, frameMat);
  leftWall.position.set(-SEG_W / 2 + sideW / 2, SEG_H / 2, zLocal);

  const rightWall = boxMesh(sideW, SEG_H, 0.28, frameMat);
  rightWall.position.set(SEG_W / 2 - sideW / 2, SEG_H / 2, zLocal);

  const lintel = boxMesh(doorOpenW, topH, 0.28, frameMat);
  lintel.position.set(0, doorH + topH / 2, zLocal);
  group.add(leftWall, rightWall, lintel);

  if (Math.random() < 0.1) return;

  // 반쯤 삐딱하게 열려 있는 낡은 문짝 (원래보다 더 닫히지는 않게 해서 통로를 막지 않음)
  const side = Math.random() < 0.5 ? -1 : 1;
  const ajarDoor = boxMesh(0.85, doorH - 0.04, 0.05, Mat.woodDoor());
  ajarDoor.position.set(side * (-doorOpenW / 2 + 0.22), doorH / 2, zLocal - 0.35);
  ajarDoor.rotation.y = -side * rand(1.12, 1.45);
  group.add(ajarDoor);
}

function addWallDoor(group: THREE.Group, spots: SpotSpec[], mat: THREE.Material, side: number, z: number, openP: number, anomalyP: number): DoorUnit {
  const door = makeSwingDoor(mat, Math.random() < openP);
  onWall(door.group, side, z, 0.005);
  group.add(door.group);
  if (Math.random() < anomalyP) spots.push(doorSpot(door, side * (HALF - 0.6), z));
  return door;
}

/** 지하철 안내판 문구 (영어, 일본어, 한국어 순으로 같은 뜻). 출구는 어디에도 없음 */
const SUBWAY_SIGNS: SignPhrases[] = [
  ['← Transfer (No Exit)', '← 乗換通路（出口なし）', '← 환승통로 (출구 없음)'],
  ['EXIT →', '出口 →', '출구 →'],
  ['EXIT ↑', '出口 ↑', '출구 ↑'],
  ['← Exit 4', '← 4番出口', '← 4번 출구'],
  ['← EXIT　EXIT →', '← 出口　出口 →', '← 출구　출구 →'],
  ['← Platform (Service Ended)', '← ホーム（運行終了）', '← 승강장 (운행 종료)'],
];

/** 서로 겹치지 않는 z 자리 몇 개를 고름 (slots 중에서 각 확률 p로) */
function chooseSlots(slots: number[], p: number, jitter = 0.4): number[] {
  return slots.filter(() => Math.random() < p).map((z) => z + rand(-jitter, jitter));
}

/** 벽에 손자국 (side 쪽 벽, 높이는 사람 손이 닿는 곳) */
function addHandprints(group: THREE.Group, side: number, z: number): void {
  const m = plane(rand(0.7, 1.0), rand(0.7, 1.0), Mat.decal('handprints'));
  m.renderOrder = 1;
  m.position.y = rand(0.9, 1.5);
  onWall(m, side, z, 0.008);
  group.add(m);
}

/**
 * 바닥의 젖은 맨발 자국 한 줄. 복도를 따라 걷다가 벽(towardSide 쪽)으로 꺾여 들어가 끊김
 * (벽 속으로 걸어 들어간 것처럼).
 */
function addFootprints(group: THREE.Group, towardSide: number, z: number): void {
  const m = plane(0.77, 1.54, Mat.decal('footprints'));
  m.renderOrder = 1;
  m.rotation.x = -Math.PI / 2;
  // 텍스처의 '위'(걸어가는 쪽)가 -z(복도 안쪽)를 향하고, 벽 쪽으로 비스듬히
  m.rotation.z = -towardSide * rand(0.25, 0.5);
  m.position.set(towardSide * (HALF - 0.75), 0.007, z);
  group.add(m);
}

/** 바닥 소품을 벽에 붙여 놓음 (복도 쪽을 봄) */
function addFloorProp(group: THREE.Group, kind: PropKind, side: number, z: number, inset = WALL_PROP_X): THREE.Group {
  const p = makeProp(kind);
  placeOnFloor(p, side, z, 'corridor');
  p.position.x = side * inset;
  group.add(p);
  return p;
}

const randSide = () => (Math.random() < 0.5 ? -1 : 1);

export function populateZoneDetails(group: THREE.Group, zone: ZoneKind, spots: SpotSpec[]): void {
  switch (zone) {
    case 'school': {
      // 교실 문(가끔 살짝 열림), 검은 창문, 사물함, 4:44 시계, 의자, 게시판
      const schoolDoors = DEBUG_STORY === 'footsteps' ? [-3.5, -7.8, -14.2] : chooseSlots([-3.5, -9.0, -14.2], 0.8);
      const footstepDoorZ = DEBUG_STORY === 'footsteps' ? -7.8
        : DEBUG_STORY !== 'room404' && schoolDoors.length > 0 && Math.random() < 0.3 ? pick(schoolDoors) : undefined;
      for (const z of schoolDoors) {
        addWallDoor(group, spots, Mat.woodDoor(), -1, z, z === footstepDoorZ ? 0 : 0.2, z === footstepDoorZ ? 0 : 0.6);

        // 복도 쪽 교실 창문 (안쪽은 칠흑, 가끔 희미하게 밝음)
        const win = plane(1.8, 0.95, Math.random() < 0.15 ? Mat.dimGlass() : Mat.black());
        win.position.y = 1.55;
        onWall(win, -1, z - 2.1, 0.02);
        group.add(win);
      }

      // 오른쪽 벽 사물함 1~2줄
      const lockers = Math.random() < 0.3 ? 2 : 1;
      for (let k = 0; k < lockers; k++) {
        const len = rand(1.8, 3.6);
        const z = lockers === 1 ? rand(-5, -11) : k === 0 ? rand(-3, -6) : rand(-10, -13);
        const locker = boxMesh(0.42, 1.85, len, Mat.locker());
        locker.position.set(SEG_W / 2 - 0.22, 0.925, z);
        group.add(locker);
        // 하나만 문이 열린 채
        if (Math.random() < 0.3) {
          const lid = boxMesh(0.02, 1.7, 0.3, Mat.locker());
          lid.position.set(SEG_W / 2 - 0.5, 0.95, z + rand(-len / 3, len / 3));
          lid.rotation.y = 0.9;
          group.add(lid);
        }
      }

      // 4시 44분 시계
      if (Math.random() < 0.5) {
        const clock = plane(0.45, 0.45, Mat.clock());
        clock.position.y = 2.45;
        onWall(clock, 1, rand(-9, -14), 0.02);
        group.add(clock);
      }

      // 게시판: 빛바랜 종이 몇 장
      if (Math.random() < 0.4) {
        const z = rand(-13, -16);
        const board = plane(1.4, 0.9, Mat.plain(0x3a3a38));
        board.position.y = 1.6;
        onWall(board, 1, z, 0.015);
        group.add(board);
        const papers = Math.floor(rand(2, 6));
        for (let k = 0; k < papers; k++) {
          const paper = plane(rand(0.2, 0.32), rand(0.26, 0.4), Mat.plain(0xb8b7b0));
          paper.position.y = 1.6 + rand(-0.25, 0.25);
          onWall(paper, 1, z + rand(-0.5, 0.5), 0.02);
          paper.rotateZ(rand(-0.12, 0.12));
          group.add(paper);
        }
      }

      // 복도에 나와 있는 의자. 가끔은 처음부터 벽을 보고 있음
      if (Math.random() < 0.3) {
        const chair = makeProp('chair');
        let side = Math.random() < 0.5 ? -1 : 1;
        const z = rand(-4, KEEP_CLEAR_Z);
        if (side === -1 && footstepDoorZ !== undefined && Math.abs(z - footstepDoorZ) < 1.5) side = 1;
        const r = Math.random();
        const facesWall = r < 0.15;
        const fallen = r > 0.7;
        placeOnFloor(chair, side, z, facesWall ? 'wall' : fallen ? 'along' : 'corridor');
        if (fallen) {
          // 옆으로 쓰러진 의자 (등받이가 벽 쪽)
          chair.rotation.z = side * Math.PI / 2;
          chair.position.y = 0.21;
          chair.position.x = side * (HALF - 0.45);
        }
        group.add(chair);
        if (!facesWall && !fallen) {
          spots.push({ x: side * WALL_PROP_X, z, kind: 'chair', apply: () => placeOnFloor(chair, side, z, 'wall') });
        }
      }

      // 소화기 (사물함 없는 왼쪽 벽, 교실 문과 겹치지 않는 자리)
      if (Math.random() < 0.5) addFloorProp(group, 'extinguisher', -1, pick([-6.2, -11.6, -16.2]) + rand(-0.2, 0.2), HALF - 0.14);
      // 교실 창문 옆 손자국, 교실 문으로 이어지는 젖은 발자국
      if (Math.random() < 0.3) addHandprints(group, -1, rand(-5, -16));
      if (footstepDoorZ !== undefined) spots.push(addFootstepStory(group, -1, footstepDoorZ));
      break;
    }

    case 'apt404': {
      // 늘어선 철문(전부 404호), 부적, 문 앞의 물건들
      const doors: { side: number; z: number; door: DoorUnit; plaque: boolean }[] = [];
      for (const z of [-3.2, -7.8, -12.4, -15.8]) {
        for (const side of [-1, 1]) {
          const forced = (DEBUG_STORY === 'room404' || DEBUG_STORY === 'footsteps') && side === -1 && z === -7.8;
          if (!forced && Math.random() > 0.8) continue;
          const dz = forced ? z : z + rand(-0.3, 0.3);
          // 사건에 쓸 문을 고른 뒤 나머지 문에만 단독 개폐 이상 현상을 등록합니다.
          const door = addWallDoor(group, spots, Mat.steelDoor(), side, dz, 0.08, 0);
          const plaque = forced || Math.random() < 0.9;
          doors.push({ side, z: dz, door, plaque });

          // 호수판 (전부 404호, 가끔 떨어져 나감)
          if (plaque) {
            const plate = plane(0.28, 0.12, Mat.label('404', { bg: '#1a1a1a', fg: '#d8d8d2', border: true })
            );
            plate.position.y = 2.2;
            onWall(plate, side, dz, 0.03);
            group.add(plate);
          }

          // 문틀 주변 부적: 없거나, 몇 장이거나, 문 하나를 뒤덮을 만큼
          const t = Math.random();
          const talismans = t < 0.4 ? 0 : t < 0.82 ? Math.floor(rand(1, 4)) : Math.floor(rand(9, 15));
          for (let k = 0; k < talismans; k++) {
            const talisman = plane(0.11, 0.26, Mat.label('勅令', { bg: '#bfbeb6', fg: '#111111', border: true })
            );
            // 문짝이 아니라 문틀 위·옆 벽에 붙임 (문이 열려도 제자리)
            const above = Math.random() < 0.5;
            talisman.position.y = above ? rand(2.12, 2.6) : rand(0.6, 2.2);
            const along = above ? rand(-0.45, 0.45) : (Math.random() < 0.5 ? -1 : 1) * rand(0.55, 0.75);
            onWall(talisman, side, dz + along, 0.035);
            talisman.rotateZ(rand(-0.25, 0.25));
            group.add(talisman);
          }
        }
      }

      const storyDoors = doors.filter((d) => d.z > KEEP_CLEAR_Z + 1.4 && d.z < -1.4);
      const forcedDoor = storyDoors.find((d) => d.side === -1 && d.z === -7.8);
      const roomDoor = DEBUG_STORY === 'footsteps' ? undefined
        : DEBUG_STORY === 'room404' ? forcedDoor : storyDoors.length > 0 ? pick(storyDoors) : undefined;
      const footDoors = storyDoors.filter((d) => d !== roomDoor);
      const footDoor = DEBUG_STORY === 'room404' ? undefined
        : DEBUG_STORY === 'footsteps' ? forcedDoor
          : footDoors.length > 0 && Math.random() < 0.25 ? pick(footDoors) : undefined;

      if (roomDoor) {
        // 이 문에는 실내화와 연결된 두 단계만 적용합니다. 다른 단독 사건과 중복하지 않음.
        spots.push(addRoom404Story(group, roomDoor.door, roomDoor.side, roomDoor.z));
        if (!roomDoor.plaque) {
          const plate = plane(0.28, 0.12, Mat.label('404', { bg: '#1a1a1a', fg: '#d8d8d2', border: true }));
          plate.position.y = 2.2;
          onWall(plate, roomDoor.side, roomDoor.z, 0.03);
          group.add(plate);
        }
      }
      if (footDoor) {
        footDoor.door.setOpen(false);
        spots.push(addFootstepStory(group, footDoor.side, footDoor.z));
      }
      for (const d of doors) {
        if (d !== roomDoor && d !== footDoor && Math.random() < 0.35) {
          spots.push(doorSpot(d.door, d.side * (HALF - 0.6), d.z));
        }
      }

      const clearOfStory = (side: number, z: number) =>
        ![roomDoor, footDoor].some((d) => d && d.side === side && Math.abs(d.z - z) < 1.5);

      // 택배 상자, 기대 놓은 우산
      if (Math.random() < 0.25) {
        const side = randSide();
        const z = rand(-2, KEEP_CLEAR_Z);
        if (clearOfStory(side, z)) {
          const b = makeProp('box');
          placeOnFloor(b, side, z, 'along');
          group.add(b);
        }
      }
      if (Math.random() < 0.18) {
        const side = randSide();
        const z = rand(-2, KEEP_CLEAR_Z);
        if (clearOfStory(side, z)) {
          const u = makeProp('umbrella');
          placeOnFloor(u, side, z, 'corridor');
          u.position.x = side * (HALF - 0.25);
          group.add(u);
        }
      }

      // 복도 입구 벽에 박힌 우편함 (칸마다 404호, 꽂힌 채 쌓인 전단지)
      if (Math.random() < 0.35) {
        const front = plane(0.62, 0.31, Mat.mailbox());
        front.position.y = 1.35;
        onWall(front, randSide(), rand(-0.9, -1.6), 0.01);
        group.add(front);
      }

      // 문 옆에 내놓은 쓰레기봉투 1~3개
      if (doors.length > 0 && Math.random() < 0.35) {
        const d = pick(doors);
        const n = Math.floor(rand(1, 4));
        for (let k = 0; k < n; k++) {
          const z = d.z + 0.75 + k * 0.42;
          if (z > -0.6 || z < KEEP_CLEAR_Z || !clearOfStory(d.side, z)) continue;
          addFloorProp(group, 'bag', d.side, z, HALF - 0.3);
        }
      }
      if (Math.random() < 0.25) addHandprints(group, randSide(), rand(-3, -15));
      break;
    }

    case 'tatami': {
      // 다다미 여관 기둥(간격이 복도마다 다름)과 벽장
      const step = rand(3.0, 4.2);
      for (let z = -rand(1.5, 3); z > -SEG_LEN + 0.5; z -= step) {
        for (const side of [-1, 1]) {
          const pillar = boxMesh(0.12, SEG_H, 0.12, Mat.darkWood());
          pillar.position.set(side * (SEG_W / 2 - 0.06), SEG_H / 2, z);
          group.add(pillar);
        }
      }

      // 벽장 0~2개: 반쯤 열려 칠흑이 보이거나, 닫혀 있다가 열림
      const closets = Math.floor(rand(0, 2.6));
      for (let k = 0; k < closets; k++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const z = rand(-3, -15);
        const closet = makeSlidingCloset(rand(1.2, 1.6), Math.random() < 0.5);
        onWall(closet.group, side, z, 0.02);
        group.add(closet.group);
        if (!closet.isOpen()) spots.push(doorSpot(closet, side * (HALF - 0.6), z));
      }

      // 족자: 한 글자
      if (Math.random() < 0.35) {
        const scroll = plane(0.42, 1.1, Mat.label(pick(['静', '忌', '帰']), { w: 128, h: 320, bg: '#c3c1b8', fg: '#141414', border: true, font: 'bold 96px serif' })
        );
        scroll.position.y = 1.75;
        onWall(scroll, Math.random() < 0.5 ? -1 : 1, rand(-5, -14), 0.03);
        group.add(scroll);
      }

      // 방석 몇 장
      if (Math.random() < 0.3) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const z = rand(-3, KEEP_CLEAR_Z);
        for (let k = 0; k < Math.floor(rand(1, 4)); k++) {
          const cushion = boxMesh(0.5, 0.07, 0.55, Mat.plain(0x5c5a55));
          cushion.position.set(side * (HALF - 0.35), 0.035 + k * 0.07, z);
          cushion.rotation.y = rand(-0.2, 0.2);
          group.add(cushion);
        }
      }

      // 천장에 매단 종이 등 1~2개 (불은 꺼져 있음, 머리 위로 지나감)
      if (Math.random() < 0.3) {
        const n = Math.random() < 0.7 ? 1 : 2;
        for (let k = 0; k < n; k++) {
          const lantern = makeProp('lantern');
          lantern.position.set(randSide() * rand(0.7, 0.95), SEG_H, rand(-3, -15));
          group.add(lantern);
        }
      }

      // 벽에 기대 앉은 인형. 처음엔 벽을 보고 있다가, 다시 보면 복도 쪽을 보고 있기도 함
      if (Math.random() < 0.2) {
        const side = randSide();
        const z = rand(-3, KEEP_CLEAR_Z);
        const facesWall = Math.random() < 0.6;
        const doll = addFloorProp(group, 'doll', side, z, HALF - 0.2);
        if (facesWall) {
          placeOnFloor(doll, side, z, 'wall');
          doll.position.x = side * (HALF - 0.2);
          spots.push({
            x: side * (HALF - 0.6),
            z,
            kind: 'doll',
            apply: () => {
              placeOnFloor(doll, side, z, 'corridor');
              doll.position.x = side * (HALF - 0.2);
            },
          });
        }
      }

      if (Math.random() < 0.3) addHandprints(group, randSide(), rand(-3, -15));
      if (Math.random() < 0.25) addFootprints(group, randSide(), rand(-4, -14));
      break;
    }

    case 'video': {
      // 복도를 좁게 조여오는 VHS 진열장(빠진 자리 있음), 가끔 우물, 브라운관 TV
      for (const z of [-4.0, -9.0, -14.0]) {
        for (const side of [-1, 1]) {
          if (Math.random() > 0.85) continue;
          const len = rand(2.6, 3.4);
          const shelf = boxMesh(0.45, 2.15, len, Mat.vhsShelf());
          shelf.position.set(side * (SEG_W / 2 - 0.24), 1.075, z + rand(-0.3, 0.3));
          group.add(shelf);
        }
      }

      // 바닥에 흩어진 테이프
      if (Math.random() < 0.4) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const z = rand(-3, KEEP_CLEAR_Z);
        for (let k = 0; k < Math.floor(rand(3, 7)); k++) {
          const tape = boxMesh(0.19, 0.025, 0.1, Mat.plain(0x1c1c1c));
          tape.position.set(side * rand(HALF - 0.9, HALF - 0.55), 0.013, z + rand(-0.6, 0.6));
          tape.rotation.y = rand(0, Math.PI);
          group.add(tape);
        }
      }

      // 복도 한가운데 솟아 있는 돌 우물 테두리 (가끔)
      if (Math.random() < 0.25) {
        const well = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, 0.68, 18, 1, true), Mat.darkConcrete());
        well.position.set(0.35, 0.34, -11.2);
        group.add(well);

        const wellInside = new THREE.Mesh(new THREE.CircleGeometry(0.6, 16), Mat.black());
        wellInside.rotation.x = -Math.PI / 2;
        wellInside.position.set(0.35, 0.66, -11.2);
        group.add(wellInside);
      }

      // 바닥에 놓인 브라운관 TV 0~2대. 꺼져 있던 TV가 나중에 켜져 있기도 함
      const tvs = Math.floor(rand(0, 2.7));
      for (let k = 0; k < tvs; k++) {
        const on = Math.random() < 0.35;
        const tv = makeTV(on);
        const side = Math.random() < 0.5 ? -1 : 1;
        const z = rand(-3, KEEP_CLEAR_Z);
        placeOnFloor(tv.group, side, z, 'corridor');
        tv.group.position.x = side * (HALF - 0.75);
        tv.group.rotation.y += rand(-0.35, 0.35);
        group.add(tv.group);
        if (!on) spots.push({ x: tv.group.position.x, z, kind: 'tv', apply: () => tv.setOn(true) });
      }

      // 진열장 위 벽에 붙은 영화 포스터 (흐릿한 얼굴)
      if (Math.random() < 0.5) {
        const side = randSide();
        const n = Math.floor(rand(1, 4));
        const start = rand(-3, -7);
        for (let k = 0; k < n; k++) {
          const poster = plane(0.4, 0.55, Mat.poster(Math.floor(Math.random() * POSTER_VARIANTS)));
          poster.position.y = 2.5;
          onWall(poster, side, start - k * rand(1.6, 2.6), 0.02);
          poster.rotateZ(rand(-0.06, 0.06));
          group.add(poster);
        }
      }
      // 반납 카트 (복도 가운데를 막지 않게 벽 쪽 진열장 틈)
      if (Math.random() < 0.35) {
        const cart = addFloorProp(group, 'cart', randSide(), pick([-6.5, -11.5]) + rand(-0.3, 0.3), HALF - 0.8);
        cart.rotation.y += Math.PI / 2 + rand(-0.2, 0.2);
      }
      if (Math.random() < 0.15) addHandprints(group, randSide(), rand(-3, -15));
      if (Math.random() < 0.15) addFootprints(group, randSide(), rand(-4, -14));
      break;
    }

    case 'subway': {
      // 환승통로 안내판(출구는 없음), 얼굴 지워진 실종 전단지, 타일 기둥, 벤치
      // 글씨는 앞·뒷면에만, 옆·위·아랫면은 단색. 영어·일본어·한국어로 몇 초마다 바뀜.
      // 옆면 UV를 모두 판 왼쪽 바탕색 한 점(테두리와 글씨 사이)에 모아 재질 하나·드로콜 하나로 그림
      const signGeo = new THREE.BoxGeometry(1.7, 0.34, 0.08);
      const uv = signGeo.attributes.uv as THREE.BufferAttribute;
      for (let k = 0; k < 16; k++) uv.setXY(k, 25 / 512, 0.5); // ±x, ±y 면의 꼭짓점 16개
      const sign = new THREE.Mesh(signGeo, signMaterial(pick(SUBWAY_SIGNS), { w: 512, h: 128, bg: '#141414', fg: '#deded8', border: true }));
      sign.position.set(0, 2.55, rand(-4, -9));
      group.add(sign);

      // 같은 전단지가 줄지어 붙어 있음. 그중 하나가 나중에 조금 달라져 있음
      const side = Math.random() < 0.5 ? -1 : 1;
      const start = rand(-3, -6);
      const gap = rand(0.55, 0.75);
      const posters = Math.floor(rand(2, 6));
      const meshes: THREE.Mesh[] = [];
      const face = Math.floor(Math.random() * POSTER_VARIANTS); // 한 줄은 모두 같은 사람
      for (let k = 0; k < posters; k++) {
        const poster = plane(0.42, 0.58, Mat.poster(face));
        poster.position.y = 1.48 + rand(-0.04, 0.04);
        onWall(poster, side, start - k * gap, 0.02);
        poster.rotateZ(rand(-0.05, 0.05));
        group.add(poster);
        meshes.push(poster);
      }
      if (meshes.length >= 2) {
        const target = pick(meshes);
        spots.push({ x: side * (HALF - 0.6), z: target.position.z, kind: 'poster', apply: () => (target.material = Mat.posterBack()) });
      }

      if (Math.random() < 0.4) {
        for (const z of [rand(-9, -10), rand(-14, -15)]) {
          const s2 = Math.random() < 0.5 ? -1 : 1;
          const pillar = boxMesh(0.3, SEG_H, 0.5, Mat.subwayTile());
          pillar.position.set(s2 * (HALF - 0.15), SEG_H / 2, z);
          group.add(pillar);
        }
      }

      if (Math.random() < 0.3) {
        const s3 = -side;
        const z = rand(-4, KEEP_CLEAR_Z);
        const seat = boxMesh(0.4, 0.06, 1.6, Mat.metal());
        seat.position.set(s3 * (HALF - 0.25), 0.45, z);
        group.add(seat);
        for (const dz of [-0.65, 0.65]) {
          const leg = boxMesh(0.05, 0.45, 0.05, Mat.darkMetal());
          leg.position.set(s3 * (HALF - 0.25), 0.225, z + dz);
          group.add(leg);
        }
      }

      // 쓰레기통, 소화기, 젖은 발자국, 타일 벽 손자국
      if (Math.random() < 0.3) addFloorProp(group, 'trashbin', -side, rand(-2, -6), HALF - 0.26);
      if (Math.random() < 0.15) addFloorProp(group, 'extinguisher', side, rand(-11, -15), HALF - 0.14);
      if (Math.random() < 0.3) addFootprints(group, randSide(), rand(-4, -14));
      if (Math.random() < 0.2) addHandprints(group, -side, rand(-7, -15));
      break;
    }
  }
}
