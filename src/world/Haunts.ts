import * as THREE from 'three';
import { SoundManager } from '../audio/SoundManager';
import { GhostRole } from '../ghost/clips';
import { VideoGhost } from '../ghost/VideoGhost';
import { VideoClipPool } from '../ghost/VideoClipPool';
import { LightPool } from './Lighting';
import {
  CorridorFrame,
  DIRS,
  Dir,
  HALF,
  SEG_H,
  SEG_W,
  ZoneKind,
  corridorToWorld,
  edgeOpen,
  hasLineOfSight,
  nearestNode,
  nodeCenter,
  worldToCorridor,
} from './Maze';
import type { EndlessWorld } from './EndlessWorld';
import { pick, rand } from './Textures';

export type HauntKind =
  | 'approach' // 복도 끝에서 아주 느리게 다가옴
  | 'watcher' // 서서 지켜보다가 다시 보면 없어져 있음
  | 'ceiling' // 천장에 붙어 내려다봄
  | 'wallcrawl' // 벽을 기어옴. 보고 있으면 멈추고, 안 보면 다가옴
  | 'floorcrawl' // 바닥을 기어옴
  | 'peek' // 교차로 모퉁이에서 내다보다 숨음
  | 'suspended' // 허공에 매달려 있음
  | 'crouched' // 벽 아래 웅크림
  | 'follower'; // 돌아볼 때마다 더 가까이 와 있음

const params = new URLSearchParams(location.search);
/** ?debug=ghosts : 모든 구간에 귀신 배치, 쿨다운 없음 */
const DEBUG = params.get('debug') === 'ghosts';
/** ?debug=ghosts&haunt=ceiling : 한 종류만 강제 */
const FORCE = (params.get('haunt') as HauntKind | null) ?? null;

const ACTIVATE_DIST = 24; // 이 거리 안에 들어오면 (안 보일 때) 나타날 준비
const DEACTIVATE_DIST = 34;
const SEE_DIST = 22;
const SEE_COS = 0.72; // 시야 중심에서 약 44도 안쪽

const CORRIDOR_KINDS: Record<ZoneKind, HauntKind[]> = {
  school: ['approach', 'watcher', 'ceiling', 'wallcrawl'],
  apt404: ['suspended', 'ceiling', 'wallcrawl', 'watcher'],
  tatami: ['crouched', 'ceiling', 'wallcrawl'],
  video: ['floorcrawl', 'ceiling', 'floorcrawl'],
  subway: ['approach', 'wallcrawl', 'watcher'],
};

const ROLE: Record<HauntKind, GhostRole> = {
  approach: 'approach',
  watcher: 'standing',
  ceiling: 'ceiling',
  wallcrawl: 'wallcrawl',
  floorcrawl: 'crawling',
  peek: 'peeking',
  suspended: 'suspended',
  crouched: 'crouched',
  follower: 'standing',
};

interface Haunt {
  id: number;
  cell: string;
  kind: HauntKind;
  frame?: CorridorFrame;
  junction?: { i: number; j: number };
  /** 복도 로컬 좌표 (복도형 귀신) */
  lx: number;
  lz: number;
  /** 벽 쪽 (-1 왼쪽 / 1 오른쪽) */
  side: number;
  zone?: ZoneKind;
  /** 엿보기: 숨는 방향 */
  peekDir?: { x: number; z: number };
  ghost: VideoGhost | null;
  done: boolean;
  seenTime: number;
  unseenTime: number;
  everSeen: boolean;
  moved: number;
  minDist: number;
  soundTimer: number;
  cued: boolean;
}

interface Crumb {
  x: number;
  z: number;
  s: number; // 누적 경로 길이
}

/**
 * 귀신 연출 관리.
 * - 한 번에 하나만 활성화됨 (여러 개가 동시에 튀어나오면 무섭지 않고 시끄러움)
 * - 플레이어가 보고 있는 동안에는 절대 나타나거나 순간이동하지 않음
 * - 하나가 끝나면 한동안 쉼
 */
export class Haunts {
  private haunts: Haunt[] = [];
  private active: Haunt | null = null;
  private nextId = 1;
  private cooldown = DEBUG ? 0 : 20;

