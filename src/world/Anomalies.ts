import * as THREE from 'three';
import { SoundManager } from '../audio/SoundManager';
import { LightPool } from './Lighting';
import { PropKind } from './Props';
import { hasLineOfSight } from './Maze';
import { pick, rand } from './Textures';

/**
 * 귀신 없이 공간과 사물만으로 만드는 불안.
 *
 * 원칙
 * - 조용하고 드물다. 큰 소리나 갑작스러운 움직임은 없다.
 * - 플레이어가 한 번 본 자리를, 지금 보고 있지 않을 때만 바꾼다.
 *   (돌아보면 문이 열려 있고, TV가 켜져 있고, 의자가 벽을 보고 있음)
 * - 귀신이 모습을 드러낸 동안과 그 직후에는 일어나지 않는다.
 *
 * 종류
 * - door     : 지나온 문·벽장이 열려 있음 (처음부터 열려 있던 문은 닫혀 있음)
 * - chair    : 복도를 보던 의자가 벽을 보고 있음
 * - tv       : 꺼져 있던 TV가 켜져 있음
 * - poster   : 줄지어 붙은 같은 전단지 중 하나만 사진 속 사람이 돌아서 있음
 * - shoes    : 문 앞에 없던 실내화가 가지런히 놓여 있음
 * - doll     : 벽을 보고 앉아 있던 인형이 복도 쪽을 보고 있음
 * - echo     : 앞서 본 교차로의 사물이 다음 교차로 같은 자리에도 놓여 있음
 * - lights   : 등 뒤의 형광등이 먼 것부터 하나씩 꺼짐
 */

export type AnomalyKind = 'door' | 'chair' | 'tv' | 'poster' | 'shoes' | 'doll' | 'echo' | 'landmark';

/** 빌더가 만드는 이상 현상 자리 (조각 로컬 좌표) */
export interface SpotSpec {
  x: number;
  z: number;
  kind: AnomalyKind;
  /** landmark: 눈에 띄는 사물의 종류 */
  prop?: PropKind;
  /** 상태를 바꿈. echo는 따라 놓을 사물 종류를 받음 */
  apply?: (prop?: PropKind) => void;
}

interface Spot extends SpotSpec {
  piece: string;
  seen: boolean;
  done: boolean;
}

const params = new URLSearchParams(location.search);
/** ?debug=anomaly : 이상 현상을 자주 일으킴 (확인용) */
const DEBUG = params.get('debug') === 'anomaly';

// 빈도와 간격 (초)
/** 다음 이상 현상까지 기다리는 시간 */
const INTERVAL: [number, number] = DEBUG ? [3, 5] : [45, 90];
/** 조건이 안 맞아 못 일으켰을 때 다시 시도하기까지 */
const RETRY: [number, number] = [4, 7];
/** 귀신이 사라진 뒤 이 시간 동안은 일어나지 않음 */
const AFTER_GHOST_SEC = DEBUG ? 2 : 15;
/** 이상 현상 중 '등 뒤 형광등이 꺼짐'의 비율 */
const LIGHTS_P = 0.18;
/** 문이 바뀔 때 멀리서 작게 끼익 소리가 날 확률 */
const DOOR_SOUND_P = 0.3;

// 시야 판정
/** '봤다'로 칠 거리와 시야 중심에서의 각도(cos) */
const SEEN_DIST = 14;
const SEEN_COS = Math.cos((38 * Math.PI) / 180);
/** 바꿔도 되는 곳: 이보다 멀거나, 시야 중심에서 이 각도(cos)보다 벗어나 있거나, 벽에 가려진 곳 */
const SAFE_COS = Math.cos((78 * Math.PI) / 180);
const MIN_CHANGE_DIST = 3.5;
const MAX_CHANGE_DIST = 26;
/** 시야 확인은 이 간격으로만 (매 프레임 하면 무거움) */
const SCAN_SEC = 0.3;

export class Anomalies {
  private spots: Spot[] = [];
  private timer = DEBUG ? 3 : rand(30, 50);
  private scanTimer = 0;
  private sinceGhost = 999;
  /** 마지막으로 눈에 담은 교차로 사물 (echo가 따라 놓음) */
  private lastLandmark: { prop: PropKind; piece: string } | null = null;
  private lightsQueue = 0;
  private lightsTimer = 0;
  /** 디버그: 일어난 횟수와 마지막 종류 */
  public count = 0;
  public last = '';

  constructor(private sound: SoundManager, private lights: LightPool) {}

