import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SoundManager } from './audio/SoundManager';
import { FirstPersonControls } from './input/FirstPersonControls';
import { MonochromeShader } from './fx/MonochromeShader';
import { EndlessWorld } from './world/EndlessWorld';
import { VideoClipPool } from './ghost/VideoClipPool';
import { AWAY_TITLES, HOME_TITLE, TitleScreen } from './ui/TitleScreen';

const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * 게임적 목표(점수, 수칙, 엘리베이터 이동, 클리어)를 완전히 배제하고,
 * 고대비 흑백(Monochrome) 시야와 끝없이 이어지는 5개 공포 공간 속에서
 * 어디로 걸어도 빠져나갈 수 없는 압박감만 남긴 호러 앱 코어.
 */
class InescapableHorrorApp {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private monoPass: ShaderPass;
  private sound: SoundManager;
  private controls: FirstPersonControls;
  private world: EndlessWorld;
  private ghostClips: VideoClipPool;

  private isPaused = true;
  /** 첫 화면을 보고 있는 동안: 복도는 그려지지만 귀신·이동은 멈춰 있음 */
  private onTitle = true;
  private title = new TitleScreen();
  private awayTitleIndex = 0;
  // 자막은 기본 꺼짐 (청각 접근성용 옵션으로만 제공)
  private showSubtitles = false;
  private stepDistanceAccum = 0;
  private elapsed = 0;
  private lastTime = performance.now();
  // 일시정지 화면은 마지막 프레임을 유지하고, 크기가 바뀔 때만 다시 그림.
  private renderDirty = true;
  private subtitleTimeout: number | null = null;
  // 매 프레임 쓰는 벡터는 재사용 (모바일에서 GC로 화면이 멈칫하지 않게)
  private moveVec = new THREE.Vector3();
  private camForward = new THREE.Vector3();

  private hudEl = document.getElementById('hud')!;
  private subtitleBoxEl = document.getElementById('subtitle-box')!;

  constructor() {
    const container = document.getElementById('canvas-container')!;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020202);
    // 짙은 흑백 안개로 먼 복도 끝을 암흑 속에 묻음
    this.scene.fog = new THREE.FogExp2(0x020202, 0.075);

