import * as THREE from 'three';
import { Mat, type PosterFrame } from './Textures';
import { hasLineOfSight } from './Maze';

export interface PosterSpec {
  x: number;
  y: number;
  z: number;
  normalX: number;
  normalZ: number;
  mesh: THREE.Mesh;
  variant: number;
}

type Reaction = 'blink' | 'smile';
interface Poster extends PosterSpec {
  piece: string;
  armed: boolean;
  frames: Record<PosterFrame, THREE.Material>;
}
interface ActiveReaction {
  poster: Poster;
  kind: Reaction;
  elapsed: number;
  assigned: THREE.Material;
}

const FRAMES: PosterFrame[] = ['neutral', 'blink-half', 'blink', 'smile-half', 'smile'];
const ENTER_DISTANCE = 3.5;
const REARM_DISTANCE = 5;
const SCAN_INTERVAL = 0.15;
const REACTION_CHANCE = 0.4;

/** 지나가는 동안 한 포스터만 잠깐 표정을 바꿈. 캔버스·공유 재질은 갱신하지 않습니다. */
export class PosterReactions {
  private posters: Poster[] = [];
  private active: ActiveReaction | null = null;
  private cooldown = 0;
  private scanTimer = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly point = new THREE.Vector3();
  public count = 0;
  public last = '';

  public get isReacting(): boolean { return this.active !== null; }

  public add(piece: string, specs: PosterSpec[], toWorld: (x: number, z: number) => { x: number; z: number }): void {
    for (const spec of specs) {
      const pos = toWorld(spec.x, spec.z);
      const normalEnd = toWorld(spec.x + spec.normalX, spec.z + spec.normalZ);
      const frames = {} as Record<PosterFrame, THREE.Material>;
      // 한 변형당 5장을 캐시에서 받아 둠. 반응 도중 새 그림을 그리지 않음.
      for (const frame of FRAMES) frames[frame] = Mat.poster(spec.variant, frame);
      this.posters.push({ ...spec, ...pos, piece, armed: true, frames,
        normalX: normalEnd.x - pos.x, normalZ: normalEnd.z - pos.z });
      spec.mesh.userData.posterFrame = 'neutral';
    }
  }

  public removePiece(piece: string): void {
    if (this.active?.poster.piece === piece) this.finish();
    this.posters = this.posters.filter((poster) => poster.piece !== piece);
  }

  public update(dt: number, position: THREE.Vector3, forward: THREE.Vector3, isMoving: boolean,
    camera?: THREE.PerspectiveCamera): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.active) {
      const active = this.active;
      if (active.poster.mesh.material !== active.assigned) {
        // 기존 전단지 뒷면 이상 현상 등이 재질을 바꿨으면 그대로 존중.
        this.active = null;
      } else {
        active.elapsed += dt;
        const t = active.elapsed;
        const duration = active.kind === 'blink' ? 0.72 : 1.95;
        if (t >= duration) this.finish();
        else if (active.kind === 'blink') {
          this.setFrame(t < 0.08 ? 'blink-half' : t < 0.44 ? 'blink' : t < 0.60 ? 'blink-half' : 'neutral');
        } else {
          this.setFrame(t < 0.2 ? 'smile-half' : t < 1.45 ? 'smile' : t < 1.75 ? 'smile-half' : 'neutral');
        }
      }
    }

    this.scanTimer -= dt;
    if (this.scanTimer > 0) return;
    this.scanTimer = SCAN_INTERVAL;
    if (camera) {
      camera.updateMatrixWorld();
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.viewProjection);
    }
    let nearest: Poster | null = null;
    let nearestDistance = Infinity;
    for (const poster of this.posters) {
      const dx = poster.x - position.x;
      const dz = poster.z - position.z;
      const dy = poster.y - position.y;
      const horizontalDistance = Math.hypot(dx, dz);
      if (horizontalDistance > REARM_DISTANCE) poster.armed = true;
      if (!isMoving || this.active || this.cooldown > 0 || !poster.armed) continue;
      if (poster.mesh.material !== poster.frames.neutral) continue;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > ENTER_DISTANCE || distance >= nearestDistance) continue;
      if (-dx * poster.normalX - dz * poster.normalZ <= 0) continue;
      if (camera) {
        if (!this.frustum.containsPoint(this.point.set(poster.x, poster.y, poster.z))) continue;
      } else if ((dx * forward.x + dy * forward.y + dz * forward.z) / (distance || 1) < 0.5) continue;
      if (!hasLineOfSight(position.x, position.z, poster.x, poster.z)) continue;
      nearest = poster;
      nearestDistance = distance;
    }
    if (!nearest) return;
    nearest.armed = false; // 이번 방문의 추첨은 한 번만. 실패해도 매 프레임 재추첨하지 않음.
    if (Math.random() >= REACTION_CHANCE) {
      this.cooldown = 1.5;
      return;
    }
    this.start(nearest, Math.random() < 0.65 ? 'blink' : 'smile');
  }

  /** 확인 화면에서 선택한 포스터에 같은 재생 경로를 사용합니다. */
  public preview(mesh: THREE.Mesh, kind: Reaction): boolean {
    if (this.active) return false;
    const poster = this.posters.find((entry) => entry.mesh === mesh);
    if (!poster || mesh.material !== poster.frames.neutral) return false;
    poster.armed = false;
    this.start(poster, kind);
    return true;
  }

  private start(poster: Poster, kind: Reaction): void {
    this.active = { poster, kind, elapsed: 0, assigned: poster.frames.neutral };
    this.cooldown = 8 + Math.random() * 6;
    this.count++;
    this.last = kind;
    this.setFrame(kind === 'blink' ? 'blink-half' : 'smile-half');
  }

  private setFrame(frame: PosterFrame): void {
    const active = this.active!;
    active.assigned = active.poster.frames[frame];
    active.poster.mesh.material = active.assigned;
    active.poster.mesh.userData.posterFrame = frame;
  }

  private finish(): void {
    if (this.active && this.active.poster.mesh.material === this.active.assigned) this.setFrame('neutral');
    this.active = null;
  }
}
