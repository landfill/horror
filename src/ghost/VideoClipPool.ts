import * as THREE from 'three';
import { GHOST_CLIPS } from './clips';

/**
 * 귀신 영상 하나당 <video> 하나와 텍스처 하나를 만들어 공유합니다.
 * 복도 구간은 계속 생성/삭제되므로 구간마다 영상을 새로 만들지 않습니다.
 *
 * 텍스처는 VideoTexture 대신 일반 Texture를 쓰고 직접 갱신합니다.
 * 그래야 프레임을 일부러 붙잡아 두는 "뚝뚝 끊기는" 동작을 만들 수 있습니다.
 */
export class ClipEntry {
  public readonly video: HTMLVideoElement;
  public readonly texture: THREE.Texture;
  public failed = false;
  /** 첫 프레임이 GPU에 올라갔는지 */
  public ready = false;
  /** 초당 몇 번 텍스처를 갱신할지 (0 = 매 프레임) */
  public stepFps = 0;

  /** 내려받기를 시작했는지 (처음부터 받는 영상이거나, 쓰려고 했거나, 미리 받기 차례가 됨) */
  public requested: boolean;
  /** 사용자 입력 안에서 한 번 재생해 iOS 재생 허락을 받았는지 */
  public unlocked = false;
  /** 끝까지 끊김 없이 재생할 만큼 받았는지 */
  public loaded = false;
  /** 받기 시작한 뒤 지난 시간 (초). 브라우저가 끝까지 받지 않고 멈춰도 미리 받기가 막히지 않게 */
  public waited = 0;

  private users = 0;
  private sinceUpload = 0;
  private holdTimer = 0;

  /** eager=false면 메타데이터만 받아 두고, 실제로 쓰거나 미리 받기 차례가 될 때 내려받음 */
  constructor(src: string, eager: boolean) {
    const v = document.createElement('video');
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.preload = eager ? 'auto' : 'metadata';
    this.requested = eager;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    this.video = v;

    const tex = new THREE.Texture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.texture = tex;

    v.addEventListener('loadedmetadata', () => {
      // three.js가 텍스처 크기를 video.width/height로 읽기 때문에 맞춰 둡니다
      v.width = v.videoWidth;
      v.height = v.videoHeight;
    });
    v.addEventListener('canplaythrough', () => {
      this.loaded = true;
    });
    v.addEventListener('error', () => {
      this.failed = true;
      console.warn('[ghost] 영상을 불러오지 못했습니다:', src);
    });
  }

  /** 아직 안 받은 영상이면 지금 내려받기 시작 */
  public request(): void {
    if (this.requested) return;
    this.requested = true;
    this.video.preload = 'auto';
    this.video.load();
  }

  public acquire(): void {
    this.request();
    this.users++;
    if (this.users === 1) {
      this.video.play().catch(() => {
        /* 사용자 입력 전이면 unlock 이후 다시 시도됨 */
      });
    }
  }

  public release(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) this.video.pause();
  }

  public get inUse(): boolean {
    return this.users > 0;
  }

  /** 지금 프레임을 seconds 동안 멈춰 둠 (영상 자체는 계속 흐르므로 풀릴 때 동작이 툭 건너뜀) */
  public hold(seconds: number): void {
    this.holdTimer = Math.max(this.holdTimer, seconds);
  }

  public tick(dt: number): void {
    if (this.failed || this.users === 0) return;
    if (this.video.readyState < 2) return; // HAVE_CURRENT_DATA 전에는 업로드하면 안 됨

    if (this.holdTimer > 0) {
      this.holdTimer -= dt;
      if (this.ready) return;
    }

    this.sinceUpload += dt;
    const interval = this.stepFps > 0 ? 1 / this.stepFps : 0;
    if (!this.ready || this.sinceUpload >= interval) {
      this.sinceUpload = 0;
      this.texture.needsUpdate = true;
      this.ready = true;
    }

    // 일시정지 후 재개 등으로 멈춰 있으면 다시 재생
    if (this.video.paused) {
      this.video.play().catch(() => {});
    }
  }
}

