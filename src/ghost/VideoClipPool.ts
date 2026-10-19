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

  private users = 0;
  private sinceUpload = 0;
  private holdTimer = 0;

  constructor(src: string) {
    const v = document.createElement('video');
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
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
    v.addEventListener('error', () => {
      this.failed = true;
      console.warn('[ghost] 영상을 불러오지 못했습니다:', src);
    });
  }

  public acquire(): void {
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

export class VideoClipPool {
  private entries = new Map<string, ClipEntry>();

  constructor() {
    // 모든 영상을 미리 만들어 두어 처음 등장할 때 검은 화면이 나오지 않게 함
    for (const clip of GHOST_CLIPS) {
      this.get(clip.src).stepFps = clip.stepFps;
      if (clip.srcReversed) this.get(clip.srcReversed).stepFps = clip.stepFps;
    }
  }

  public get(src: string): ClipEntry {
    let e = this.entries.get(src);
    if (!e) {
      e = new ClipEntry(src);
      this.entries.set(src, e);
    }
    return e;
  }

  /**
   * 반드시 사용자 클릭 핸들러 안에서 호출해야 합니다.
   * iOS는 사용자 입력 안에서 한 번 재생한 영상만 나중에 자유롭게 재생할 수 있습니다.
   */
  public unlock(): void {
    for (const e of this.entries.values()) {
      const v = e.video;
      v.play()
        .then(() => {
          if (!e.inUse) v.pause();
        })
        .catch(() => {});
    }
  }

  public pauseAll(pause: boolean): void {
    for (const e of this.entries.values()) {
      if (pause) e.video.pause();
      else if (e.inUse) e.video.play().catch(() => {});
    }
  }

  public tick(dt: number): void {
    for (const e of this.entries.values()) e.tick(dt);
  }
}
