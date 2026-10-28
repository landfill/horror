import * as THREE from 'three';
import { SoundManager } from '../audio/SoundManager';
import { VideoClipPool } from '../ghost/VideoClipPool';
import { buildCorridor, buildJunction, FixtureSpec } from './CorridorBuilder';
import { Fixture, LightPool, LIGHT_FULL } from './Lighting';
import {
  DIRS,
  Dir,
  EdgeRef,
  HALF,
  ZoneKind,
  corridorFrame,
  corridorToWorld,
  edgeEnds,
  edgeOpen,
  edgeRef,
  forgetOutside,
  hasLineOfSight,
  isHighway,
  nearestNode,
  nodeCenter,
  resolveMove,
  setEdgeOpen,
  zoneOf,
} from './Maze';
import { Haunts } from './Haunts';
import { Anomalies } from './Anomalies';
import { pick, rand, updateSigns } from './Textures';

const BUILD_RADIUS = 2; // 이 맨해튼 거리 안의 교차로는 생성
const KEEP_RADIUS = 3; // 이 거리를 넘으면 해제 (경계에서 계속 재생성되지 않게 여유)
const VISIBLE_CHECK_DIST = 50;

const params = new URLSearchParams(location.search);
/** ?mutate=fast : 길 바뀜을 자주 시도 (확인용) */
const FAST_MUTATE = params.get('mutate') === 'fast';

/** 교차로 하나 또는 복도 하나 */
interface Piece {
  key: string;
  root: THREE.Group;
}

const jKey = (i: number, j: number) => `J:${i},${j}`;
const cKey = (i: number, j: number, dir: 'N' | 'E') => `C:${i},${j},${dir}`;

/** 복도의 소유 교차로와 방향 (각 교차로는 자기 N/E 복도를 소유) */
function ownerOf(e: EdgeRef): { i: number; j: number; dir: 'N' | 'E' } {
  return e.vertical ? { i: e.i, j: e.j, dir: 'N' } : { i: e.i, j: e.j, dir: 'E' };
}

/**
 * 격자형으로 끝없이 이어지는 복도 미로.
 * - 교차로에서 좌우로 꺾을 수 있고, 막다른 곳도 있음
 * - 지나온 길은 바뀜: 보이지 않는 곳의 복도가 수시로 열리고 닫히며,
 *   멀리 떨어졌던 곳은 돌아오면 구조와 테마가 새로 정해져 있음
 * 귀신 연출은 Haunts가 담당합니다.
 */
export class EndlessWorld {
  private scene: THREE.Scene;
  private sound: SoundManager;
  private pieces = new Map<string, Piece>();
  private loadedNodes = new Set<string>();
  // 같은 교차로 안에서는 생성/해제 범위가 변하지 않음.
  private streamedNodeI = NaN;
  private streamedNodeJ = NaN;
  private lights: LightPool;
  public readonly haunts: Haunts;
  public readonly anomalies: Anomalies;

  private player = new THREE.Vector3();
  private lastValid = new THREE.Vector3(0, 0, 0);
  private currentZone: ZoneKind | null = null;

  // 화면 왜곡/암전 연출 상태 (main.ts의 MonochromeShader에 전달)
  public visualDistort = 0;
  public visualBrightness = 1.0;

  // 소리 이벤트는 드물게. 정적이 길어야 소리 하나가 무섭다.
  private ambientEventTimer = rand(30, 50);
  private footstepEchoTimer = rand(20, 35);
  private mutateTimer = FAST_MUTATE ? 0.3 : rand(3, 6);
  /** 디버그: 길이 바뀐 횟수 */
  public mutations = 0;

  constructor(scene: THREE.Scene, sound: SoundManager, pool: VideoClipPool) {
    this.scene = scene;
    this.sound = sound;
    this.lights = new LightPool(scene);
    this.haunts = new Haunts(scene, sound, pool, this.lights, this);
    this.anomalies = new Anomalies(sound, this.lights);
    this.stream(0, 0);
  }

  // -------------------------------------------------------------------------
  // 조각 생성 / 해제
  // -------------------------------------------------------------------------