/**
 * 처음부터 내려받는 영상 (자주 나오는 걸어오기·천장·기어오기).
 * 나머지는 메타데이터만 받아 두었다가, 쓰려고 할 때나 게임이 조용할 때 하나씩 미리 받습니다.
 * (영상 7개 약 32MB를 처음에 한꺼번에 받으면 모바일에서 데이터·메모리 부담이 큼)
 */
const EAGER_IDS = new Set(['approach', 'smiling', 'ceiling', 'crawling']);
/** 게임을 시작하고 이만큼 지난 뒤부터 나머지 영상을 하나씩 미리 받음 (초) */
const PREFETCH_AFTER = 12;

export class VideoClipPool {
  private entries = new Map<string, ClipEntry>();
  private started = false;
  private sincePrefetch = 0;

  constructor() {
    // 실제 영상은 미리 만들어 두어 처음 등장할 때 검은 화면이 나오지 않게 함 (임시 영상은 쓸 때만 만듦)
    for (const clip of GHOST_CLIPS) {
      if (clip.placeholder) continue;
      const eager = EAGER_IDS.has(clip.id);
      this.get(clip.src, eager).stepFps = clip.stepFps;
      if (clip.srcReversed) this.get(clip.srcReversed, eager).stepFps = clip.stepFps;
    }
    // 나중에 받기 시작한 영상도 iOS 재생 허락을 받도록, 사용자 입력이 있을 때마다 확인
    const onGesture = () => this.unlockPending();
    for (const type of ['touchstart', 'pointerdown', 'keydown'] as const) {
      window.addEventListener(type, onGesture, { capture: true, passive: true });
    }
  }

  public get(src: string, eager = true): ClipEntry {
    let e = this.entries.get(src);
    if (!e) {
      e = new ClipEntry(src, eager);
      const clip = GHOST_CLIPS.find((c) => c.src === src || c.srcReversed === src);
      if (clip) e.stepFps = clip.stepFps;
      this.entries.set(src, e);
    }
    return e;
  }

  /**
   * 반드시 사용자 클릭 핸들러 안에서 호출해야 합니다.
   * iOS는 사용자 입력 안에서 한 번 재생한 영상만 나중에 자유롭게 재생할 수 있습니다.
   * 아직 내려받지 않은 영상은 건드리지 않고(재생하면 내려받기가 시작됨), 받기 시작한 뒤의 입력에서 허락받습니다.
   */
  public unlock(): void {
    this.started = true;
    this.unlockPending();
  }

  private unlockPending(): void {
    if (!this.started) return;
    for (const e of this.entries.values()) {
      if (e.unlocked || !e.requested || e.failed) continue;
      e.unlocked = true;
      const v = e.video;
      v.play()
        .then(() => {
          if (!e.inUse) v.pause();
        })
        .catch(() => {
          e.unlocked = false;
        });
    }
  }

  /** 게임이 조용할 때(영상을 쓰고 있지 않을 때) 아직 안 받은 영상을 하나씩 미리 받음 */
  private prefetch(dt: number): void {
    if (!this.started) return;
    this.sincePrefetch += dt;
    if (this.sincePrefetch < PREFETCH_AFTER) return;
    let busy = false;
    let next: ClipEntry | null = null;
    for (const e of this.entries.values()) {
      if (e.failed) continue;
      if (e.requested && !e.loaded) e.waited += dt;
      if (e.inUse || (e.requested && !e.loaded && e.waited < 20)) busy = true;
      if (!e.requested && !next) next = e;
    }
    if (busy || !next) return;
    next.request();
    this.sincePrefetch = PREFETCH_AFTER - 4; // 다음 것은 4초 뒤에 다시 확인
  }

  public pauseAll(pause: boolean): void {
    for (const e of this.entries.values()) {
      if (pause) e.video.pause();
      else if (e.inUse) e.video.play().catch(() => {});
    }
  }

  public tick(dt: number): void {
    for (const e of this.entries.values()) e.tick(dt);
    this.prefetch(dt);
  }
}
