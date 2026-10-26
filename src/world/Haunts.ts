import * as THREE from 'three';
import { SoundManager } from '../audio/SoundManager';
import type { GhostVoiceTag } from '../audio/GhostVoice';
import { GhostClip, GhostRole, clipForRole, hasRealClip } from '../ghost/clips';
import { VideoGhost } from '../ghost/VideoGhost';
import { VideoClipPool } from '../ghost/VideoClipPool';
import { LIGHT_FULL, LightPool } from './Lighting';
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
  | 'wallcrawl' // 벽을 기어오름. 천장에 닿으면 매달려 멈추고, 안 보면 벽을 따라 다가옴
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

const ACTIVATE_DIST = 34; // 이 거리 안에 들어오면 (안 보일 때) 나타날 준비. 안개 너머(약 22m 이상)면 정면이어도 준비 가능
const DEACTIVATE_DIST = 40;
const SEE_DIST = 22;
const SEE_COS = 0.72; // 시야 중심에서 약 44도 안쪽
/** 벽 오르기: 초당 오르는 높이(m), 발에서 뻗은 손끝까지 높이(m) */
const WALLCLIMB_SPEED = 0.25;
const WALLCLIMB_REACH = 1.75;
/** 벽 귀신 판을 플레이어 쪽으로 트는 최대 각도, 몸(팔 포함)의 반폭(m) */
const WALLCLIMB_MAX_TURN = (55 * Math.PI) / 180;
const WALLCLIMB_HALF_WIDTH = 0.3;

/** 공간별로 나올 수 있는 복도 귀신 (비디오 대여점은 양쪽 진열장에 벽 귀신이 묻혀 제외) */
export const CORRIDOR_KINDS: Record<ZoneKind, HauntKind[]> = {
  school: ['approach', 'floorcrawl', 'ceiling', 'watcher', 'wallcrawl'],
  apt404: ['approach', 'floorcrawl', 'ceiling', 'suspended', 'wallcrawl', 'watcher'],
  tatami: ['approach', 'floorcrawl', 'ceiling', 'crouched', 'wallcrawl'],
  video: ['approach', 'floorcrawl', 'ceiling'],
  subway: ['approach', 'floorcrawl', 'ceiling', 'wallcrawl', 'watcher'],
};

/**
 * 출현 비중 (나머지 종류는 1): 천장·기어오기는 5배, 걸어오기는 8배.
 * 공간마다 다르지만 천장+기어오기가 복도 귀신의 절반쯤 됨 (걸어오기는 약 40%).
 */
const KIND_WEIGHT: Partial<Record<HauntKind, number>> = {
  ceiling: 5,
  floorcrawl: 5,
  approach: 8,
};

export function pickWeighted(kinds: HauntKind[]): HauntKind | null {
  // 실제 영상이 아직 없는(임시 영상뿐인) 귀신은 내보내지 않음
  const usable = kinds.filter((k) => hasRealClip(ROLE[k]));
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, k) => sum + (KIND_WEIGHT[k] ?? 1), 0);
  let r = Math.random() * total;
  for (const k of usable) {
    r -= KIND_WEIGHT[k] ?? 1;
    if (r <= 0) return k;
  }
  return usable[usable.length - 1];
}

/** 활성화된 뒤 이 시간 동안 한 번도 안 보이면 내려놓고 다른 귀신에게 차례를 넘김 */
const UNSEEN_RELEASE_SEC = 8;
/** 따라오는 귀신이 이 시간 동안 한 번도 안 보이면 포기하고 사라짐 */
const FOLLOWER_GIVEUP_SEC = 30;
/** 따라오는 귀신은 최대 이 시간까지만 (다른 귀신에게도 차례가 가도록) */
const FOLLOWER_MAX_SEC = 45;

