import * as THREE from 'three';
import { GhostFigure, GhostPose } from '../world/GhostFigure';
import type { GhostVoiceTag } from '../audio/GhostVoice';
import { GhostClip, GhostRole, clipForRole } from './clips';
import { ClipEntry, VideoClipPool } from './VideoClipPool';

export interface GhostContext {
  /** 카메라(플레이어 눈) 위치 */
  cameraPos: THREE.Vector3;
  /** 귀신이 서 있는 자리의 밝기 0~1 (주변 형광등 세기와 거리로 계산) */
  light: number;
}

const vertexShader = /* glsl */ `
  #include <fog_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <fog_pars_fragment>
  uniform sampler2D map;
  uniform float uLight;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    // stacked-alpha: 위쪽 절반 = 색상, 아래쪽 절반 = 투명도
    // 두 절반의 경계에서 색이 번지지 않도록 살짝 안쪽만 샘플링
    float y = clamp(vUv.y, 0.004, 0.996);
    vec3 col = texture2D(map, vec2(vUv.x, 0.5 + y * 0.5)).rgb;
    float a = texture2D(map, vec2(vUv.x, y * 0.5)).r;

    // 변환 스크립트가 프리멀티플라이 했으므로 원래 색으로 되돌림
    col = clamp(col / max(a, 0.001), 0.0, 1.0);

    // 주변 형광등 밝기에 맞춤 (어두운 곳에서는 실루엣만 남음)
    col *= uLight;

    a *= uOpacity;
    if (a < 0.04) discard;

    gl_FragColor = vec4(col, a);
    #include <fog_fragment>
  }
`;

/**
 * 귀신 셰이더 재질 재사용 풀.
 * 재질을 해제하면 three.js가 셰이더 프로그램도 버려서, 다음 귀신이 나타날 때
 * 다시 컴파일하느라 화면이 멈칫함. 그래서 해제하지 않고 돌려 씀.
 */
const materialPool: THREE.ShaderMaterial[] = [];

function acquireMaterial(): THREE.ShaderMaterial {
  const reused = materialPool.pop();
  if (reused) return reused;
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        map: { value: null },
        uLight: { value: 1 },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
      },
    ]),
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
    // 벽·천장에 붙였을 때 깜빡이며 겹쳐 보이지 않게
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

let contactShadowTex: THREE.Texture | null = null;
function getContactShadowTexture(): THREE.Texture {
  if (contactShadowTex) return contactShadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  contactShadowTex = new THREE.CanvasTexture(c);
  return contactShadowTex;
}

const ROLE_TO_FALLBACK_POSE: Record<GhostRole, GhostPose> = {
  standing: 'standing',
  approach: 'standing',
  crawling: 'crawling',
  peeking: 'peeking',
  crouched: 'crouched',
  suspended: 'suspended',
  ceiling: 'crouched',
  wallcrawl: 'crawling',
};

export interface VideoGhostOptions {
  /** 항상 플레이어를 향해 세로축으로 회전 (기본 true). false면 body의 방향을 직접 지정. */
  billboard?: boolean;
  /** 발밑 접지 그림자 (기본 true) */
  shadow?: boolean;
}

/**
 * 실사 영상 귀신.
 * 복도 안에 세운 판에 투명 배경 영상을 입히고, 안개·형광등 깜빡임을 같이 받게 해서
 * 그 자리에 실제로 서 있는 것처럼 보이게 합니다.
 * 영상을 못 불러오면 기존 절차적 모델(GhostFigure)로 대체합니다.
 */
export class VideoGhost {
  public readonly root = new THREE.Group();
  public readonly role: GhostRole;
  public readonly approachSpeedMps?: number;
  /** 영상 속 인물의 성별·나이에 맞는 목소리 (태그가 없으면 undefined) */
  public readonly voice?: GhostVoiceTag;
  /** 외부에서 서서히 나타나기/사라지기에 사용 (0~1) */
  public opacity = 1;

  private clip: GhostClip | undefined;
  private entry: ClipEntry | null = null;
  private pool: VideoClipPool;
  /** 영상 판의 부모. billboard가 꺼져 있으면 호출 측에서 위치/방향을 지정 */
  public readonly body = new THREE.Group();
  /** true면 현재 프레임에서 멈춤 (보고 있는 동안 얼어붙는 연출) */
  public freeze = false;
  private billboardOn: boolean;
  /** 천장에 매달리는 영상인지 (clips.ts의 hangV) */
  public readonly hangs: boolean;
  private plane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private shadow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;
  private fallback: GhostFigure | null = null;
  private reversed = false;
  private stutterTimer = Math.random() * 4;
  private disposed = false;

