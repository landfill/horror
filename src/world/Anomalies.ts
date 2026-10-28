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
 * - 문은 더 자주, 바라보는 중에도 소리와 함께 천천히 움직인다.
 * - TV·의자·실내화·발자국처럼 순간 상태가 바뀌는 사물은 시야 밖에서만 바꾼다.
 * - 귀신 연출과 겹치는 새 사건은 미룬다. 이미 움직이는 문은 끝까지 움직인다.
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
 * - room404  : 닫힌 404호 문이 천천히 열리고, 잠시 뒤 실내화가 복도를 향함
 * - footsteps: 문으로 들어간 젖은 발자국 옆에 복도로 나오는 자국이 차례로 남음
 */

export type AnomalyKind = 'door' | 'chair' | 'tv' | 'poster' | 'shoes' | 'doll' | 'echo' | 'landmark' | 'room404' | 'footsteps';

export interface StoryStage {
  apply: () => void;
  /** 이전 단계부터 기다리는 최소 시간. 관찰 조건을 추가하지 않음. */
  delay?: number;
  sound?: 'creak' | 'wetstep';
  /** 연속 움직임과 소리의 길이 (초). */
  duration?: number;
}

/** 빌더가 만드는 이상 현상 자리 (조각 로컬 좌표) */
export interface SpotSpec {
  x: number;
  z: number;
  kind: AnomalyKind;
  /** landmark: 눈에 띄는 사물의 종류 */
  prop?: PropKind;
  /** 상태를 바꿈. echo는 따라 놓을 사물 종류를 받음 */
  apply?: (prop?: PropKind) => void;
  /** 순서대로 남기는 공간의 변화. 첫 단계는 기존 이상 현상 선택 규칙을 사용. */
  stages?: StoryStage[];
  /** 바뀌는 사물 전체의 경계점 (조각 로컬 좌표). 모두 시야 밖이어야 함. */
  safetyPoints?: { x: number; z: number }[];
  /** 보이는 중에도 연속 움직임을 시작할 수 있는 문. */
  animatedDoor?: boolean;
  /** 단독 문 사건의 목표 상태. false면 닫기. */
  opening?: boolean;
  motionDuration?: number;
  /** 진행 중인 움직임만 갱신. 끝나면 false. */
  update?: (dt: number) => boolean;
}

interface Spot extends SpotSpec {
  piece: string;
  seen: boolean;
  done: boolean;
}

const params = new URLSearchParams(location.search);
/** ?debug=anomaly : 이상 현상을 자주 일으킴 (확인용) */
const DEBUG = params.get('debug') === 'anomaly';
const requestedStory = params.get('story');
const FORCE_STORY = DEBUG && (requestedStory === 'room404' || requestedStory === 'footsteps') ? requestedStory : null;