  private toFixtures(specs: FixtureSpec[], toWorld: (x: number, z: number) => { x: number; z: number }): Fixture[] {
    return specs.map((f) => {
      const w = toWorld(f.x, f.z);
      return {
        x: w.x,
        y: f.y,
        z: w.z,
        base: f.base,
        seed: Math.random() * 100,
        dead: f.dead ?? false,
        current: f.base,
        dist: 0,
        mat: f.mat,
      };
    });
  }

  private addPiece(key: string, root: THREE.Group, fixtures: Fixture[]): void {
    this.scene.add(root);
    this.lights.add(key, fixtures);
    this.pieces.set(key, { key, root });
  }

  private removePiece(key: string): void {
    const p = this.pieces.get(key);
    if (!p) return;
    this.haunts.onCellDisposed(key);
    this.anomalies.removePiece(key);
    this.lights.remove(key);
    this.scene.remove(p.root);
    p.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        // 소품끼리 함께 쓰는 지오메트리(Props의 shared)는 남겨 둠
        if (!obj.geometry.userData.shared) obj.geometry.dispose();
        // 형광등과 문틈 눈의 독립적인 페이드 재질만 해제. 공유 재질은 유지.
        if (obj.userData.fixture || obj.userData.disposeMaterial) (obj.material as THREE.Material).dispose();
      }
    });
    this.pieces.delete(key);
  }

  private buildJunctionPiece(i: number, j: number): void {
    const key = jKey(i, j);
    const zone = zoneOf(i, j);
    const c = nodeCenter(i, j);
    const built = buildJunction(i, j, zone, LIGHT_FULL);
    const root = new THREE.Group();
    built.group.position.set(c.x, 0, c.z);
    root.add(built.group);
    const toWorld = (x: number, z: number) => ({ x: c.x + x, z: c.z + z });
    this.addPiece(key, root, this.toFixtures(built.fixtures, toWorld));
    this.anomalies.add(key, built.spots, toWorld);
    this.haunts.onJunctionBuilt(key, i, j, zone, root);
  }

  private buildCorridorPiece(i: number, j: number, dir: 'N' | 'E'): void {
    const key = cKey(i, j, dir);
    const zone = zoneOf(i, j);
    const frame = corridorFrame(i, j, dir);
    const built = buildCorridor(zone, LIGHT_FULL);
    built.group.position.set(frame.ox, 0, frame.oz);
    built.group.rotation.y = frame.rotY;
    const root = new THREE.Group();
    root.add(built.group);
    const toWorld = (x: number, z: number) => corridorToWorld(frame, x, z);
    this.addPiece(key, root, this.toFixtures(built.fixtures, toWorld));
    this.anomalies.add(key, built.spots, toWorld);
    this.haunts.onCorridorBuilt(key, zone, frame, built.group);
  }

  private stream(x: number, z: number): void {
    const { i, j } = nearestNode(x, z);
    if (i === this.streamedNodeI && j === this.streamedNodeJ) return;
    let changed = false;
    for (let di = -BUILD_RADIUS; di <= BUILD_RADIUS; di++) {
      for (let dj = -BUILD_RADIUS; dj <= BUILD_RADIUS; dj++) {
        if (Math.abs(di) + Math.abs(dj) > BUILD_RADIUS) continue;
        const ni = i + di;
        const nj = j + dj;
        const nk = `${ni},${nj}`;
        if (this.loadedNodes.has(nk)) continue;
        this.loadedNodes.add(nk);
        this.buildJunctionPiece(ni, nj);
        for (const dir of ['N', 'E'] as const) {
          if (edgeOpen(ni, nj, dir)) this.buildCorridorPiece(ni, nj, dir);
        }
        changed = true;
      }
    }
    for (const nk of [...this.loadedNodes]) {
      const [ni, nj] = nk.split(',').map(Number);
      if (Math.abs(ni - i) + Math.abs(nj - j) <= KEEP_RADIUS) continue;
      this.loadedNodes.delete(nk);
      this.removePiece(jKey(ni, nj));
      this.removePiece(cKey(ni, nj, 'N'));
      this.removePiece(cKey(ni, nj, 'E'));
      changed = true;
    }
    if (changed) {
      // 로드된 곳과 닿지 않는 기억은 지움 → 돌아오면 다시 정해짐
      forgetOutside((a, b) => this.loadedNodes.has(`${a},${b}`));
    }
    this.streamedNodeI = i;
    this.streamedNodeJ = j;
  }

  // -------------------------------------------------------------------------
  // 지나온 길 바꾸기 (보이지 않는 곳에서만)
  // -------------------------------------------------------------------------

  private isLoaded(i: number, j: number): boolean {
    return this.loadedNodes.has(`${i},${j}`);
  }

  private pointVisible(x: number, z: number): boolean {
    const d = Math.hypot(x - this.player.x, z - this.player.z);
    if (d < 2) return true;
    if (d > VISIBLE_CHECK_DIST) return false;
    return hasLineOfSight(this.player.x, this.player.z, x, z);
  }

  private junctionVisible(i: number, j: number): boolean {
    const c = nodeCenter(i, j);
    const o = HALF - 0.15;
    const pts = [
      [0, 0],
      [o, o],
      [-o, o],
      [o, -o],
      [-o, -o],
    ];
    return pts.some(([dx, dz]) => this.pointVisible(c.x + dx, c.z + dz));
  }

  private corridorVisible(e: EdgeRef): boolean {
    const o = ownerOf(e);
    const f = corridorFrame(o.i, o.j, o.dir);
    for (let lz = -0.5; lz > -18; lz -= 2.5) {
      for (const lx of [-1.4, 0, 1.4]) {
        const w = corridorToWorld(f, lx, lz);
        if (this.pointVisible(w.x, w.z)) return true;
      }
    }
    return false;
  }

  /** 플레이어 위치에서 큰 길까지 로드된 교차로만으로 갈 수 있는지 (갇힘 방지) */
  private reachesHighway(): boolean {
    const start = nearestNode(this.player.x, this.player.z);
    const onHighway = (i: number, j: number) => i % 4 === 0 || j % 4 === 0;
    const seen = new Set<string>([`${start.i},${start.j}`]);
    const queue: [number, number][] = [[start.i, start.j]];
    while (queue.length) {
      const [i, j] = queue.shift()!;
      if (onHighway(i, j)) return true;
      for (const dir of Object.keys(DIRS) as Dir[]) {
        const { di, dj } = DIRS[dir];
        const k = `${i + di},${j + dj}`;
        if (seen.has(k) || !this.isLoaded(i + di, j + dj)) continue;
        if (!edgeOpen(i, j, dir)) continue;
        seen.add(k);
        queue.push([i + di, j + dj]);
      }
    }
    return false;
  }

  /** 보이지 않는 복도를 하나 찾아 열거나 닫음 (한 번에 후보 몇 개까지 검사). 성공하면 true. */
  public tryMutate(): boolean {
    const candidates: { i: number; j: number; dir: 'N' | 'E' }[] = [];
    for (const nk of this.loadedNodes) {
      const [i, j] = nk.split(',').map(Number);
      for (const dir of ['N', 'E'] as const) {
        const e = edgeRef(i, j, dir);
        if (isHighway(e)) continue;
        const [[ai, aj], [bi, bj]] = edgeEnds(e);
        if (this.isLoaded(ai, aj) && this.isLoaded(bi, bj)) candidates.push({ i, j, dir });
      }
    }
    // 무작위 순서로 최대 6개까지 시도
    for (let k = candidates.length - 1; k > 0; k--) {
      const r = Math.floor(Math.random() * (k + 1));
      [candidates[k], candidates[r]] = [candidates[r], candidates[k]];
    }
    for (const c of candidates.slice(0, 6)) {
      if (this.mutateEdge(c.i, c.j, c.dir)) return true;
    }
    return false;
  }

  private mutateEdge(i: number, j: number, dir: 'N' | 'E'): boolean {
    const e = edgeRef(i, j, dir);
    const [[ai, aj], [bi, bj]] = edgeEnds(e);

    // 바뀌는 모든 부분(양쪽 교차로 벽, 복도 자리)이 플레이어에게 안 보여야 함
    if (this.junctionVisible(ai, aj) || this.junctionVisible(bi, bj) || this.corridorVisible(e)) return false;

    const wasOpen = edgeOpen(i, j, dir);
    setEdgeOpen(e, !wasOpen);
    if (wasOpen && !this.reachesHighway()) {
      setEdgeOpen(e, true); // 닫으면 갇히는 경우 취소
      return false;
    }

    // 다시 만듦: 양쪽 교차로(벽 모양이 바뀜) + 복도 추가/제거
    this.removePiece(jKey(ai, aj));
    this.removePiece(jKey(bi, bj));
    this.buildJunctionPiece(ai, aj);
    this.buildJunctionPiece(bi, bj);
    const o = ownerOf(e);
    this.removePiece(cKey(o.i, o.j, o.dir));
    if (!wasOpen) this.buildCorridorPiece(o.i, o.j, o.dir);
    this.mutations++;

    // 가끔 멀리서 문이 닫히는 듯한 소리
    if (Math.random() < 0.3) {
      const c = nodeCenter(ai, aj);
      this.sound.playCreak({ x: c.x, y: 1.4, z: c.z }, '[멀리서 문 닫히는 소리]');
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 공개 도구
  // -------------------------------------------------------------------------

  /** 디버그: 교차로 (i, j)에서 열린 방향 */
  public debugOpenDirs(i: number, j: number): Dir[] {
    return (['N', 'E', 'S', 'W'] as Dir[]).filter((d) => edgeOpen(i, j, d));
  }

  /** 디버그: 주변 교차로의 복도 열림 상태 */
  public debugEdgeSnapshot(r = 2): string {
    const out: string[] = [];
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        out.push((['N', 'E', 'S', 'W'] as Dir[]).map((d) => (edgeOpen(i, j, d) ? 1 : 0)).join(''));
      }
    }
    return out.join(' ');
  }

  public lightAt(x: number, y: number, z: number): number {
    return this.lights.lightAt(x, y, z);
  }

  /** 디버그/연출용 순간이동 (충돌 검사를 건너뜀) */
  public teleport(pos: THREE.Vector3, x: number, z: number): void {
    pos.x = x;
    pos.z = z;
    this.lastValid.set(x, 0, z);
    this.stream(x, z);
  }

  /** 첫 화면용: 귀신·길 바꾸기 없이 형광등만. steady면 깜빡임도 없음 */
  public idle(elapsed: number, steady = false): void {
    this.lights.update(elapsed, this.player.x, this.player.z, steady);
  }

  public flash(brightness: number, distort: number): void {
    this.visualBrightness = Math.min(this.visualBrightness, brightness);
    this.visualDistort = Math.max(this.visualDistort, distort);
  }

  // -------------------------------------------------------------------------
  // 매 프레임
  // -------------------------------------------------------------------------

  public update(
    dt: number,
    elapsed: number,
    playerPos: THREE.Vector3,
    cameraForward: THREE.Vector3,
    isMoving: boolean
  ): void {
    // 화면 왜곡/밝기 서서히 복구
    this.visualDistort = Math.max(0, this.visualDistort - dt * 1.4);
    this.visualBrightness += (1.0 - this.visualBrightness) * Math.min(1, dt * 3.5);

    // 1. 벽 충돌: 이동 가능 영역 밖이면 한 축씩 미끄러지게
    const r = resolveMove(this.lastValid.x, this.lastValid.z, playerPos.x, playerPos.z);
    playerPos.x = r.x;
    playerPos.z = r.z;
    this.lastValid.set(r.x, 0, r.z);
    this.player.copy(playerPos);

    // 2. 주변 구역 생성/해제
    this.stream(playerPos.x, playerPos.z);

    // 3. 보이지 않는 곳의 길을 바꿈
    this.mutateTimer -= dt;
    if (this.mutateTimer <= 0) {
      const ok = this.tryMutate();
      this.mutateTimer = FAST_MUTATE ? 0.3 : ok ? rand(4, 9) : rand(0.8, 1.6);
    }

    // 4. 조명, 안내판 언어 바뀜
    this.lights.update(elapsed, playerPos.x, playerPos.z);
    updateSigns(elapsed);

    // 5. 다른 테마 공간에 들어서면 가끔 그 공간의 소리
    const { i, j } = nearestNode(playerPos.x, playerPos.z);
    const zone = zoneOf(i, j);
    if (zone !== this.currentZone) {
      if (this.currentZone !== null && Math.random() < 0.5) {
        this.triggerZoneEntrySound(zone, playerPos, cameraForward);
      }
      this.currentZone = zone;
    }

    // 6. 귀신
    this.haunts.update(dt, elapsed, playerPos, cameraForward, isMoving);

    // 6-1. 사물·공간의 이상 현상 (귀신이 보이는 동안에는 쉼)
    this.anomalies.update(dt, playerPos, cameraForward, this.haunts.presenceActive);

    // 7. 등 뒤에서 반 박자 늦게 따라오는 젖은 발소리 (드물게)
    if (isMoving) {
      this.footstepEchoTimer -= dt;
      if (this.footstepEchoTimer <= 0) {
        this.footstepEchoTimer = rand(18, 40);
        const back = horizontal(cameraForward).multiplyScalar(-3.2);
        this.sound.playFootstep(true, { x: playerPos.x + back.x, y: 0.1, z: playerPos.z + back.z });
      }
    }

    // 8. 간헐적 환경음
    this.ambientEventTimer -= dt;
    if (this.ambientEventTimer <= 0) {
      this.ambientEventTimer = rand(25, 55);
      this.triggerRandomDreadAudio(playerPos, zone);
    }
  }

  /** 플레이어 주변 임의 방향 dist 거리의 소리 위치 (벽 너머여도 상관없음) */
  private around(playerPos: THREE.Vector3, dist: number) {
    const a = Math.random() * Math.PI * 2;
    return { x: playerPos.x + Math.cos(a) * dist, y: rand(0.5, 2.2), z: playerPos.z + Math.sin(a) * dist };
  }

  private triggerZoneEntrySound(zone: ZoneKind, playerPos: THREE.Vector3, forward: THREE.Vector3): void {
    const f = horizontal(forward);
    const ahead = { x: playerPos.x + f.x * 8, y: 1.5, z: playerPos.z + f.z * 8 };
    switch (zone) {
      case 'school':
        this.sound.playChalkScrape(ahead);
        break;
      case 'apt404':
        this.sound.playShamanBell(ahead);
        break;
      case 'tatami':
        this.sound.playDeathRattle(ahead);
        break;
      case 'video':
        this.sound.playVhsStatic(0.35);
        break;
      case 'subway':
        this.sound.playEerieHumOrWhisper(
          { x: playerPos.x - f.x * 3.5, y: 1.6, z: playerPos.z - f.z * 3.5 },
          '[등 뒤의 숨소리]',
          true
        );
        break;
    }
  }

  private triggerRandomDreadAudio(playerPos: THREE.Vector3, zone: ZoneKind): void {
    const pos = this.around(playerPos, pick([5, 7, 9]));
    const r = Math.random();
    if (r < 0.28) {
      this.sound.playCreak(pos, '[문이 끼익거림]');
    } else if (r < 0.52) {
      this.sound.playDeathRattle(pos);
    } else if (r < 0.75) {
      if (zone === 'apt404') this.sound.playShamanBell(pos);
      else if (zone === 'school') this.sound.playChalkScrape(pos);
      else this.sound.playEerieHumOrWhisper(pos);
    } else {
      // 순간 정적: 형광등 웅웅거림이 뚝 끊김
      this.sound.setSilenceCut(true);
      setTimeout(() => this.sound.setSilenceCut(false), 2200);
    }
  }
}

export function horizontal(v: THREE.Vector3): THREE.Vector3 {
  const h = new THREE.Vector3(v.x, 0, v.z);
  if (h.lengthSq() < 1e-6) h.set(0, 0, -1);
  return h.normalize();
}