    this.camera = new THREE.PerspectiveCamera(
      64,
      window.innerWidth / window.innerHeight,
      0.08,
      36
    );
    // 시작은 교차로 한가운데: 처음부터 갈림길이 보이게
    this.camera.position.set(0, 1.62, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.renderDirty = true;
    });

    // 형광등 밖에서도 문틀·사물의 윤곽을 읽을 수 있는 주변광.
    const ambient = new THREE.AmbientLight(0x888888, 0.65);
    this.scene.add(ambient);

    // 가까운 사물의 윤곽을 드러내는 약한 잔광. 복도 끝까지 밝히지는 않음.
    const eyeLight = new THREE.PointLight(0xffffff, 0.85, 6.0, 2.0);
    this.camera.add(eyeLight);
    this.scene.add(this.camera);

    // 후처리 파이프라인: RenderPass -> MonochromeShader(완전 흑백 + 고대비 + 필름그레인 + 스캔라인) -> OutputPass
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.monoPass = new ShaderPass(MonochromeShader);
    this.composer.addPass(this.monoPass);
    this.composer.addPass(new OutputPass());

    this.updateRendererSize();

    this.sound = new SoundManager();
    this.sound.setSubtitleHandler((text, reversed) =>
      this.displaySubtitle(text, reversed)
    );

    this.controls = new FirstPersonControls(
      this.camera,
      this.renderer.domElement,
      {
        // 첫 화면에서는 ESC로 일시정지 창이 뜨지 않게
        onPause: () => {
          if (!this.onTitle) this.togglePause(true);
        },
      }
    );
    this.controls.enabled = false;

    this.ghostClips = new VideoClipPool();
    this.world = new EndlessWorld(this.scene, this.sound, this.ghostClips);
    if (new URLSearchParams(location.search).get('debug')) {
      const w = window as unknown as Record<string, unknown>;
      w.__ghostClips = this.ghostClips;
      w.__app = this;
    }

    this.bindUI();
    this.setupTabTitleDread();
    this.title.start();

    window.addEventListener('resize', () => this.updateRendererSize());
    requestAnimationFrame((t) => this.animate(t));
  }

  private updateRendererSize(): void {
    const scale = window.innerWidth < 768 ? 0.75 : 0.9;
    const w = Math.max(1, Math.floor(window.innerWidth * scale));
    const h = Math.max(1, Math.floor(window.innerHeight * scale));
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.renderDirty = true;
  }

  private bindUI(): void {
    const startScreen = document.getElementById('start-screen')!;
    const optSubtitles = document.getElementById('opt-subtitles') as HTMLInputElement;
    const pauseSubtitles = document.getElementById('pause-subtitles') as HTMLInputElement;
    const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;

    optSubtitles.addEventListener('change', () => {
      this.showSubtitles = optSubtitles.checked;
      pauseSubtitles.checked = this.showSubtitles;
    });

    pauseSubtitles.addEventListener('change', () => {
      this.showSubtitles = pauseSubtitles.checked;
      optSubtitles.checked = this.showSubtitles;
    });

    volumeSlider.addEventListener('input', () => {
      this.sound.setVolume(Number(volumeSlider.value) / 100);
    });

    document.getElementById('btn-enter')!.addEventListener('click', () => {
      this.showSubtitles = optSubtitles.checked;
      pauseSubtitles.checked = this.showSubtitles;
      this.sound.init();
      // iOS 등에서 영상 재생을 허용받으려면 사용자 클릭 안에서 한 번 재생해야 함
      this.ghostClips.unlock();
      this.onTitle = false;
      // 첫 화면에서 흔들리던 시선을 복도 축에 맞춤 (안 그러면 '앞으로'가 비스듬히 벽 쪽을 향함)
      this.controls.setOrientation(0, 0);
      this.title.stop();
      startScreen.classList.remove('active');
      this.hudEl.classList.remove('hidden');
      this.resume();
    });

    document.getElementById('btn-pause')!.addEventListener('click', () => {
      this.togglePause(true);
    });

    document.getElementById('btn-resume')!.addEventListener('click', () => {
      this.togglePause(false);
    });
  }

  private togglePause(pause: boolean): void {
    this.renderDirty = true;
    const modal = document.getElementById('pause-modal')!;
    if (pause) {
      this.isPaused = true;
      this.controls.enabled = false;
      this.controls.unlockPointer();
      this.sound.pauseAll(true);
      this.ghostClips.pauseAll(true);
      modal.classList.add('active');
    } else {
      modal.classList.remove('active');
      this.sound.pauseAll(false);
      this.ghostClips.pauseAll(false);
      this.resume();
    }
  }

  private resume(): void {
    this.isPaused = false;
    this.controls.enabled = true;
    this.sound.resume();
    this.controls.lockPointer();
  }

  private displaySubtitle(text: string, reversed = false): void {
    if (!this.showSubtitles) return;
    this.subtitleBoxEl.textContent = text;
    this.subtitleBoxEl.classList.toggle('reversed', Boolean(reversed));
    this.subtitleBoxEl.classList.add('visible');

    if (this.subtitleTimeout) {
      window.clearTimeout(this.subtitleTimeout);
    }
    this.subtitleTimeout = window.setTimeout(() => {
      this.subtitleBoxEl.classList.remove('visible');
    }, 3800);
  }

  private setupTabTitleDread(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        document.title = AWAY_TITLES[this.awayTitleIndex++ % AWAY_TITLES.length];
        // 화면이 꺼지거나 다른 탭으로 가면 영상 디코딩도 멈춤 (배터리)
        this.ghostClips.pauseAll(true);
      } else {
        document.title = HOME_TITLE;
        if (!this.isPaused) this.ghostClips.pauseAll(false);
        if (!this.isPaused) {
          this.sound.playCreak(undefined, '[문 닫히는 소리]');
        }
      }
    });
  }

  /** 첫 화면 뒤의 복도: 숨 쉬듯 아주 느린 시선 흔들림 + 형광등 깜빡임 (움직임 줄이기 설정이면 둘 다 없음) */
  private idleOnTitle(): void {
    const t = this.elapsed;
    if (!REDUCED_MOTION) {
      const yaw = Math.sin(t * 0.13) * 0.05 + Math.sin(t * 0.047) * 0.03;
      const pitch = Math.sin(t * 0.09) * 0.012 - 0.015;
      this.controls.setOrientation(yaw, pitch);
    }
    this.world.idle(t, REDUCED_MOTION);
  }

  private animate(now: number): void {
    requestAnimationFrame((t) => this.animate(t));
    // 숨겨진 탭에서는 그리지 않음 (대부분 브라우저는 이때 프레임 자체를 멈추지만, 멈추지 않는 환경 대비)
    if (document.hidden) {
      this.lastTime = now;
      return;
    }

    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (this.isPaused && !this.onTitle && !this.renderDirty) return;
    this.elapsed += dt;

    if (!this.isPaused) {
      this.controls.update(dt);
      // 무겁고 느린 보행 속도 (게임처럼 빠르게 뛰어다닐 수 없음)
      const speed = this.controls.isRunning ? 2.45 : 1.85;
      const yaw = this.controls.getYaw();
      // 앞 (-sin, -cos), 오른쪽 (cos, -sin): (0,0,-1)·(1,0,0)을 y축으로 yaw만큼 돌린 것과 같음
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const f = this.controls.moveForward;
      const r = this.controls.moveRight;
      const moveVec = this.moveVec.set(-sin * f + cos * r, 0, -cos * f - sin * r);

      const isMoving = moveVec.lengthSq() > 0.001;
      if (isMoving) {
        moveVec.normalize().multiplyScalar(speed * dt);
        this.camera.position.add(moveVec);

        this.stepDistanceAccum += moveVec.length();
        this.camera.position.y =
          1.62 + Math.sin(this.stepDistanceAccum * 4.4) * 0.032;

        if (this.stepDistanceAccum > 1.35) {
          this.stepDistanceAccum = 0;
          this.sound.playFootstep(false);
        }
      } else {
        this.camera.position.y += (1.62 - this.camera.position.y) * 0.12;
      }

      this.sound.updateListener(this.camera);
      this.ghostClips.tick(dt);

      const camForward = this.controls.getForwardVector(this.camForward);
      this.world.update(
        dt,
        this.elapsed,
        this.camera.position,
        camForward,
        isMoving,
        this.camera
      );
    }

    if (this.onTitle) this.idleOnTitle();

    // 흑백 셰이더 유니폼 업데이트
    this.monoPass.uniforms['uTime'].value = this.elapsed;
    this.monoPass.uniforms['uDistort'].value = this.world.visualDistort;
    this.monoPass.uniforms['uBrightness'].value = this.world.visualBrightness;

    this.composer.render();
    this.renderDirty = false;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new InescapableHorrorApp();
});