// 빈도와 간격 (초)
/** 다음 이상 현상까지 기다리는 시간 */
const INTERVAL: [number, number] = DEBUG ? [3, 5] : [45, 90];
/** 문 열림은 다른 이상 현상의 긴 간격과 별도로 더 자주 시도합니다. */
const DOOR_INTERVAL: [number, number] = DEBUG ? [3, 5] : [12, 22];
const DOOR_RETRY = DEBUG ? 0.5 : 2;
/** 조건이 안 맞아 못 일으켰을 때 다시 시도하기까지 */
const RETRY: [number, number] = [4, 7];
/** 귀신이 사라진 뒤 이 시간 동안은 일어나지 않음 */
const AFTER_GHOST_SEC = DEBUG ? 2 : 15;
/** 이상 현상 중 '등 뒤 형광등이 꺼짐'의 비율 */
const LIGHTS_P = 0.18;

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
  private doorTimer = DEBUG ? 1.2 : rand(6, 10);
  private moving = new Set<Spot>();
  private scanTimer = 0;
  private sinceGhost = 999;
  /** 마지막으로 눈에 담은 교차로 사물 (echo가 따라 놓음) */
  private lastLandmark: { prop: PropKind; piece: string } | null = null;
  private lightsQueue = 0;
  private lightsTimer = 0;
  private pending: { spot: Spot; nextStage: number; wait: number } | null = null;
  /** 디버그: 일어난 횟수와 마지막 종류 */
  public count = 0;
  public last = '';

  constructor(private sound: SoundManager, private lights: LightPool) {}

  public add(piece: string, specs: SpotSpec[], toWorld: (x: number, z: number) => { x: number; z: number }): void {
    for (const s of specs) {
      const w = toWorld(s.x, s.z);
      this.spots.push({
        ...s, x: w.x, z: w.z, piece, seen: false, done: false,
        safetyPoints: s.safetyPoints?.map((point) => toWorld(point.x, point.z)),
      });
    }
  }

  public removePiece(piece: string): void {
    this.spots = this.spots.filter((s) => s.piece !== piece);
    for (const spot of this.moving) {
      if (spot.piece === piece) this.moving.delete(spot);
    }
    if (this.pending?.spot.piece === piece) this.finishStory();
    if (this.lastLandmark?.piece === piece) {
      // 사물 기억은 조각이 사라져도 남겨 둠 (다음 교차로에서 다시 만날 수 있게)
      this.lastLandmark = { ...this.lastLandmark, piece: '' };
    }
  }

  private looking(s: { x: number; z: number }, p: THREE.Vector3, f: THREE.Vector3, cosLimit: number, maxDist: number): boolean {
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
    if (!this.safePoint(s, p, f)) return false;
    return !s.safetyPoints || s.safetyPoints.every((point) => this.safePoint(point, p, f));
  }

  private safePoint(s: { x: number; z: number }, p: THREE.Vector3, f: THREE.Vector3): boolean {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d < MIN_CHANGE_DIST || d > MAX_CHANGE_DIST) return false;
    return !this.looking(s, p, f, SAFE_COS, 60);
  }

  private canMoveDoor(s: Spot, p: THREE.Vector3): boolean {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    // 문은 실제로 움직이므로 시야 안에서도 시작 가능. 바로 몸 앞에서는 시작하지 않음.
    return d >= 1.8 && d <= 12 && hasLineOfSight(p.x, p.z, s.x, s.z);
  }

  public get hasMovingDoor(): boolean {
    return this.moving.size > 0;
  }

  public update(dt: number, playerPos: THREE.Vector3, forward: THREE.Vector3, ghostPresent: boolean): void {
    const pendingDoorWasMoving = this.pending !== null && this.moving.has(this.pending.spot);
    // 이미 시작한 문은 바라보거나 귀신이 나타나도 연속해서 끝까지 움직임.
    for (const spot of this.moving) {
      if (!spot.update!(dt)) this.moving.delete(spot);
    }
    this.doorTimer -= dt;
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

    // 문 열림은 별도 간격으로 선택. 확인용 story 주소에서는 귀신 대기에 막히지 않음.
    if (!this.hasMovingDoor && this.doorTimer <= 0 && (!ghostPresent || FORCE_STORY === 'room404')) {
      const doors = this.spots.filter((s) => !s.done && s.seen && s.animatedDoor &&
        ((!this.pending && s.kind === 'room404') || (s.kind === 'door' && s.opening !== false)) &&
        (!FORCE_STORY || s.kind === FORCE_STORY) && this.canMoveDoor(s, playerPos));
      if (doors.length > 0) {
        // 가장 가까운 문을 골라, 멀리서 아무도 못 알아채는 열림에 차례를 쓰지 않음.
        let nearest = doors[0];
        let distance = Math.hypot(nearest.x - playerPos.x, nearest.z - playerPos.z);
        for (let i = 1; i < doors.length; i++) {
          const d = Math.hypot(doors[i].x - playerPos.x, doors[i].z - playerPos.z);
          if (d < distance) { nearest = doors[i]; distance = d; }
        }
        this.applySpot(nearest);
        return;
      }
      this.doorTimer = DOOR_RETRY;
    }

    // 3. 진행 중인 사건. 다음 단계를 위한 재관찰·체류 시간·조도 조건은 없음.
    if (this.pending) {
      const story = this.pending;
      if (Math.hypot(story.spot.x - playerPos.x, story.spot.z - playerPos.z) > MAX_CHANGE_DIST) {
        // 멀리 떠난 사건이 다른 공간의 연출을 계속 막지 않게 함. 이미 남긴 변화는 유지.
        this.finishStory();
        return;
      }
      // 실내화는 문이 완전히 열린 다음부터 간격을 셈.
      if (pendingDoorWasMoving || this.moving.has(story.spot)) return;
      if ((!FORCE_STORY && (ghostPresent || this.sinceGhost < AFTER_GHOST_SEC)) || this.lightsQueue > 0) return;
      story.wait -= dt;
      if (story.wait > 0) return;
      if (!this.safeToChange(story.spot, playerPos, forward)) {
        story.wait = SCAN_SEC;
        return;
      }
      this.applyStage(story.spot, story.nextStage);
      return;
    }

    // 4. 다음 이상 현상
    if (this.hasMovingDoor) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    if ((!FORCE_STORY && (ghostPresent || this.sinceGhost < AFTER_GHOST_SEC)) || this.lightsQueue > 0) {
      this.timer = rand(...RETRY);
      return;
    }
    this.timer = this.trigger(playerPos, forward) ? rand(...INTERVAL) : rand(...RETRY);
  }

  private trigger(p: THREE.Vector3, f: THREE.Vector3): boolean {
    if (!FORCE_STORY && Math.random() < LIGHTS_P && this.lights.killFarthestBehind(p.x, p.z, f.x, f.z, 8, 24)) {
      this.lightsQueue = Math.floor(rand(1, 3));
      this.lightsTimer = rand(1.8, 2.8);
      this.mark('lights');
      return true;
    }

    const candidates = this.spots.filter((s) => {
      if (s.done || (!s.apply && !s.stages?.length)) return false;
      if (FORCE_STORY && s.kind !== FORCE_STORY) return false;
      if (s.animatedDoor) {
        // 열기는 별도 주기, 처음부터 열린 문의 닫기는 일반 이상 현상 주기.
        return s.kind === 'door' && s.opening === false && s.seen && this.canMoveDoor(s, p);
      }
      if (s.kind === 'echo') {
        // 아직 못 본 교차로에, 방금 전 다른 교차로에서 본 사물을 놓음
        return !s.seen && this.lastLandmark !== null && this.lastLandmark.piece !== s.piece && this.safeToChange(s, p, f);
      }
      return s.seen && this.safeToChange(s, p, f);
    });
    if (candidates.length === 0) return false;

    const s = pick(candidates);
    this.applySpot(s);
    return true;
  }

  private applySpot(s: Spot): void {
    s.done = true;
    if (s.animatedDoor) this.doorTimer = rand(...DOOR_INTERVAL);
    if (s.stages?.length) {
      this.applyStage(s, 0);
      return;
    }
    if (s.kind === 'echo') {
      s.apply!(this.lastLandmark!.prop);
      // 같은 사물은 한 번만 따라 나옴
      this.lastLandmark = null;
    } else {
      s.apply!();
    }
    if (s.update?.(0)) this.moving.add(s);
    if (s.kind === 'door') {
      this.sound.playCreak({ x: s.x, y: 1.2, z: s.z }, '[문이 천천히 끼이익 움직임]', s.motionDuration);
    }
    this.mark(s.kind);
  }

  private applyStage(spot: Spot, index: number): void {
    const stage = spot.stages![index];
    stage.apply();
    if (spot.update?.(0)) this.moving.add(spot);
    if (stage.sound === 'creak') {
      this.sound.playCreak({ x: spot.x, y: 1.2, z: spot.z }, '[문이 천천히 끼이익 열림]', stage.duration ?? spot.motionDuration);
    } else if (stage.sound === 'wetstep') {
      this.sound.playFootstep(true, { x: spot.x, y: 0.05, z: spot.z });
    }
    this.mark(`${spot.kind}:${index + 1}`);
    const next = spot.stages![index + 1];
    if (next) {
      this.pending = { spot, nextStage: index + 1, wait: DEBUG ? Math.min(2, next.delay ?? 14) : next.delay ?? 14 };
    } else {
      this.finishStory();
    }
  }

  private finishStory(): void {
    this.pending = null;
    this.timer = rand(...INTERVAL);
  }

  private mark(kind: string): void {
    this.count++;
    this.last = kind;
    if (DEBUG) console.info(`[anomaly] ${kind} (${this.count})`);
  }
}