// 출현 빈도 (값을 바꾸면 전체 빈도가 조절됨)
/** 복도 하나에 귀신이 배치될 확률 */
const CORRIDOR_SPAWN_P = 1.0;
/** 교차로 하나에 모퉁이 엿보기가 배치될 확률 */
const JUNCTION_PEEK_P = 0.45;
/** 귀신이 끝난 뒤 다음 귀신까지 쉬는 시간(초): 마주침 / 조용히 사라짐 / 다가가자 사라짐 / 추적자 포기 */
const REST_AFTER_JOLT = 6;
const REST_AFTER_VANISH = 3;
const REST_AFTER_NEAR = 4;
const REST_AFTER_GIVEUP = 0;
/** 추적자 등장 간격(초): 처음 / 마주친 뒤 / 포기한 뒤 */
const FOLLOWER_FIRST: [number, number] = [15, 25];
const FOLLOWER_AFTER_JOLT: [number, number] = [25, 40];
const FOLLOWER_AFTER_GIVEUP: [number, number] = [15, 25];

/**
 * 출현 보장: 귀신을 못 본 채 지나간 복도가 이 수에 이르기 전에 반드시 하나는 나오게 함.
 * (4 = 복도 4개마다 최소 1번) 3번째 복도부터 쉬는 시간을 무시하고, 이미 끝난 귀신도
 * 다시 배치해 앞쪽 복도에서 나오게 하며, 4번째 복도에서는 등 뒤 추적자도 바로 부름.
 */
