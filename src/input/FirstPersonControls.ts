import * as THREE from 'three';

/**
 * 데스크톱 + 모바일 통합 입력.
 * - ↑↓ / W S : 전진·후진
 * - ←→ : 제자리에서 방향 전환
 * - A D : 옆걸음
 * - 마우스 : 시점 (화면 클릭 시 포인터 고정, 고정이 안 되면 드래그로 회전)
 * - 모바일 : 왼쪽 조이스틱 이동, 오른쪽 스와이프 시점
 */
export class FirstPersonControls {
  private camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;

  public moveForward = 0; // -1 (뒤) ~ +1 (앞)
  public moveRight = 0;   // -1 (좌) ~ +1 (우)
  /** 방향 전환 입력 -1 (왼쪽) ~ +1 (오른쪽) */
  public turn = 0;
  public isRunning = false;
  public enabled = true;

  private yaw = 0;
  private pitch = 0;
  private keys: Record<string, boolean> = {};
  private isPointerLocked = false;
  private dragging = false;

  // Mobile joystick & touch look state
  private joystickTouchId: number | null = null;
  private joystickOrigin = { x: 0, y: 0 };
  private lookTouchId: number | null = null;
  private lastLookPos = { x: 0, y: 0 };

  private joystickZone: HTMLElement;
  private joystickKnob: HTMLElement;
  private lookZone: HTMLElement;

  private onInteractCallback?: () => void;
  private onPauseCallback?: () => void;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    options: {
      onInteract?: () => void;
      onPause?: () => void;
    } = {}
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.onInteractCallback = options.onInteract;
    this.onPauseCallback = options.onPause;

