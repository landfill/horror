/**
 * 끝없이 이어지는 격자형 복도 미로의 규칙.
 *
 * - 격자 점(i, j)마다 정사각형 교차로(junction)가 있고,
 *   이웃한 교차로 사이를 길이 18m 복도가 잇습니다.
 * - 어떤 복도가 열려 있는지는 처음 필요할 때 무작위로 정하고, 주변이 로드돼 있는 동안만 기억합니다.
 *   멀어져서 잊힌 곳은 돌아오면 다시 정해지므로 지나온 길이 바뀌어 있습니다.
 *   (보이지 않는 곳의 복도는 EndlessWorld가 실시간으로 열고 닫기도 합니다.)
 * - 4칸마다 끊기지 않는 큰 길이 있어 작은 공간에 갇히는 일이 없습니다.
 * - 이동 가능 영역은 직사각형들의 합집합으로 표현하고, 그 밖으로는 못 나갑니다.
 */

export const SEG_LEN = 18; // 복도 길이 (m)
export const SEG_W = 3.2; // 복도 폭 = 교차로 한 변 (m)
export const SEG_H = 3.1; // 천장 높이 (m)
export const HALF = SEG_W / 2;
export const GRID = SEG_LEN + SEG_W; // 교차로 중심 간 거리
export const DOOR_HALF = 0.47; // 문틀 통과 가능 반폭
const MARGIN = 0.35; // 벽과 몸 사이 최소 거리
const OPEN_P = 0.55;
const HIGHWAY_EVERY = 4;

export type ZoneKind = 'school' | 'apt404' | 'tatami' | 'video' | 'subway';
const ZONE_KINDS: ZoneKind[] = ['school', 'apt404', 'tatami', 'video', 'subway'];
const REGION = 3; // 테마는 3x3 교차로 단위로 묶음 (모퉁이마다 테마가 바뀌지 않게)

export type Dir = 'N' | 'E' | 'S' | 'W';
/** N = -z, E = +x, S = +z, W = -x */
export const DIRS: Record<Dir, { di: number; dj: number }> = {
  N: { di: 0, dj: -1 },
  E: { di: 1, dj: 0 },
  S: { di: 0, dj: 1 },
  W: { di: -1, dj: 0 },
};


const mod = (a: number, n: number) => ((a % n) + n) % n;

// ---------------------------------------------------------------------------
// 복도 열림 상태 (기억 → 잊힘 → 다시 정해짐)
// ---------------------------------------------------------------------------

/** 정규화된 복도 키. 세로 'v:i,j' = (i,j-1)~(i,j), 가로 'h:i,j' = (i,j)~(i+1,j) */
export interface EdgeRef {
  key: string;
  vertical: boolean;
  i: number;
  j: number;
}

export function edgeRef(i: number, j: number, dir: Dir): EdgeRef {
  switch (dir) {
    case 'N':
      return { key: `v:${i},${j}`, vertical: true, i, j };
    case 'S':
      return { key: `v:${i},${j + 1}`, vertical: true, i, j: j + 1 };
    case 'E':
      return { key: `h:${i},${j}`, vertical: false, i, j };
    case 'W':
      return { key: `h:${i - 1},${j}`, vertical: false, i: i - 1, j };
  }
}

/** 복도 양 끝 교차로 */
export function edgeEnds(e: EdgeRef): [[number, number], [number, number]] {
  return e.vertical
    ? [
        [e.i, e.j - 1],
        [e.i, e.j],
      ]
    : [
        [e.i, e.j],
        [e.i + 1, e.j],
      ];
}

export function isHighway(e: EdgeRef): boolean {
  return e.vertical ? mod(e.i, HIGHWAY_EVERY) === 0 : mod(e.j, HIGHWAY_EVERY) === 0;
}

const edgeState = new Map<string, boolean>();

export function edgeOpen(i: number, j: number, dir: Dir): boolean {
  const e = edgeRef(i, j, dir);
  if (isHighway(e)) return true;
  let v = edgeState.get(e.key);
  if (v === undefined) {
    v = Math.random() < OPEN_P;
    edgeState.set(e.key, v);
  }
  return v;
}