  // 추적자(follower): 플레이어가 지나온 길을 그대로 따라옴
  private crumbs: Crumb[] = [];
  private follower: Haunt | null = null;
  private followerS = 0;
  private followerStage = 0;
  private followerTimer = FORCE === 'follower' ? 3 : DEBUG ? 20 : rand(60, 100);
  private followerWasSeen = false;

  private camPos = new THREE.Vector3();
  private lastSeenDebug: object = {};
  private camFwd = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private sound: SoundManager,
    private pool: VideoClipPool,
    private lights: LightPool,
    private world: EndlessWorld
  ) {}

  // -------------------------------------------------------------------------
  // 배치
  // -------------------------------------------------------------------------

  private nearStart(key: string): boolean {
    const m = key.match(/(-?\d+),(-?\d+)/);
    if (!m) return false;
    return Math.abs(Number(m[1])) + Math.abs(Number(m[2])) <= 1;
  }

  public onCorridorBuilt(cell: string, zone: ZoneKind, frame: CorridorFrame, _group: THREE.Group): void {
    if (FORCE === 'peek' || FORCE === 'follower') return;
    if (!DEBUG && this.nearStart(cell)) return;
    if (!DEBUG && Math.random() > 0.3) return;
    const kind = FORCE ?? pick(CORRIDOR_KINDS[zone]);
    // 학교 복도는 오른쪽 벽에 사물함이 있어 벽 귀신이 묻힘 → 왼쪽 벽만
    const side = zone === 'school' ? -1 : Math.random() < 0.5 ? -1 : 1;
    this.haunts.push(this.newHaunt(cell, kind, { frame, zone, side }));
  }

  public onJunctionBuilt(cell: string, i: number, j: number, _zone: ZoneKind, _root: THREE.Group): void {
    if (FORCE && FORCE !== 'peek') return;
    if (!DEBUG && this.nearStart(cell)) return;
    const p = FORCE === 'peek' ? 1 : DEBUG ? 0.3 : 0.12;
    if (Math.random() > p) return;
    this.haunts.push(this.newHaunt(cell, 'peek', { junction: { i, j } }));
  }

  private newHaunt(cell: string, kind: HauntKind, extra: Partial<Haunt>): Haunt {
    return {
      id: this.nextId++,
      cell,
      kind,
      lx: 0,
      lz: -12,
      side: Math.random() < 0.5 ? -1 : 1,
      ghost: null,
      done: false,
      seenTime: 0,
      unseenTime: 0,
      everSeen: false,
      moved: 0,
      minDist: Infinity,
      soundTimer: 0,
      cued: false,
      ...extra,
    };
  }

  public onCellDisposed(cell: string): void {
    for (const h of this.haunts) {
      if (h.cell === cell) this.release(h);
    }
    this.haunts = this.haunts.filter((h) => h.cell !== cell);
  }

  // -------------------------------------------------------------------------
  // 공통 도구
  // -------------------------------------------------------------------------

  /** 귀신의 중심(밝기·시선 판정 기준점) */
  private center(h: Haunt): THREE.Vector3 {
    if (h.kind === 'follower' && h.ghost) {
      const p = h.ghost.root.position;
      return new THREE.Vector3(p.x, 1.0, p.z);
    }
    if (h.kind === 'peek' && h.ghost) {
      const p = h.ghost.root.position;
      return new THREE.Vector3(p.x, 1.2, p.z);
    }
    if (!h.frame) return new THREE.Vector3();
    let lz = h.lz;
    let lx = h.lx;
    let y = 1.0;
    switch (h.kind) {
      case 'ceiling':
        // 매달린 영상은 몸 가운데(천장 아래 약 0.7m), 천장에 누운 판은 천장 바로 아래
        y = h.ghost?.hangs ? SEG_H - 0.7 : SEG_H - 0.1;
        break;
      case 'wallcrawl':
        y = 1.55;
        lz = h.lz + this.headSign(h) * 0.95;
        lx = h.side * (HALF - 0.08);
        break;
      case 'floorcrawl':
        y = 0.35;
        break;
      case 'suspended':
        y = 1.3;
        break;
      case 'crouched':
        y = 0.6;
        break;
    }
    const w = corridorToWorld(h.frame, lx, lz);
    return new THREE.Vector3(w.x, y, w.z);
  }

  /** 시야 안에 있고 벽에 가려지지 않았는지 */
  private isSeen(p: THREE.Vector3): boolean {
    const v = p.clone().sub(this.camPos);
    const d = v.length();
    if (d > SEE_DIST) return false;
    if (d > 0.5 && v.divideScalar(d).dot(this.camFwd) < SEE_COS) return false;
    if (d < 1.5) return true;
    return hasLineOfSight(this.camPos.x, this.camPos.z, p.x, p.z);
  }

  private flatDist(p: THREE.Vector3): number {
    return Math.hypot(p.x - this.camPos.x, p.z - this.camPos.z);
  }

  private release(h: Haunt): void {
    if (h.ghost) {
      this.scene.remove(h.ghost.root);
      h.ghost.dispose();
      h.ghost = null;
    }
    if (this.active === h) this.active = null;
    if (this.follower === h) this.follower = null;
  }

  private finish(h: Haunt, rest = 25): void {
    h.done = true;
    this.release(h);
    this.cooldown = DEBUG ? 2 : rest;
  }

  /** 마주침: 불이 나가고 화면이 찢기며 사라짐 */
  private jolt(h: Haunt, at: THREE.Vector3): void {
    this.world.flash(0.04, 0.65);
    this.sound.playVhsStatic(0.45);
    this.sound.playDeathRattle({ x: at.x, y: Math.min(at.y + 0.6, SEG_H), z: at.z });
    this.lights.killNearest(at.x, at.z);
    this.finish(h, 35);
  }

  /** 다시 보면 없어져 있음 (조용히) */
  private vanishQuietly(h: Haunt): void {
    this.finish(h, 20);
  }

  // -------------------------------------------------------------------------
  // 활성화 (보이지 않는 곳에서만 나타남)
  // -------------------------------------------------------------------------

  private tryActivate(): void {
    let best: Haunt | null = null;
    let bestD = Infinity;
    for (const h of this.haunts) {
      if (h.done || h.ghost) continue;
      const anchor = this.anchorPreview(h);
      if (!anchor) continue;
      const d = this.flatDist(anchor);
      if (d < ACTIVATE_DIST && d > 3 && d < bestD) {
        best = h;
        bestD = d;
      }
    }
    if (!best) return;
    if (!this.place(best)) {
      this.cooldown = 0.5;
      return;
    }
    if (this.isSeen(this.center(best))) {
      // 보이는 곳에서 갑자기 생기면 안 됨 → 잠시 뒤 다시 시도
      this.release(best);
      this.cooldown = 1;
      return;
    }
    this.active = best;
  }

  /** 대략적인 위치 (활성화 거리 판정용) */
  private anchorPreview(h: Haunt): THREE.Vector3 | null {
    if (h.frame) {
      const w = corridorToWorld(h.frame, 0, -9);
      return new THREE.Vector3(w.x, 1, w.z);
    }
    if (h.junction) {
      const c = nodeCenter(h.junction.i, h.junction.j);
      return new THREE.Vector3(c.x, 1, c.z);
    }
    return null;
  }

  /** 플레이어 위치를 보고 실제 자리를 정하고 영상 귀신을 만듦 */
  private place(h: Haunt): boolean {
    if (h.kind === 'peek') return this.placePeek(h);
    if (!h.frame) return false;

    // 플레이어가 들어올 쪽의 반대편 끝에 배치
    const pl = worldToCorridor(h.frame, this.camPos.x, this.camPos.z);
    const playerAtStart = pl.lz > -9;
    const far = () => (playerAtStart ? rand(-14.5, -11) : rand(-7, -3.5));
    const mid = () => (playerAtStart ? rand(-12, -8) : rand(-10, -6));

    const role = ROLE[h.kind];
    let g: VideoGhost;
    switch (h.kind) {
      case 'ceiling': {
        g = new VideoGhost(role, this.pool, { billboard: false, shadow: false });
        h.lx = rand(-0.4, 0.4);
        h.lz = mid();
        // 위에서 찍은 영상은 천장에 눕힘 (얼굴이 아래를 향하고, 머리는 복도 시작(+z) 쪽).
        // 매달린 옆모습 영상은 VideoGhost가 천장에서 늘어뜨려 플레이어를 향하게 함.
        if (!g.hangs) g.body.rotation.x = Math.PI / 2;
        break;
      }
      case 'wallcrawl': {
        g = new VideoGhost(role, this.pool, { billboard: false, shadow: false });
        h.lz = far();
        h.lx = h.side * (HALF - 0.03);
        g.body.position.y = 1.55; // 눈높이 근처, 벽 높은 곳
        break;
      }
      case 'crouched': {
        g = new VideoGhost(role, this.pool);
        h.lz = far();
        h.lx = h.side * (HALF - 0.45);
        break;
      }
      case 'suspended': {
        g = new VideoGhost(role, this.pool, { shadow: false });
        h.lz = mid();
        h.lx = rand(-0.3, 0.3);
        break;
      }
      default: {
        g = new VideoGhost(role, this.pool);
        h.lz = far();
        h.lx = rand(-0.35, 0.35);
      }
    }
    h.ghost = g;
    g.root.rotation.y = h.frame.rotY;
    this.scene.add(g.root);
    this.syncCorridorGhost(h);
    return true;
  }

  /** 교차로 모퉁이: 플레이어가 다가오는 복도 쪽 벽에 몸을 반쯤 숨기고 옆 복도에서 내다봄 */
  private placePeek(h: Haunt): boolean {
    if (!h.junction) return false;
    const { i, j } = h.junction;
    const c = nodeCenter(i, j);
    const vx = this.camPos.x - c.x;
    const vz = this.camPos.z - c.z;
    const dist = Math.hypot(vx, vz);
    if (dist < 6 || dist > 18) return false;
    const approach: Dir = Math.abs(vx) > Math.abs(vz) ? (vx > 0 ? 'E' : 'W') : vz > 0 ? 'S' : 'N';
    // 플레이어가 그 복도 안에 정면으로 있을 때만 (모퉁이 너머가 보이는 각도)
    if (Math.min(Math.abs(vx), Math.abs(vz)) > HALF - 0.3) return false;
    if (!edgeOpen(i, j, approach)) return false;
    const a = DIRS[approach];
    const sides = (Object.keys(DIRS) as Dir[]).filter(
      (d) => d !== approach && edgeOpen(i, j, d) && DIRS[d].di * a.di + DIRS[d].dj * a.dj === 0
    );
    if (sides.length === 0) return false;
    const d = DIRS[pick(sides)];
    // 교차로 안, 플레이어 쪽 문틀 가장자리에 몸이 반쯤 걸리는 자리 → 옆 복도로 숨음
    const x = c.x + d.di * 0.8 - a.di * 0.2;
    const z = c.z + d.dj * 0.8 - a.dj * 0.2;
    h.peekDir = { x: d.di, z: d.dj };
    const g = new VideoGhost(ROLE.peek, this.pool);
    g.root.position.set(x, 0, z);
    h.ghost = g;
    this.scene.add(g.root);
    return true;
  }

  /** 플레이어가 그 복도 안이나 양 끝 교차로에 있는지 (복도 로컬 좌표) */
  private inCorridorView(pl: { lx: number; lz: number }): boolean {
    return Math.abs(pl.lx) < HALF + 0.3 && pl.lz < SEG_W && pl.lz > -18 - SEG_W;
  }

  private headSign(h: Haunt): number {
    // 벽을 기는 귀신은 플레이어 쪽으로 머리를 둠
    const pl = h.frame ? worldToCorridor(h.frame, this.camPos.x, this.camPos.z) : { lz: 0 };
    return pl.lz > h.lz ? 1 : -1;
  }

  private syncCorridorGhost(h: Haunt): void {
    if (!h.ghost || !h.frame) return;
    const g = h.ghost;
    if (h.kind === 'ceiling') {
      // 천장에 누운 판은 발 쪽이 원점이므로 중심이 (lx, lz)에 오도록 0.95m 당김
      const w = corridorToWorld(h.frame, h.lx, g.hangs ? h.lz : h.lz - 0.95);
      g.root.position.set(w.x, SEG_H - 0.03, w.z);
      return;
    }
    const w = corridorToWorld(h.frame, h.lx, h.lz);
    g.root.position.set(w.x, h.kind === 'suspended' ? 0.3 : 0, w.z);
    if (h.kind === 'wallcrawl') {
      // 벽을 향해 눕히고(안쪽을 보게), 머리가 이동 방향을 향하도록 굴림
      const s = this.headSign(h);
      const roll = h.side === -1 ? (s * Math.PI) / 2 : (-s * Math.PI) / 2;
      g.body.quaternion.setFromEuler(new THREE.Euler(0, h.side === -1 ? Math.PI / 2 : -Math.PI / 2, roll, 'YXZ'));
    }
  }

  // -------------------------------------------------------------------------
  // 매 프레임
  // -------------------------------------------------------------------------

  public update(dt: number, elapsed: number, playerPos: THREE.Vector3, camForward: THREE.Vector3, isMoving: boolean): void {
    this.camPos.copy(playerPos);
    this.camFwd.copy(camForward).normalize();
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.recordCrumb(playerPos);

    // 1. 활성 귀신이 없으면 하나 준비
    if (!this.active && this.cooldown <= 0) this.tryActivate();

    // 2. 추적자 등장 시도
    this.followerTimer -= dt;
    if (!this.active && this.cooldown <= 0 && this.followerTimer <= 0) {
      this.followerTimer = 1;
      this.spawnFollower(12);
    }

    // 3. 활성 귀신 행동
    const h = this.active;
    if (!h || !h.ghost) return;

    const c = this.center(h);
    const dist = this.flatDist(c);
    const seen = this.isSeen(c);
    this.lastSeenDebug = { seen, dist: +dist.toFixed(2), c: c.toArray().map((v) => +v.toFixed(2)) };
    if (seen) {
      h.seenTime += dt;
      h.unseenTime = 0;
      h.everSeen = true;
    } else {
      h.unseenTime += dt;
      if (h.unseenTime > 0.3) h.seenTime = 0;
    }

    // 너무 멀어지면 내려놓음 (나중에 다시 나타날 수 있음)
    if (h.kind !== 'follower' && dist > DEACTIVATE_DIST) {
      this.release(h);
      return;
    }

    switch (h.kind) {
      case 'approach':
      case 'floorcrawl':
        this.updateApproach(h, dt, dist, c);
        break;
      case 'watcher':
      case 'suspended':
      case 'crouched':
        this.updateWatcher(h, dist, seen);
        break;
      case 'ceiling':
        this.updateCeiling(h, dist, seen, c);
        break;
      case 'wallcrawl':
        this.updateWallCrawl(h, dt, dist, seen, c);
        break;
      case 'peek':
        this.updatePeek(h, dt, dist, seen);
        break;
      case 'follower':
        this.updateFollower(h, dt, seen, isMoving);
        break;
    }

    if (h.ghost) {
      h.ghost.update(dt, elapsed, { cameraPos: this.camPos, light: this.lights.lightAt(c.x, c.y, c.z) });
    }
  }

  /** 복도 끝에서 극도로 느리게 다가옴. 코앞까지 오면 마주침. */
  private updateApproach(h: Haunt, dt: number, dist: number, c: THREE.Vector3): void {
    const g = h.ghost!;
    const pl = worldToCorridor(h.frame!, this.camPos.x, this.camPos.z);
    if (this.inCorridorView(pl) && dist < 16 && dist > 1.4) {
      const speed = h.kind === 'floorcrawl' ? 0.18 : 0.24;
      h.lz += Math.sign(pl.lz - h.lz) * speed * dt;
      g.setReversed(h.kind === 'approach');
      this.syncCorridorGhost(h);
    } else {
      g.setReversed(false);
    }
    if (dist < 1.4) this.jolt(h, c);
  }

  /** 서서 지켜봄. 한 번 본 뒤 시선을 돌렸다 다시 보면 없어져 있음. 가까이 가면 사라짐. */
  private updateWatcher(h: Haunt, dist: number, seen: boolean): void {
    if (h.everSeen && !seen && h.unseenTime > 0.6 && h.seenTime === 0) {
      this.vanishQuietly(h);
      return;
    }
    if (dist < 4) {
      this.world.flash(0.15, 0.3);
      this.sound.playFootstep(true, { x: this.camPos.x, y: 0.1, z: this.camPos.z });
      this.finish(h, 25);
    }
  }

  /**
   * 천장: 아래를 지나갈 때 올려다보면 마주침.
   * 올려다보지 않고 지나치면 등 뒤로 떨어져 내려와 따라오기 시작함.
   */
  private updateCeiling(h: Haunt, dist: number, seen: boolean, c: THREE.Vector3): void {
    h.minDist = Math.min(h.minDist, dist);
    if (!h.cued && dist < 6 && !seen) {
      h.cued = true;
      // 머리 위에서 나는 작은 소리 (올려다보게 만드는 단서)
      if (Math.random() < 0.6) this.sound.playCreak({ x: c.x, y: SEG_H, z: c.z }, '[천장에서 삐걱거림]');
    }
    // 바로 아래에서 올려다보면 마주침
    if (seen && dist < 3.5 && h.seenTime > 0.6) {
      this.jolt(h, c);
      return;
    }
    // 멀리서 발견했다면: 시선을 돌린 사이 천장에서 사라짐. 가끔은 등 뒤로 내려와 따라옴.
    if (h.everSeen && !seen && h.unseenTime > 0.8) {
      const follow = Math.random() < 0.5;
      this.vanishQuietly(h);
      if (follow) {
        this.cooldown = 0;
        this.spawnFollowerAt(c.x, c.z);
      }
      return;
    }
    if (h.minDist < 1.8 && dist > 4 && !h.everSeen) {
      // 툭 떨어지는 소리 → 등 뒤에서 따라오기 시작
      this.sound.playFootstep(true, { x: c.x, y: 0.1, z: c.z });
      this.sound.playFootstep(false, { x: c.x, y: 0.1, z: c.z });
      this.finish(h, 0);
      this.spawnFollowerAt(c.x, c.z);
    }
  }

  /** 벽을 기어옴: 보고 있으면 그대로 멈춰 있고, 시선을 돌리면 다가옴 */
  private updateWallCrawl(h: Haunt, dt: number, dist: number, seen: boolean, c: THREE.Vector3): void {
    const g = h.ghost!;
    const pl = worldToCorridor(h.frame!, this.camPos.x, this.camPos.z);
    if (seen) {
      g.freeze = true;
      if (dist < 2.8 && h.seenTime > 0.25) this.jolt(h, c);
      return;
    }
    g.freeze = false;
    if (!this.inCorridorView(pl) || dist < 2.6) return;
    const speed = h.everSeen ? 1.1 : 0.45;
    h.lz += Math.sign(pl.lz - h.lz) * speed * dt;
    this.syncCorridorGhost(h);
    h.soundTimer -= dt;
    if (h.soundTimer <= 0) {
      h.soundTimer = rand(0.8, 1.8);
      if (Math.random() < 0.5) this.sound.playFootstep(true, { x: c.x, y: c.y, z: c.z });
    }
  }

  /** 모퉁이에서 내다보다가 눈이 마주치면 옆 복도로 스르륵 숨음 */
  private updatePeek(h: Haunt, dt: number, dist: number, seen: boolean): void {
    const g = h.ghost!;
    if ((seen && h.seenTime > 0.45) || dist < 4 || h.moved > 0) {
      const step = 1.3 * dt;
      g.root.position.x += h.peekDir!.x * step;
      g.root.position.z += h.peekDir!.z * step;
      if (h.moved === 0) this.sound.playFootstep(true, { x: g.root.position.x, y: 0.1, z: g.root.position.z });
      h.moved += step;
      if (h.moved > 2.2) this.vanishQuietly(h);
    }
  }

  // -------------------------------------------------------------------------
  // 추적자: 돌아볼 때마다 더 가까이 와 있음
  // -------------------------------------------------------------------------

  private recordCrumb(p: THREE.Vector3): void {
    const last = this.crumbs[this.crumbs.length - 1];
    if (!last) {
      this.crumbs.push({ x: p.x, z: p.z, s: 0 });
      return;
    }
    const d = Math.hypot(p.x - last.x, p.z - last.z);
    if (d < 0.4) return;
    this.crumbs.push({ x: p.x, z: p.z, s: last.s + d });
    if (this.crumbs.length > 400) this.crumbs.shift();
  }

  private playerS(): number {
    const last = this.crumbs[this.crumbs.length - 1];
    if (!last) return 0;
    return last.s + Math.hypot(this.camPos.x - last.x, this.camPos.z - last.z);
  }

  private pointAt(s: number): { x: number; z: number } {
    const cr = this.crumbs;
    if (cr.length === 0) return { x: this.camPos.x, z: this.camPos.z };
    if (s <= cr[0].s) return { x: cr[0].x, z: cr[0].z };
    for (let k = cr.length - 1; k > 0; k--) {
      if (cr[k - 1].s <= s) {
        const a = cr[k - 1];
        const b = cr[k];
        const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
        return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      }
    }
    const last = cr[cr.length - 1];
    return { x: last.x, z: last.z };
  }

  private spawnFollower(behind: number): void {
    if (this.follower || this.crumbs.length < 5) return;
    const s = this.playerS() - behind;
    if (s < this.crumbs[0].s) return;
    this.startFollower(s);
  }

  private spawnFollowerAt(x: number, z: number): void {
    if (this.follower) return;
    // 그 지점에 가장 가까운 경로 위치에서 시작
    let bestS = this.playerS() - 4;
    let bd = Infinity;
    for (const c of this.crumbs) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) {
        bd = d;
        bestS = c.s;
      }
    }
    this.startFollower(bestS);
  }

  private startFollower(s: number): void {
    const p = this.pointAt(s);
    const h = this.newHaunt('follower', 'follower', {});
    const g = new VideoGhost(ROLE.follower, this.pool);
    g.root.position.set(p.x, 0, p.z);
    h.ghost = g;
    if (this.isSeen(this.center(h))) {
      g.dispose();
      return; // 보이는 곳에는 생기지 않음
    }
    this.scene.add(g.root);
    this.followerS = s;
    this.followerStage = 0;
    this.followerWasSeen = false;
    this.follower = h;
    this.active = h;
  }

  private updateFollower(h: Haunt, dt: number, seen: boolean, _isMoving: boolean): void {
    const g = h.ghost!;
    // 볼 때마다 다음 거리 단계로 (점점 가까이)
    const trail = [9, 5, 2.6, 1.3];
    const behind = this.playerS() - this.followerS;

    if (seen) {
      g.freeze = true;
      g.setReversed(false);
      if (!this.followerWasSeen) {
        this.followerWasSeen = true;
        if (this.followerStage === 0) {
          this.sound.playEerieHumOrWhisper({ x: g.root.position.x, y: 1.6, z: g.root.position.z }, '[낮은 흥얼거림]');
        }
        this.followerStage = Math.min(trail.length - 1, this.followerStage + 1);
      }
      if (behind < 1.8 && h.seenTime > 0.2) {
        this.jolt(h, this.center(h));
        this.followerTimer = DEBUG ? 15 : rand(90, 150);
      }
      return;
    }

    this.followerWasSeen = false;
    g.freeze = false;
    // 너무 멀어지면 놓침
    if (behind > 30) {
      this.finish(h, 10);
      this.followerTimer = rand(60, 100);
      return;
    }
    const target = trail[this.followerStage];
    if (behind > target) {
      this.followerS = Math.min(this.followerS + 2.6 * dt, this.playerS() - target);
      g.setReversed(true);
      h.soundTimer -= dt;
      if (h.soundTimer <= 0) {
        h.soundTimer = rand(0.7, 1.4);
        if (Math.random() < 0.45) {
          this.sound.playFootstep(true, { x: g.root.position.x, y: 0.1, z: g.root.position.z });
        }
      }
    } else {
      g.setReversed(false);
    }
    const p = this.pointAt(this.followerS);
    g.root.position.set(p.x, 0, p.z);
  }

  /** 디버그: 현재 상태 */
  public debugState(): object {
    const h = this.active;
    return {
      active: h ? { kind: h.kind, dir: h.frame?.dir, lz: +h.lz.toFixed(2), side: h.side, zone: h.zone, seenTime: +h.seenTime.toFixed(2), everSeen: h.everSeen, pos: h.ghost?.root.position.toArray().map((v) => +v.toFixed(2)) } : null,
      followerBehind: this.follower ? +(this.playerS() - this.followerS).toFixed(2) : null,
      followerStage: this.followerStage,
      seen: this.lastSeenDebug,
      cam: { p: this.camPos.toArray().map((v) => +v.toFixed(2)), f: this.camFwd.toArray().map((v) => +v.toFixed(2)) },
      count: this.haunts.filter((x) => !x.done).length,
      node: nearestNode(this.camPos.x, this.camPos.z),
    };
  }
}
