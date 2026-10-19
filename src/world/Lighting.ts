import * as THREE from 'three';

export const LIGHT_FULL = 6.0; // 켜진 형광등 하나의 세기
const POOL_SIZE = 12;
const LIGHT_RANGE = 14;
const FADE_START = 17;
const FADE_END = 25;

/** 천장 형광등 하나 (실제 PointLight가 아니라 위치·깜빡임 상태만 가짐) */
export interface Fixture {
  x: number;
  y: number;
  z: number;
  base: number;
  seed: number;
  dead: boolean;
  /** 이번 프레임의 밝기 */
  current: number;
  mat: THREE.MeshBasicMaterial;
}

/**
 * 형광등 기구는 많지만 실제 PointLight는 항상 12개만 씁니다.
 * three.js는 조명 개수가 바뀌면 모든 재질의 셰이더를 다시 컴파일해서 화면이 멈칫하므로,
 * 매 프레임 플레이어에게 가까운 기구 12개에 조명을 옮겨 붙입니다.
 */
export class LightPool {
  private lights: THREE.PointLight[] = [];
  private groups = new Map<string, Fixture[]>();
  private all: Fixture[] = [];
  private dirty = true;

  constructor(scene: THREE.Scene) {
    for (let k = 0; k < POOL_SIZE; k++) {
      const l = new THREE.PointLight(0xffffff, 0, LIGHT_RANGE, 1.6);
      l.position.set(0, -100, 0);
      scene.add(l);
      this.lights.push(l);
    }
  }

  public add(key: string, fixtures: Fixture[]): void {
    this.groups.set(key, fixtures);
    this.dirty = true;
  }

  public remove(key: string): void {
    this.groups.delete(key);
    this.dirty = true;
  }

  private list(): Fixture[] {
    if (this.dirty) {
      this.all = [...this.groups.values()].flat();
      this.dirty = false;
    }
    return this.all;
  }

  public update(elapsed: number, px: number, pz: number): void {
    const list = this.list();
    for (const f of list) {
      if (f.dead) {
        f.current = 0;
        f.mat.color.setHex(0x181818);
        continue;
      }
      const n = Math.sin(elapsed * 19 + f.seed) * Math.sin(elapsed * 43 + f.seed * 2.1);
      const drop = n > 0.82 ? 0.18 : n < -0.9 ? 0.45 : 1.0;
      f.current = f.base * drop;
      const c = (drop * 215) / 255;
      f.mat.color.setRGB(c, c, c);
    }

    const sorted = list
      .map((f) => ({ f, d: Math.hypot(f.x - px, f.z - pz) }))
      .sort((a, b) => a.d - b.d);

    for (let k = 0; k < this.lights.length; k++) {
      const l = this.lights[k];
      const s = sorted[k];
      if (!s) {
        l.intensity = 0;
        continue;
      }
      // 멀리 있는 조명은 서서히 꺼지게 해서 다른 기구로 옮겨 갈 때 튀지 않게 함
      const fade = 1 - THREE.MathUtils.smoothstep(s.d, FADE_START, FADE_END);
      l.position.set(s.f.x, s.f.y, s.f.z);
      l.intensity = s.f.current * fade;
    }
  }

  /** 한 지점이 형광등에 얼마나 밝게 비춰지는지 (0~1). 영상 귀신 밝기에 사용. */
  public lightAt(x: number, y: number, z: number): number {
    let sum = 0;
    for (const f of this.list()) {
      const d = Math.hypot(x - f.x, y - f.y, z - f.z);
      if (d > 11) continue;
      const falloff = 1 - d / 11;
      sum += (f.current / LIGHT_FULL) * falloff * falloff;
    }
    return Math.min(1, 0.05 + sum);
  }

  /**
   * (x, z) 근처 기구를 켜 둠. 어둠에 완전히 묻히면 안 되는 연출(모퉁이 엿보기)용.
   * 반경 안에 기구가 없으면 아무것도 하지 않음.
   */
  public ensureLit(x: number, z: number, minBase: number, radius = 3): void {
    for (const f of this.list()) {
      if (Math.hypot(f.x - x, f.z - z) > radius) continue;
      f.dead = false;
      f.base = Math.max(f.base, minBase);
    }
  }

  /** 가장 가까운 기구 하나를 꺼뜨림 (귀신과 마주친 뒤 어둠 속에 남겨두는 연출) */
  public killNearest(x: number, z: number): void {
    let best: Fixture | null = null;
    let bd = Infinity;
    for (const f of this.list()) {
      const d = Math.hypot(f.x - x, f.z - z);
      if (!f.dead && d < bd) {
        bd = d;
        best = f;
      }
    }
    if (best && bd < 8) best.dead = true;
  }
}