/** 보이지 않는 곳의 복도를 열거나 닫음 (큰 길은 바꾸지 않음) */
export function setEdgeOpen(e: EdgeRef, open: boolean): void {
  if (isHighway(e)) return;
  edgeState.set(e.key, open);
}

// 테마: 3x3 구역 단위. 구역이 통째로 잊히면 다시 정해짐.
const regionTheme = new Map<string, ZoneKind>();

export function zoneOf(i: number, j: number): ZoneKind {
  const ri = Math.floor(i / REGION);
  const rj = Math.floor(j / REGION);
  const k = `${ri},${rj}`;
  let z = regionTheme.get(k);
  if (!z) {
    z = ri === 0 && rj === 0 && regionTheme.size === 0 ? 'school' : ZONE_KINDS[Math.floor(Math.random() * ZONE_KINDS.length)];
    regionTheme.set(k, z);
  }
  return z;
}

/**
 * 로드된 교차로와 닿아 있지 않은 복도/구역 기억을 지움.
 * 다음에 그곳에 가면 새로 정해짐 → 지나온 길이 바뀌어 있음.
 */
export function forgetOutside(isLoaded: (i: number, j: number) => boolean): void {
  for (const k of [...edgeState.keys()]) {
    const [t, rest] = k.split(':');
    const [i, j] = rest.split(',').map(Number);
    const ends = edgeEnds({ key: k, vertical: t === 'v', i, j });
    if (!isLoaded(ends[0][0], ends[0][1]) && !isLoaded(ends[1][0], ends[1][1])) edgeState.delete(k);
  }
  for (const k of [...regionTheme.keys()]) {
    const [ri, rj] = k.split(',').map(Number);
    let any = false;
    for (let a = 0; a < REGION && !any; a++) {
      for (let b = 0; b < REGION && !any; b++) {
        if (isLoaded(ri * REGION + a, rj * REGION + b)) any = true;
      }
    }
    if (!any) regionTheme.delete(k);
  }
}

export function nodeCenter(i: number, j: number): { x: number; z: number } {
  return { x: i * GRID, z: j * GRID };
}

export function nearestNode(x: number, z: number): { i: number; j: number } {
  return { i: Math.round(x / GRID), j: Math.round(z / GRID) };
}

/**
 * 복도의 로컬 좌표계: 소유 교차로의 가장자리가 원점, 복도는 로컬 -z 방향으로 18m.
 * 각 교차로는 자기 N 복도와 E 복도를 소유합니다 (중복 생성 방지).
 */
export interface CorridorFrame {
  ox: number;
  oz: number;
  /** 그룹의 rotation.y */
  rotY: number;
  dir: 'N' | 'E';
}

export function corridorFrame(i: number, j: number, dir: 'N' | 'E'): CorridorFrame {
  const c = nodeCenter(i, j);
  if (dir === 'N') return { ox: c.x, oz: c.z - HALF, rotY: 0, dir };
  return { ox: c.x + HALF, oz: c.z, rotY: -Math.PI / 2, dir };
}

export function corridorToWorld(f: CorridorFrame, lx: number, lz: number): { x: number; z: number } {
  if (f.dir === 'N') return { x: f.ox + lx, z: f.oz + lz };
  // rotY = -90°: 로컬 -z → 월드 +x, 로컬 +x → 월드 +z
  return { x: f.ox - lz, z: f.oz + lx };
}

// ---------------------------------------------------------------------------
// 이동 가능 영역
// ---------------------------------------------------------------------------

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function rectFromLocal(f: CorridorFrame, lx0: number, lx1: number, lz0: number, lz1: number): Rect {
  const a = corridorToWorld(f, lx0, lz0);
  const b = corridorToWorld(f, lx1, lz1);
  return {
    x0: Math.min(a.x, b.x),
    x1: Math.max(a.x, b.x),
    z0: Math.min(a.z, b.z),
    z1: Math.max(a.z, b.z),
  };
}

/** 복도 끝(로컬 z = -SEG_LEN)의 문틀 벽 위치 */
export const DOOR_WALL_Z = -SEG_LEN + 0.14;
const DOOR_WALL_THICK = 0.28;