    this.joystickZone = document.getElementById('joystick-zone')!;
    this.joystickKnob = document.getElementById('joystick-knob')!;
    this.lookZone = document.getElementById('look-zone')!;

    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
  }

  public setOrientation(yaw: number, pitch = 0): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.applyCameraRotation();
  }

  public getYaw(): number {
    return this.yaw;
  }

  public getForwardVector(): THREE.Vector3 {
    const dir = new THREE.Vector3(0, 0, -1);
    dir.applyQuaternion(this.camera.quaternion);
    return dir;
  }

  private applyCameraRotation(): void {
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.x = this.pitch;
    euler.y = this.yaw;
    this.camera.quaternion.setFromEuler(euler);
  }

  public lockPointer(): void {
    if (!('ontouchstart' in window) && this.domElement.requestPointerLock) {
      this.domElement.requestPointerLock();
    }
  }

  public unlockPointer(): void {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      // 화살표 키가 페이지를 스크롤하지 않게
      if (e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.enabled) {
        if (e.code === 'Escape' && this.onPauseCallback) {
          this.onPauseCallback();
        }
        return;
      }

      this.keys[e.code] = true;
      this.updateKeyboardMove();

      if (e.code === 'KeyE' || e.code === 'Space') {
        this.onInteractCallback?.();
      } else if (e.code === 'Escape') {
        this.onPauseCallback?.();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      this.updateKeyboardMove();
    });

    // 창이 포커스를 잃으면 눌린 키를 모두 해제 (키가 눌린 채로 계속 걷는 문제 방지)
    window.addEventListener('blur', () => {
      this.keys = {};
      this.updateKeyboardMove();
    });
  }

  private updateKeyboardMove(): void {
    if (this.joystickTouchId !== null) return; // 터치 중엔 조이스틱 우선

    const f = (this.keys['KeyW'] || this.keys['ArrowUp'] ? 1 : 0) -
              (this.keys['KeyS'] || this.keys['ArrowDown'] ? 1 : 0);
    const r = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    const t = (this.keys['ArrowRight'] ? 1 : 0) - (this.keys['ArrowLeft'] ? 1 : 0);

    this.moveForward = f;
    this.moveRight = r;
    this.turn = t;
    this.isRunning = Boolean(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
  }

  private bindMouse(): void {
    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.domElement;
    });

    // 화면 어디를 클릭해도 포인터 고정 (버튼 등 UI 클릭은 제외)
    window.addEventListener('click', (e) => {
      if (!this.enabled) return;
      if ((e.target as HTMLElement).closest('button, input, label, .modal-screen')) return;
      if (!this.isPointerLocked && !('ontouchstart' in window)) {
        this.lockPointer();
      } else {
        this.onInteractCallback?.();
      }
    });

    // 포인터 고정이 거부된 환경에서도 시점을 돌릴 수 있게 드래그 지원
    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.dragging = true;
    });
    window.addEventListener('mouseup', () => {
      this.dragging = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || (!this.isPointerLocked && !this.dragging)) return;
      const sensitivity = 0.0022;
      this.yaw -= e.movementX * sensitivity;
      this.pitch -= e.movementY * sensitivity;
      const maxPitch = Math.PI / 2 - 0.12;
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
      this.applyCameraRotation();
    });
  }

  /** 매 프레임: 화살표 키 방향 전환 */
  public update(dt: number): void {
    if (!this.enabled || this.turn === 0) return;
    const turnSpeed = 1.9; // rad/s
    this.yaw -= this.turn * turnSpeed * dt;
    this.applyCameraRotation();
  }

  private bindTouch(): void {
    const maxRadius = 42;

    this.joystickZone.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const touch = e.changedTouches[0];
      this.joystickTouchId = touch.identifier;
      const rect = this.joystickZone.getBoundingClientRect();
      this.joystickOrigin = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      this.updateJoystick(touch.clientX, touch.clientY, maxRadius);
    }, { passive: false });

    this.joystickZone.addEventListener('touchmove', (e) => {
      if (!this.enabled || this.joystickTouchId === null) return;
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === this.joystickTouchId) {
          this.updateJoystick(t.clientX, t.clientY, maxRadius);
          break;
        }
      }
    }, { passive: false });

    const endJoystick = (e: TouchEvent) => {
      if (this.joystickTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.joystickTouchId) {
          this.joystickTouchId = null;
          this.moveForward = 0;
          this.moveRight = 0;
          this.isRunning = false;
          this.joystickKnob.style.transform = 'translate(0px, 0px)';
          break;
        }
      }
    };

    this.joystickZone.addEventListener('touchend', endJoystick);
    this.joystickZone.addEventListener('touchcancel', endJoystick);

    // 오른쪽 시점 회전 스와이프
    this.lookZone.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const touch = e.changedTouches[0];
      this.lookTouchId = touch.identifier;
      this.lastLookPos = { x: touch.clientX, y: touch.clientY };
    }, { passive: false });

    this.lookZone.addEventListener('touchmove', (e) => {
      if (!this.enabled || this.lookTouchId === null) return;
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === this.lookTouchId) {
          const dx = t.clientX - this.lastLookPos.x;
          const dy = t.clientY - this.lastLookPos.y;
          this.lastLookPos = { x: t.clientX, y: t.clientY };

          const touchSensitivity = 0.0048;
          this.yaw -= dx * touchSensitivity;
          this.pitch -= dy * touchSensitivity;
          const maxPitch = Math.PI / 2 - 0.12;
          this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
          this.applyCameraRotation();
          break;
        }
      }
    }, { passive: false });

    const endLook = (e: TouchEvent) => {
      if (this.lookTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.lookTouchId) {
          this.lookTouchId = null;
          break;
        }
      }
    };

    this.lookZone.addEventListener('touchend', endLook);
    this.lookZone.addEventListener('touchcancel', endLook);
  }

  private updateJoystick(clientX: number, clientY: number, maxRadius: number): void {
    const dx = clientX - this.joystickOrigin.x;
    const dy = clientY - this.joystickOrigin.y;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, maxRadius);
    const angle = Math.atan2(dy, dx);

    const knobX = Math.cos(angle) * clampedDist;
    const knobY = Math.sin(angle) * clampedDist;
    this.joystickKnob.style.transform = `translate(${knobX.toFixed(1)}px, ${knobY.toFixed(1)}px)`;

    const normX = knobX / maxRadius;
    const normY = knobY / maxRadius;

    this.moveRight = Math.abs(normX) > 0.12 ? normX : 0;
    this.moveForward = Math.abs(normY) > 0.12 ? -normY : 0;
    this.isRunning = dist > maxRadius * 0.92 && this.moveForward > 0.5;
  }
}