const GUARANTEE_EVERY = 4;
/** 이 각도(약 60도) 안쪽이면 '앞쪽' 자리로 봄 */
const FRONT_COS = 0.5;
/** 한 번에 자리 잡기를 시도해 볼 후보 수 */
const ACTIVATE_TRIES = 3;
/** 귀신이 나와 있는 동안 그 목소리가 들리는 간격(초). 멀리서도 들림 (가까이 가지 않아도 됨) */
const PRESENCE_VOICE_FIRST: [number, number] = [0.8, 2];
const PRESENCE_VOICE_EVERY: [number, number] = [5, 9];
/** 나와 있는 동안 들리는 목소리 크기 (마주칠 때보다 작고 얕게) */
const PRESENCE_VOICE_VOLUME = 0.55;

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
  /** 벽을 오르는 귀신의 발 높이 (m) */
  ly: number;
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
  /** 이 귀신이 쓸 영상 (미리 정해 두어 나타나기 전 목소리와 실제 모습이 맞게 함) */
  clip?: GhostClip;
  /** 다음 목소리까지 남은 시간 (나와 있는 동안) */
  voiceTimer: number;
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
  private cooldown = DEBUG ? 0 : 5;

  // 추적자(follower): 플레이어가 지나온 길을 그대로 따라옴
  private crumbs: Crumb[] = [];
  private follower: Haunt | null = null;
  private followerS = 0;
  private followerStage = 0;
  private followerTimer = FORCE === 'follower' ? 3 : DEBUG ? 20 : rand(...FOLLOWER_FIRST);
  private followerWasSeen = false;

  // 출현 보장: 귀신을 못 보고 지나간 복도 수
  private lastCorridor: string | null = null;
  private corridorsSinceGhost = 0;
  /** 지금 복도에 들어온 교차로, 마지막으로 있던 교차로 ("i,j") */
  private corridorEntry: string | null = null;
  private lastJunction: string | null = null;
  private swapTimer = 0;

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

  /** 귀신이 지금 모습을 드러낸 상태인지 (사물 이상 현상과 겹치지 않게 하는 데 씀. 읽기 전용) */
  public get presenceActive(): boolean {
    return Boolean(this.active?.everSeen || this.follower?.everSeen);
  }

  // -------------------------------------------------------------------------
  // 배치
  // -------------------------------------------------------------------------

  private nearStart(key: string): boolean {
    const m = key.match(/(-?\d+),(-?\d+)/);
    if (!m) return false;
    return Math.abs(Number(m[1])) + Math.abs(Number(m[2])) === 0;
  }

  public onCorridorBuilt(cell: string, zone: ZoneKind, frame: CorridorFrame, _group: THREE.Group): void {
    if (FORCE === 'peek' || FORCE === 'follower') return;
    if (!DEBUG && this.nearStart(cell)) return;
    if (!DEBUG && Math.random() > CORRIDOR_SPAWN_P) return;
    const kind = FORCE ?? pickWeighted(CORRIDOR_KINDS[zone]);
    if (!kind) return;
    // 학교 복도는 오른쪽 벽에 사물함이 있어 벽 귀신이 묻힘 → 왼쪽 벽만
    const side = zone === 'school' ? -1 : Math.random() < 0.5 ? -1 : 1;
    this.haunts.push(this.newHaunt(cell, kind, { frame, zone, side }));
  }

  public onJunctionBuilt(cell: string, i: number, j: number, _zone: ZoneKind, _root: THREE.Group): void {
    if (FORCE && FORCE !== 'peek') return;
    if (!DEBUG && this.nearStart(cell)) return;
    const p = FORCE === 'peek' ? 1 : DEBUG ? 0.3 : JUNCTION_PEEK_P;
    if (Math.random() > p) return;
    this.haunts.push(this.newHaunt(cell, 'peek', { junction: { i, j } }));
  }

  private newHaunt(cell: string, kind: HauntKind, extra: Partial<Haunt>): Haunt {
    const h: Haunt = {
      id: this.nextId++,
      cell,
      kind,
      lx: 0,
      lz: -12,
      ly: 0,
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
      clip: clipForRole(ROLE[kind]),
      voiceTimer: rand(...PRESENCE_VOICE_FIRST),
      ...extra,
    };
    // 이 귀신의 목소리 파일을 미리 받아 둠 (나타나기 전에 목소리가 먼저 들리므로)
    this.sound.preloadGhostVoice(this.voiceOf(h));
    return h;
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
        y = h.ly + 0.95; // 몸 가운데
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
    // 추적자는 자기 등장 간격(followerTimer)으로 따로 관리
    if (h.kind !== 'follower') this.cooldown = DEBUG ? 2 : rest;
  }

  /** 마주침: 불이 나가고 화면이 찢기며 사라짐 */
  private jolt(h: Haunt, at: THREE.Vector3): void {
    this.world.flash(0.04, 0.65);
    this.sound.playVhsStatic(0.45);
    // 영상 속 인물의 성별·나이에 맞는 목소리 (태그가 없으면 목 막힌 소리).
    // 목 막힌 소리를 낼 수 있는 귀신은 마주치는 순간 꼭 그 소리를 냄 (주온 가야코처럼)
    const voice = h.ghost?.voice;
    const kind = voice?.kinds?.includes('croak') ? 'croak' : undefined;
    this.sound.playGhostVoice(voice, { x: at.x, y: Math.min(at.y + 0.6, SEG_H), z: at.z }, false, 1, kind);
    this.lights.killNearest(at.x, at.z);
    this.finish(h, REST_AFTER_JOLT);
  }

  /** 다시 보면 없어져 있음 (조용히) */
  private vanishQuietly(h: Haunt): void {
    this.finish(h, REST_AFTER_VANISH);
  }

  // -------------------------------------------------------------------------
  // 활성화 (보이지 않는 곳에서만 나타남)
  // -------------------------------------------------------------------------

  /**
   * 플레이어가 곧 보게 될 자리인지: 복도 귀신은 플레이어와 가장 가까운 교차로에 붙은 복도,
   * 모퉁이 귀신은 그 교차로나 바로 옆 교차로. 평행한 복도나 먼 곁가지에서 준비돼
   * 아무도 못 보는 일을 막음.
   */
  private onPlayersWay(h: Haunt): boolean {
    const p = nearestNode(this.camPos.x, this.camPos.z);
    const m = h.cell.match(/(-?\d+),(-?\d+)(?:,([NE]))?/);
    if (!m) return false;
    const i = Number(m[1]);
    const j = Number(m[2]);
    if (h.kind === 'peek') return Math.abs(i - p.i) + Math.abs(j - p.j) <= 1;
    // 플레이어가 바라보는 방향의 다음 교차로도 포함 (그 너머 복도에서 안개 속으로 나타나게)
    const f = this.camFwd;
    const ahead = Math.abs(f.x) > Math.abs(f.z) ? { i: p.i + Math.sign(f.x), j: p.j } : { i: p.i, j: p.j + Math.sign(f.z) };
    const near = (a: number, b: number) => (a === p.i && b === p.j) || (a === ahead.i && b === ahead.j);
    // 복도 (i,j)-N 은 (i,j)~(i,j-1), (i,j)-E 는 (i,j)~(i+1,j)
    const [bi, bj] = m[3] === 'N' ? [i, j - 1] : [i + 1, j];
    return near(i, j) || near(bi, bj);
  }

  /**
   * 플레이어가 바라보는 쪽(앞)에 있고 벽에 가리지 않은 자리인지. 곁가지 복도에 먼저 자리를 잡으면
   * 곧장 걸어가는 플레이어는 끝내 못 보고, 그동안 다른 귀신도 못 나오기 때문에 앞쪽을 우선함.
   */
  private inFront(p: THREE.Vector3): boolean {
    const dx = p.x - this.camPos.x;
    const dz = p.z - this.camPos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return true;
    const fl = Math.hypot(this.camFwd.x, this.camFwd.z) || 1;
    if ((dx * this.camFwd.x + dz * this.camFwd.z) / (d * fl) < FRONT_COS) return false;
    // 비스듬히 앞이어도 벽 너머 옆 복도면 곧장 걸어서는 못 봄
    return hasLineOfSight(this.camPos.x, this.camPos.z, p.x, p.z);
  }

  /** 다음에 나올 후보들: 앞쪽 자리 먼저, 그 안에서는 가까운 순 */
  private candidates(): { h: Haunt; front: boolean }[] {
    const list: { h: Haunt; front: boolean; d: number }[] = [];
    for (const h of this.haunts) {
      if (h.done || h.ghost) continue;
      if (!this.onPlayersWay(h)) continue;
      const anchor = this.anchorPreview(h);
      if (!anchor) continue;
      const d = this.flatDist(anchor);
      if (d >= ACTIVATE_DIST || d <= 3) continue;
      list.push({ h, front: this.inFront(anchor), d });
    }
    return list.sort((a, b) => Number(b.front) - Number(a.front) || a.d - b.d);
  }

  /** 아직 아무도 못 본 채 옆쪽에 자리 잡은 귀신이 있고 앞쪽에 후보가 생기면 그쪽으로 옮김 */
  private maybeSwapToFront(): void {
    const a = this.active;
    if (!a || a.everSeen || !a.ghost) return;
    if (this.inFront(this.center(a))) return;
    // 앞쪽 자리를 실제로 잡았을 때만 옮김 (못 잡으면 원래 귀신과 그 타이머를 그대로 둠)
    const fronts = this.candidates()
      .filter((c) => c.front)
      .slice(0, ACTIVATE_TRIES);
    for (const { h } of fronts) {
      if (!this.place(h)) continue;
      if (this.isSeen(this.center(h))) {
        this.release(h);
        continue;
      }
      this.release(a);
      a.unseenTime = 0;
      this.active = h;
      h.voiceTimer = rand(...PRESENCE_VOICE_FIRST);
      return;
    }
  }

  private tryActivate(): void {
    // 가장 좋은 자리가 지금 시야 안이라 못 나오면 다음 후보를 시도 (한 번에 몇 개까지만)
    const list = this.candidates().slice(0, ACTIVATE_TRIES);
    if (list.length === 0) return;
    for (const { h } of list) {
      if (!this.place(h)) continue;
      if (this.isSeen(this.center(h))) {
        // 보이는 곳에서 갑자기 생기면 안 됨
        this.release(h);
        continue;
      }
      this.active = h;
      h.voiceTimer = rand(...PRESENCE_VOICE_FIRST);
      return;
    }
    this.cooldown = Math.max(this.cooldown, 0.5);
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
        g = new VideoGhost(role, this.pool, { clip: h.clip, billboard: false, shadow: false });
        h.lx = rand(-0.4, 0.4);
        h.lz = mid();
        // 위에서 찍은 영상은 천장에 눕힘 (얼굴이 아래를 향하고, 머리는 복도 시작(+z) 쪽).
        // 매달린 옆모습 영상은 VideoGhost가 천장에서 늘어뜨려 플레이어를 향하게 함.
        if (!g.hangs) g.body.rotation.x = Math.PI / 2;
        break;
      }
      case 'wallcrawl': {
        g = new VideoGhost(role, this.pool, { clip: h.clip, billboard: false, shadow: false });
        h.lz = far();
        h.lx = h.side * (HALF - 0.03);
        // 바닥 가까이에서 오르기 시작
        h.ly = rand(0.1, 0.4);
        break;
      }
      case 'crouched': {
        g = new VideoGhost(role, this.pool, { clip: h.clip });
        h.lz = far();
        h.lx = h.side * (HALF - 0.45);
        break;
      }
      case 'suspended': {
        g = new VideoGhost(role, this.pool, { clip: h.clip, shadow: false });
        h.lz = mid();
        h.lx = rand(-0.3, 0.3);
        break;
      }
      default: {
        g = new VideoGhost(role, this.pool, { clip: h.clip });
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
    // 플레이어가 S/W 쪽 복도에서 오면 그 복도 끝(이 교차로 쪽)에 반쯤 열린 문짝이 있고,
    // 문짝은 플레이어가 볼 때 항상 왼쪽 → 왼쪽 모퉁이는 가려지므로 오른쪽만 사용
    const doorOnLeft = approach === 'S' || approach === 'W';
    const isRight = (dd: Dir) => DIRS[dd].di * a.dj + DIRS[dd].dj * -a.di > 0;
    const usable = doorOnLeft ? sides.filter(isRight) : sides;
    if (usable.length === 0) return false;
    const d = DIRS[pick(usable)];
    // 교차로 안, 플레이어 쪽 문틀 가장자리에 몸이 반쯤 걸리는 자리 → 옆 복도로 숨음
    const x = c.x + d.di * 0.55 - a.di * 0.2;
    const z = c.z + d.dj * 0.55 - a.dj * 0.2;
    h.peekDir = { x: d.di, z: d.dj };
    // 교차로 조명이 꺼져 있거나 흐리면 문틀 너머 어둠에 묻혀 안 보이므로 켜 둠
    this.lights.ensureLit(c.x, c.z, LIGHT_FULL * 0.6);
    const g = new VideoGhost(ROLE.peek, this.pool, { clip: h.clip });
    g.root.position.set(x, 0, z);
    // 영상 속 귀신은 화면 왼쪽(복도 가운데 쪽)으로 몸을 기울임.
    // 플레이어가 볼 때 귀신이 왼쪽 모퉁이에 있으면 좌우를 뒤집어 항상 가운데 쪽으로 내다보게 함.
    // 플레이어 시선 = -a, 화면 오른쪽 = (a.dj, -a.di)
    const onRight = d.di * a.dj + d.dj * -a.di > 0; // isRight와 같은 계산
    if (!onRight) g.body.scale.x = -1;
    h.ghost = g;
    this.scene.add(g.root);
    return true;
  }

  /** 플레이어가 그 복도 안이나 양 끝 교차로에 있는지 (복도 로컬 좌표) */
  private inCorridorView(pl: { lx: number; lz: number }): boolean {
    return Math.abs(pl.lx) < HALF + 0.3 && pl.lz < SEG_W && pl.lz > -18 - SEG_W;
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
    if (h.kind === 'wallcrawl') {
      this.syncWallClimber(h);
      return;
    }
    const w = corridorToWorld(h.frame, h.lx, h.lz);
    g.root.position.set(w.x, h.kind === 'suspended' ? 0.3 : 0, w.z);
  }

  /**
   * 위로 기어오르는 뒷모습 영상을 벽에 세움.
   * 판을 벽과 나란히 두면 복도를 따라 보는 플레이어에게는 거의 옆면만 보여 종이처럼 납작해짐.
   * 그래서 판을 플레이어 쪽으로 최대 WALLCLIMB_MAX_TURN까지 틀고, 튼 만큼 벽에서 띄워 몸이 벽에 박히지 않게 함.
   */
  private syncWallClimber(h: Haunt): void {
    const g = h.ghost!;
    const frame = h.frame!;
    const pl = worldToCorridor(frame, this.camPos.x, this.camPos.z);
    // 복도 로컬 좌표에서 판의 정면 방향 각도 (atan2(x, z)). 벽 정면 = 복도 가운데 쪽
    const wallYaw = h.side === -1 ? Math.PI / 2 : -Math.PI / 2;
    const toPlayer = Math.atan2(pl.lx - h.side * HALF, pl.lz - h.lz);
    let turn = toPlayer - wallYaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn)); // -π~π로
    turn = Math.max(-WALLCLIMB_MAX_TURN, Math.min(WALLCLIMB_MAX_TURN, turn));
    const off = WALLCLIMB_HALF_WIDTH * Math.abs(Math.sin(turn));
    const w = corridorToWorld(frame, h.side * (HALF - 0.03 - off), h.lz);
    g.root.position.set(w.x, 0, w.z);
    g.body.position.y = h.ly;
    g.body.rotation.set(0, wallYaw + turn, 0);
  }

  // -------------------------------------------------------------------------
  // 매 프레임
  // -------------------------------------------------------------------------

  public update(dt: number, elapsed: number, playerPos: THREE.Vector3, camForward: THREE.Vector3, isMoving: boolean): void {
    this.camPos.copy(playerPos);
    this.camFwd.copy(camForward).normalize();
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.recordCrumb(playerPos);
    this.trackCorridor();
    const overdue = !DEBUG && !FORCE && this.corridorsSinceGhost >= GUARANTEE_EVERY - 1;
    if (overdue) {
      this.cooldown = Math.min(this.cooldown, 1);
      this.rearmOnPlayersWay();
      // 4번째 복도인데도 아직이면 등 뒤 추적자도 바로 부름
      if (this.corridorsSinceGhost >= GUARANTEE_EVERY) this.followerTimer = Math.min(this.followerTimer, 1);
    }

    // 귀신 자리는 두 개: 등 뒤의 추적자 하나 + 앞쪽 복도·모퉁이 귀신 하나 (서로 막지 않음)
    // 1. 추적자
    this.followerTimer -= dt;
    if (!this.follower && this.followerTimer <= 0) {
      this.followerTimer = 1;
      this.spawnFollower(12);
    }

    // 2. 복도·모퉁이 귀신
    if (!this.active && this.cooldown <= 0) this.tryActivate();
    else if (this.active) {
      this.swapTimer -= dt;
      if (this.swapTimer <= 0) {
        this.swapTimer = 0.5;
        this.maybeSwapToFront();
      }
    }

    // 3. 행동
    if (this.active) this.step(this.active, dt, elapsed, isMoving);
    if (this.follower) this.step(this.follower, dt, elapsed, isMoving);
  }

  private step(h: Haunt, dt: number, elapsed: number, isMoving: boolean): void {
    if (!h.ghost) return;

    const c = this.center(h);
    const dist = this.flatDist(c);
    const seen = this.isSeen(c);
    this.lastSeenDebug = { seen, dist: +dist.toFixed(2), c: c.toArray().map((v) => +v.toFixed(2)) };
    if (seen) {
      h.seenTime += dt;
      h.unseenTime = 0;
      if (!h.everSeen) this.corridorsSinceGhost = 0; // 귀신을 봄 → 출현 보장 카운트 초기화
      h.everSeen = true;
    } else {
      h.unseenTime += dt;
      if (h.unseenTime > 0.3) h.seenTime = 0;
    }

    // 너무 멀어지거나, 오랫동안 플레이어가 그쪽을 보지 않으면 내려놓음 (나중에 다시 나타날 수 있음).
    // 옆 복도에 활성화된 채 방치되면 다른 귀신이 전혀 나오지 못하기 때문.
    if (h.kind !== 'follower' && (dist > DEACTIVATE_DIST || (!h.everSeen && h.unseenTime > UNSEEN_RELEASE_SEC))) {
      this.release(h);
      h.unseenTime = 0;
      this.cooldown = Math.max(this.cooldown, 3);
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
      if (h.kind !== 'follower') this.presenceVoice(h, dt, c);
    }
  }

  /**
   * 귀신이 나와 있는 동안 가끔 그 귀신의 목소리(성별·나이에 맞는 키득거림/흐느낌)를 작게 냄.
   * 거리 감쇠를 약하게 해서 같은 복도 어디서든, 옆 복도에서도 희미하게 들림.
   * (추적자는 들키면 안 되므로 발소리만 냄)
   */
  private presenceVoice(h: Haunt, dt: number, c: THREE.Vector3): void {
    h.voiceTimer -= dt;
    if (h.voiceTimer > 0) return;
    h.voiceTimer = rand(...PRESENCE_VOICE_EVERY);
    this.sound.playGhostVoice(this.voiceOf(h), { x: c.x, y: Math.min(c.y + 0.6, SEG_H), z: c.z }, true, PRESENCE_VOICE_VOLUME);
  }

  private voiceOf(h: Haunt): GhostVoiceTag | undefined {
    if (h.ghost) return h.ghost.voice;
    const clip = h.clip;
    return clip?.gender && clip.age ? { gender: clip.gender, age: clip.age, kinds: clip.voices } : undefined;
  }

  // -------------------------------------------------------------------------
  // 출현 보장 (복도 4개마다 최소 1번)
  // -------------------------------------------------------------------------

  /** 플레이어가 있는 복도의 키 (EndlessWorld의 cKey와 같은 형식). 교차로 안이면 null */
  private currentCorridor(): string | null {
    const { i, j } = nearestNode(this.camPos.x, this.camPos.z);
    const c = nodeCenter(i, j);
    const dx = this.camPos.x - c.x;
    const dz = this.camPos.z - c.z;
    if (Math.abs(dx) <= HALF && Math.abs(dz) <= HALF) return null;
    // 각 교차로는 자기 N(-z) 복도와 E(+x) 복도를 소유
    if (Math.abs(dz) > Math.abs(dx)) return dz < 0 ? `C:${i},${j},N` : `C:${i},${j + 1},N`;
    return dx > 0 ? `C:${i},${j},E` : `C:${i - 1},${j},E`;
  }

  private trackCorridor(): void {
    const key = this.currentCorridor();
    if (!key) {
      // 복도를 끝까지 지나 반대쪽 교차로에 닿았으면, 같은 복도로 되돌아가도 새로 셈
      // (들어온 교차로로 도로 나간 것은 세지 않음)
      const { i, j } = nearestNode(this.camPos.x, this.camPos.z);
      const junction = `${i},${j}`;
      if (this.lastCorridor && junction !== this.corridorEntry) this.lastCorridor = null;
      this.lastJunction = junction;
      return;
    }
    if (key === this.lastCorridor) return;
    this.lastCorridor = key;
    this.corridorEntry = this.lastJunction;
    this.corridorsSinceGhost++;
  }

  /** 플레이어가 곧 지나갈 곳의 이미 끝난 귀신을 다시 배치 (같은 복도를 오가도 나오게) */
  private rearmOnPlayersWay(): void {
    for (const h of this.haunts) {
      if (!h.done || h.ghost || h.kind === 'follower') continue;
      if (!this.onPlayersWay(h)) continue;
      const kind = h.kind === 'peek' || !h.zone ? h.kind : pickWeighted(CORRIDOR_KINDS[h.zone]) ?? h.kind;
      Object.assign(h, {
        kind,
        done: false,
        lx: 0,
        lz: -12,
        ly: 0,
        seenTime: 0,
        unseenTime: 0,
        everSeen: false,
        moved: 0,
        minDist: Infinity,
        soundTimer: 0,
        cued: false,
        clip: clipForRole(ROLE[kind]),
        voiceTimer: rand(...PRESENCE_VOICE_FIRST),
      });
      this.sound.preloadGhostVoice(this.voiceOf(h));
    }
  }

  /** 복도 끝에서 극도로 느리게 다가옴. 코앞까지 오면 마주침. */
  private updateApproach(h: Haunt, dt: number, dist: number, c: THREE.Vector3): void {
    const g = h.ghost!;
    const pl = worldToCorridor(h.frame!, this.camPos.x, this.camPos.z);
    if (this.inCorridorView(pl) && dist < 16 && dist > 1.4) {
      const speed = h.kind === 'floorcrawl' ? 0.18 : (g.approachSpeedMps ?? 0.24);
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
      this.finish(h, REST_AFTER_NEAR);
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

  /** 벽을 기어오름: 보는 동안 천장을 향해 오르고, 시선을 돌리면 벽을 따라 다가와 있음 */
  private updateWallCrawl(h: Haunt, dt: number, dist: number, seen: boolean, c: THREE.Vector3): void {
    const g = h.ghost!;
    const pl = worldToCorridor(h.frame!, this.camPos.x, this.camPos.z);
    if (seen && dist < 2.8 && h.seenTime > 0.25) {
      this.jolt(h, c);
      return;
    }
    // 손끝이 천장에 닿으면 그 자리에 매달려 멈춤. 한 번 본 뒤 시선을 돌리면 천장 너머로 사라져 있음
    const top = SEG_H - WALLCLIMB_REACH;
    if (h.ly >= top) {
      g.freeze = true;
      if (h.everSeen && !seen && h.unseenTime > 0.8) {
        this.vanishQuietly(h);
        return;
      }
      this.syncCorridorGhost(h); // 매달려 있어도 판은 계속 플레이어 쪽으로
      return;
    }
    g.freeze = false;
    // 영상 속 손발 움직임에 맞춰 위로 기어오름
    h.ly = Math.min(top, h.ly + WALLCLIMB_SPEED * dt);
    // 안 보는 사이에는 벽을 따라 플레이어 쪽으로 다가와 있음
    if (!seen && this.inCorridorView(pl) && dist > 2.6) {
      const speed = h.everSeen ? 1.1 : 0.45;
      h.lz += Math.sign(pl.lz - h.lz) * speed * dt;
    }
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
    const g = new VideoGhost(ROLE.follower, this.pool, { clip: h.clip });
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
  }

  private updateFollower(h: Haunt, dt: number, seen: boolean, _isMoving: boolean): void {
    const g = h.ghost!;
    h.moved += dt; // 추적자는 moved를 살아 있는 시간으로 씀 (보든 안 보든)
    // 볼 때마다 다음 거리 단계로 (점점 가까이)
    const trail = [9, 5, 2.6, 1.3];
    const behind = this.playerS() - this.followerS;

    if (seen) {
      g.freeze = true;
      g.setReversed(false);
      if (!this.followerWasSeen) {
        this.followerWasSeen = true;
        if (this.followerStage === 0) {
          // 처음 눈이 마주치면 그 귀신의 목소리 (키득거림 / 흐느낌)
          this.sound.playGhostVoice(g.voice, { x: g.root.position.x, y: 1.6, z: g.root.position.z }, false, PRESENCE_VOICE_VOLUME);
        }
        this.followerStage = Math.min(trail.length - 1, this.followerStage + 1);
      }
      if (behind < 1.8 && h.seenTime > 0.2) {
        this.jolt(h, this.center(h));
        this.followerTimer = DEBUG ? 15 : rand(...FOLLOWER_AFTER_JOLT);
      }
      return;
    }

    this.followerWasSeen = false;
    g.freeze = false;
    // 너무 멀어지면 놓침
    // 너무 멀어지거나, 오랫동안 돌아보지 않으면 포기 (붙은 채로 다른 귀신을 계속 막지 않게)
    if (behind > 30 || h.unseenTime > FOLLOWER_GIVEUP_SEC || h.moved > FOLLOWER_MAX_SEC) {
      this.finish(h, REST_AFTER_GIVEUP);
      this.followerTimer = rand(...FOLLOWER_AFTER_GIVEUP);
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
      // 등 뒤에 붙어 서 있는 동안 가끔 발소리 → 돌아보게 만드는 단서
      h.soundTimer -= dt;
      if (h.soundTimer <= 0) {
        h.soundTimer = rand(3, 6);
        this.sound.playFootstep(true, { x: g.root.position.x, y: 0.1, z: g.root.position.z });
      }
    }
    const p = this.pointAt(this.followerS);
    g.root.position.set(p.x, 0, p.z);
  }

  /** 디버그: 현재 상태 */
  public debugState(): object {
    const h = this.active ?? this.follower;
    return {
      active: h ? { kind: h.kind, dir: h.frame?.dir, lz: +h.lz.toFixed(2), side: h.side, zone: h.zone, seenTime: +h.seenTime.toFixed(2), everSeen: h.everSeen, pos: h.ghost?.root.position.toArray().map((v) => +v.toFixed(2)) } : null,
      followerBehind: this.follower ? +(this.playerS() - this.followerS).toFixed(2) : null,
      followerStage: this.followerStage,
      seen: this.lastSeenDebug,
      cam: { p: this.camPos.toArray().map((v) => +v.toFixed(2)), f: this.camFwd.toArray().map((v) => +v.toFixed(2)) },
      count: this.haunts.filter((x) => !x.done).length,
      corridorsSinceGhost: this.corridorsSinceGhost,
      node: nearestNode(this.camPos.x, this.camPos.z),
    };
  }
}