  public add(piece: string, specs: SpotSpec[], toWorld: (x: number, z: number) => { x: number; z: number }): void {
    for (const s of specs) {
      const w = toWorld(s.x, s.z);
      this.spots.push({ ...s, x: w.x, z: w.z, piece, seen: false, done: false });
    }
  }

  public removePiece(piece: string): void {
    this.spots = this.spots.filter((s) => s.piece !== piece);
    if (this.lastLandmark?.piece === piece) {
      // 사물 기억은 조각이 사라져도 남겨 둠 (다음 교차로에서 다시 만날 수 있게)
      this.lastLandmark = { ...this.lastLandmark, piece: '' };
    }
  }

  private looking(s: Spot, p: THREE.Vector3, f: THREE.Vector3, cosLimit: number, maxDist: number): boolean {
    const dx = s.x - p.x;
    const dz = s.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > maxDist) return false;
    if (d < 1.2) return true;
    const fl = Math.hypot(f.x, f.z) || 1;
    if ((dx * f.x + dz * f.z) / (d * fl) < cosLimit) return false;
    return hasLineOfSight(p.x, p.z, s.x, s.z);
  }

  /** 지금 바꿔도 플레이어 눈에 안 띄는 자리인지 */
  private safeToChange(s: Spot, p: THREE.Vector3, f: THREE.Vector3): boolean {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d < MIN_CHANGE_DIST || d > MAX_CHANGE_DIST) return false;
    return !this.looking(s, p, f, SAFE_COS, 60);
  }

  public update(dt: number, playerPos: THREE.Vector3, forward: THREE.Vector3, ghostPresent: boolean): void {
    this.sinceGhost = ghostPresent ? 0 : this.sinceGhost + dt;

    // 1. 무엇을 봤는지 기록
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = SCAN_SEC;
      for (const s of this.spots) {
        if (s.seen) continue;
        if (!this.looking(s, playerPos, forward, SEEN_COS, SEEN_DIST)) continue;
        s.seen = true;
        if (s.kind === 'landmark' && s.prop) this.lastLandmark = { prop: s.prop, piece: s.piece };
      }
    }

    // 2. 등 뒤 형광등이 차례로 꺼지는 중 (귀신이 보이면 남은 순서는 취소)
    if (ghostPresent) this.lightsQueue = 0;
    if (this.lightsQueue > 0) {
      this.lightsTimer -= dt;
      if (this.lightsTimer <= 0) {
        this.lightsQueue--;
        this.lightsTimer = rand(1.8, 2.8);
        if (!this.lights.killFarthestBehind(playerPos.x, playerPos.z, forward.x, forward.z, 5, 24)) this.lightsQueue = 0;
      }
    }

    // 3. 다음 이상 현상
    this.timer -= dt;
    if (this.timer > 0) return;
    if (ghostPresent || this.sinceGhost < AFTER_GHOST_SEC || this.lightsQueue > 0) {
      this.timer = rand(...RETRY);
      return;
    }
    this.timer = this.trigger(playerPos, forward) ? rand(...INTERVAL) : rand(...RETRY);
  }

  private trigger(p: THREE.Vector3, f: THREE.Vector3): boolean {
    if (Math.random() < LIGHTS_P && this.lights.killFarthestBehind(p.x, p.z, f.x, f.z, 8, 24)) {
      this.lightsQueue = Math.floor(rand(1, 3));
      this.lightsTimer = rand(1.8, 2.8);
      this.mark('lights');
      return true;
    }

    const candidates = this.spots.filter((s) => {
      if (s.done || !s.apply) return false;
      if (s.kind === 'echo') {
        // 아직 못 본 교차로에, 방금 전 다른 교차로에서 본 사물을 놓음
        return !s.seen && this.lastLandmark !== null && this.lastLandmark.piece !== s.piece && this.safeToChange(s, p, f);
      }
      return s.seen && this.safeToChange(s, p, f);
    });
    if (candidates.length === 0) return false;

    const s = pick(candidates);
    s.done = true;
    if (s.kind === 'echo') {
      s.apply!(this.lastLandmark!.prop);
      // 같은 사물은 한 번만 따라 나옴
      this.lastLandmark = null;
    } else {
      s.apply!();
    }
    if (s.kind === 'door' && Math.random() < DOOR_SOUND_P) {
      this.sound.playCreak({ x: s.x, y: 1.2, z: s.z }, '[어딘가에서 문이 열리는 소리]');
    }
    this.mark(s.kind);
    return true;
  }

  private mark(kind: string): void {
    this.count++;
    this.last = kind;
    if (DEBUG) console.info(`[anomaly] ${kind} (${this.count})`);
  }
}