  constructor(role: GhostRole, pool: VideoClipPool, opts: VideoGhostOptions = {}) {
    this.role = role;
    this.pool = pool;
    this.billboardOn = opts.billboard ?? true;
    this.clip = clipForRole(role);
    this.approachSpeedMps = this.clip?.approachSpeedMps;
    if (this.clip?.gender && this.clip.age) {
      this.voice = { gender: this.clip.gender, age: this.clip.age, kinds: this.clip.voices };
    }
    this.hangs = this.clip?.hangV !== undefined;
    // 매달린 영상은 옆모습이라 항상 플레이어를 향해야 함
    if (this.hangs) this.billboardOn = true;
    this.root.add(this.body);

    if (!this.clip) {
      this.useFallback();
      return;
    }

    this.entry = pool.get(this.clip.src);
    this.entry.acquire();

    const h = this.clip.frameHeightM;
    const w = h * this.clip.aspect;
    const geo = new THREE.PlaneGeometry(w, h);
    // 발 위치가 y=0에 오도록 판을 올림
    if (this.clip.hangV !== undefined) {
      // 천장에 닿는 지점이 y=0, 몸은 그 아래로 늘어짐
      geo.translate(0, -(h / 2 - this.clip.hangV * h), 0);
    } else {
      // 발 위치가 y=0에 오도록 판을 올림
      geo.translate(0, h / 2 - this.clip.footV * h, 0);
    }

    const mat = acquireMaterial();
    mat.uniforms.map.value = this.entry.texture;
    mat.uniforms.uOpacity.value = 0;
    this.plane = new THREE.Mesh(geo, mat);
    this.plane.renderOrder = 2;
    this.body.add(this.plane);

    // 발밑 접지 그림자 (실시간 그림자 대신 저렴하게)
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: getContactShadowTexture(),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    // 판 폭이 아니라 사람 발밑 크기 정도로 (판은 인물보다 넓을 수 있음)
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w * 0.75, 0.42), 20), shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.012;
    this.shadow.scale.set(1, 0.6, 1);
    if (opts.shadow ?? true) this.root.add(this.shadow);
  }

  /** 미리 역재생해 둔 영상으로 전환 (사다코식 "뒤로 걸은 걸 거꾸로 튼" 걸음) */
  public setReversed(on: boolean): void {
    if (!this.clip?.srcReversed || on === this.reversed || !this.plane) return;
    this.reversed = on;
    const next = this.pool.get(on ? this.clip.srcReversed : this.clip.src);
    next.acquire();
    this.entry?.release();
    this.entry = next;
    this.plane.material.uniforms.map.value = next.texture;
  }

  private useFallback(): void {
    if (this.fallback) return;
    if (this.plane) this.plane.visible = false;
    if (this.shadow) this.shadow.visible = false;
    this.entry?.release();
    this.entry = null;
    this.fallback = new GhostFigure(ROLE_TO_FALLBACK_POSE[this.role]);
    this.root.add(this.fallback.root);
  }

  public update(dt: number, elapsed: number, ctx: GhostContext): void {
    if (this.disposed) return;
    if (this.entry?.failed) this.useFallback();

    if (this.fallback) {
      this.fallback.update(dt, elapsed);
      return;
    }
    if (!this.plane || !this.entry) return;

    const wp = new THREE.Vector3();
    this.root.getWorldPosition(wp);
    if (this.billboardOn) {
      // 판이 항상 플레이어를 정면으로 보게 함 (세로축으로만 회전)
      const parentYaw = new THREE.Euler().setFromQuaternion(
        this.root.getWorldQuaternion(new THREE.Quaternion()),
        'YXZ'
      ).y;
      this.body.rotation.y = Math.atan2(ctx.cameraPos.x - wp.x, ctx.cameraPos.z - wp.z) - parentYaw;
    }

    if (this.freeze) {
      this.entry.hold(0.1);
    } else {
      // 가끔 프레임을 붙잡았다 놓아 동작이 툭 끊기게 함
      this.stutterTimer -= dt;
      if (this.stutterTimer <= 0) {
        this.stutterTimer = 1.5 + Math.random() * 5;
        this.entry.hold(0.12 + Math.random() * 0.5);
      }
    }

    const u = this.plane.material.uniforms;
    u.uLight.value = ctx.light;
    u.uTime.value = elapsed;
    // 첫 프레임이 준비되기 전에는 보이지 않게 (검은 사각형 방지)
    u.uOpacity.value = this.entry.ready ? this.opacity : 0;
    if (this.shadow) {
      // 바닥에 서 있을 때만 접지 그림자 (허공에 매달린 경우 제외)
      const onFloor = wp.y < 0.1;
      this.shadow.visible = onFloor;
      this.shadow.material.opacity = 0.55 * this.opacity * (this.entry.ready ? 1 : 0);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entry?.release();
    this.entry = null;
    if (this.plane) {
      this.plane.geometry.dispose();
      this.plane.material.uniforms.map.value = null;
      materialPool.push(this.plane.material);
    }
    if (this.shadow) {
      this.shadow.geometry.dispose();
      this.shadow.material.dispose();
    }
  }
}