/** 문틀의 실제 열린 반폭 (CorridorBuilder의 doorOpenW / 2) */
const DOOR_OPEN_HALF = 0.675;

function corridorRects(i: number, j: number, dir: 'N' | 'E', out: Rect[], m: number): void {
  const f = corridorFrame(i, j, dir);
  const doorNear = DOOR_WALL_Z + DOOR_WALL_THICK / 2; // 문틀 벽의 복도 쪽 면
  const doorHalf = m === MARGIN ? DOOR_HALF : DOOR_OPEN_HALF - m;
  // 복도 본체: 소유 교차로 안쪽으로 조금 겹치게
  out.push(rectFromLocal(f, -HALF + m, HALF - m, doorNear + m, 0.6));
  // 문틀 통로: 본체와 반대편 교차로 양쪽에 겹치게
  out.push(rectFromLocal(f, -doorHalf, doorHalf, -SEG_LEN - 0.6, doorNear + m + 0.3));
}

function junctionRect(i: number, j: number, m: number): Rect {
  const c = nodeCenter(i, j);
  return {
    x0: c.x - HALF + m,
    x1: c.x + HALF - m,
    z0: c.z - HALF + m,
    z1: c.z + HALF - m,
  };
}

/**
 * (x, z) 주변 3x3 교차로 범위의 이동 가능 직사각형.
 * m = 벽과의 여유. 이동은 몸 두께만큼(MARGIN), 시선 판정은 거의 0으로 실제 벽 위치를 씀.
 */
export function walkableRectsNear(x: number, z: number, m = MARGIN): Rect[] {
  const { i, j } = nearestNode(x, z);
  const out: Rect[] = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const ni = i + di;
      const nj = j + dj;
      out.push(junctionRect(ni, nj, m));
      if (edgeOpen(ni, nj, 'N')) corridorRects(ni, nj, 'N', out, m);
      if (edgeOpen(ni, nj, 'E')) corridorRects(ni, nj, 'E', out, m);
    }
  }
  return out;
}

export function inRects(rects: Rect[], x: number, z: number, pad = 0): boolean {
  for (const r of rects) {
    if (x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad) return true;
  }
  return false;
}

export function isWalkable(x: number, z: number): boolean {
  return inRects(walkableRectsNear(x, z), x, z);
}

/**
 * 이전 위치(prev)에서 원하는 위치(nx, nz)로 갈 때 벽에 막히면 한 축씩 미끄러지게 함.
 */
export function resolveMove(px: number, pz: number, nx: number, nz: number): { x: number; z: number } {
  const rects = walkableRectsNear(nx, nz);
  if (inRects(rects, nx, nz)) return { x: nx, z: nz };
  if (inRects(rects, nx, pz)) return { x: nx, z: pz };
  if (inRects(rects, px, nz)) return { x: px, z: nz };
  return { x: px, z: pz };
}

/**
 * 두 점 사이에 벽이 없는지 (눈높이 기준).
 * 선분을 일정 간격으로 샘플링해 모두 이동 가능 영역(여유 포함) 안이면 보이는 것으로 판단.
 */
export function hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
  const dist = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(2, Math.ceil(dist / 0.4));
  const LOS_M = 0.01;
  // 긴 시선도 정확하게: 샘플 지점마다 가까운 교차로 주변의 직사각형을 씀 (교차로별 캐시)
  const cache = new Map<string, Rect[]>();
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const n = nearestNode(x, z);
    const key = `${n.i},${n.j}`;
    let rects = cache.get(key);
    if (!rects) {
      rects = walkableRectsNear(x, z, LOS_M);
      cache.set(key, rects);
    }
    if (!inRects(rects, x, z)) return false;
  }
  return true;
}

/** corridorToWorld의 역변환 */
export function worldToCorridor(f: CorridorFrame, x: number, z: number): { lx: number; lz: number } {
  if (f.dir === 'N') return { lx: x - f.ox, lz: z - f.oz };
  return { lx: z - f.oz, lz: f.ox - x };
}
