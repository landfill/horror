import * as THREE from 'three';
import { GhostVoiceTag, VOICE_FILES, pickVoiceKind, synthGhostVoice, voiceGroupId, voiceSubtitle } from './GhostVoice';

export interface SpatialPos {
  x: number;
  y: number;
  z: number;
}

/**
 * Web Audio API 기반 절차적(Procedural) 호러 사운드 엔진.
 * 외부 오디오 파일 없이도 끼익거림, 목 딸깍임, 분필 긁기, 형광등 험,
 * 젖은 발소리, 비명, 장구/방울 소리 등을 합성하고 HRTF 3D 공간 음향으로 배치합니다.
 */
export class SoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  /** 모든 효과음이 지나가는 버스. 원음 + 공간 잔향으로 나뉨 */
  private fxBus: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private humOsc1: OscillatorNode | null = null;
  private humOsc2: OscillatorNode | null = null;
  private droneOsc: OscillatorNode | null = null;
  private isMuted = false;
  private isHumCut = false;
  private subtitleCallback?: (text: string, reversed?: boolean) => void;
  /** 귀신 목소리 녹음 파일 (경로 → 디코딩된 소리). 못 불러온 파일은 null */
  private voiceBuffers = new Map<string, AudioBuffer | null>();

  public setSubtitleHandler(cb: (text: string, reversed?: boolean) => void): void {
    this.subtitleCallback = cb;
  }

  private emitSubtitle(text: string, reversed = false): void {
    if (this.subtitleCallback) {
      this.subtitleCallback(text, reversed);
    }
  }

  public init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;
    this.masterGain.connect(this.ctx.destination);

    this.setupReverb();
    this.startAmbientHum();
    this.loadVoiceFiles();
  }

  /** VOICE_FILES에 적힌 녹음 파일을 미리 받아 둠 (실패하면 합성 목소리를 씀) */
  private loadVoiceFiles(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const group of Object.values(VOICE_FILES)) {
      for (const list of Object.values(group ?? {})) {
        for (const url of list ?? []) {
          if (this.voiceBuffers.has(url)) continue;
          this.voiceBuffers.set(url, null);
          fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
            .then((data) => ctx.decodeAudioData(data))
            .then((buf) => this.voiceBuffers.set(url, buf))
            .catch(() => console.warn(`[voice] 불러오지 못함: ${url}`));
        }
      }
    }
  }

  public resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setVolume(val0to1: number): void {
    if (!this.masterGain || !this.ctx) return;
    this.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1, val0to1)), this.ctx.currentTime, 0.05);
  }

  public pauseAll(pause: boolean): void {
    if (!this.ctx) return;
    this.isMuted = pause;
    if (pause) {
      this.ctx.suspend();
    } else {
      this.ctx.resume();
    }
  }

  /**
   * 3D 리스너 위치/방향을 Three.js 카메라와 동기화
   */
  public updateListener(camera: THREE.Camera): void {
    if (!this.ctx) return;
    const listener = this.ctx.listener;
    const pos = camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

    if (listener.positionX) {
      const t = this.ctx.currentTime;
      listener.positionX.setValueAtTime(pos.x, t);
      listener.positionY.setValueAtTime(pos.y, t);
      listener.positionZ.setValueAtTime(pos.z, t);
      listener.forwardX.setValueAtTime(forward.x, t);
      listener.forwardY.setValueAtTime(forward.y, t);
      listener.forwardZ.setValueAtTime(forward.z, t);
      listener.upX.setValueAtTime(up.x, t);
      listener.upY.setValueAtTime(up.y, t);
      listener.upZ.setValueAtTime(up.z, t);
    } else {
      listener.setPosition(pos.x, pos.y, pos.z);
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /**
   * 콘크리트 복도 잔향. 실제 녹음된 공간 응답(IR)이 없으므로
   * 감쇠하는 노이즈로 IR을 만들어 씁니다. 나중에 실제 복도에서 녹음한 IR로 교체 가능.
   */
  private setupReverb(): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const seconds = 2.6;
    const len = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // 앞부분은 비워 두어(약 12ms) 벽에서 돌아오는 느낌을 줌
        const pre = i < ctx.sampleRate * 0.012 ? 0 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * pre;
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = ir;

    // 잔향은 고음을 깎아 어둡게
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 3200;

    const wet = ctx.createGain();
    wet.gain.value = 0.45;

    this.fxBus = ctx.createGain();
    this.fxBus.connect(this.masterGain);
    this.fxBus.connect(damp);
    damp.connect(convolver);
    convolver.connect(wet);
    wet.connect(this.masterGain);
  }

  /**
   * far = true면 멀리서도 들리게 거리 감쇠를 약하게 함 (복도 끝 18m에서도 절반 크기쯤).
   * 귀신이 있는 구역 어디서든 그 귀신의 목소리가 들리게 할 때 씀.
   */
  private createPanner(pos?: SpatialPos, far = false): AudioNode {
    if (!this.ctx || !this.masterGain) {
      throw new Error('SoundManager not initialized');
    }
    const bus = this.fxBus ?? this.masterGain;
    if (!pos) return bus;

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = far ? 6 : 1.5;
    panner.maxDistance = far ? 60 : 30;
    panner.rolloffFactor = far ? 0.5 : 1.4;
    panner.positionX.setValueAtTime(pos.x, this.ctx.currentTime);
    panner.positionY.setValueAtTime(pos.y, this.ctx.currentTime);
    panner.positionZ.setValueAtTime(pos.z, this.ctx.currentTime);
    panner.connect(bus);
    return panner;
  }

  /**
   * 형광등 60Hz/120Hz 험 + 저주파 리미널 드론
   */
  private startAmbientHum(): void {
    if (!this.ctx || !this.masterGain) return;

    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0.08;
    this.ambientGain.connect(this.masterGain);

    this.humOsc1 = this.ctx.createOscillator();
    this.humOsc1.type = 'sawtooth';
    this.humOsc1.frequency.value = 60;

    this.humOsc2 = this.ctx.createOscillator();
    this.humOsc2.type = 'triangle';
    this.humOsc2.frequency.value = 120;

    this.droneOsc = this.ctx.createOscillator();
    this.droneOsc.type = 'sine';
    this.droneOsc.frequency.value = 39;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 210;

    this.humOsc1.connect(filter);
    this.humOsc2.connect(filter);
    this.droneOsc.connect(filter);
    filter.connect(this.ambientGain);

    this.humOsc1.start();
    this.humOsc2.start();
    this.droneOsc.start();
  }

  /**
   * 정적 연출: 형광등 소리가 갑자기 뚝 끊김
   */
  public setSilenceCut(cut: boolean): void {
    if (!this.ctx || !this.ambientGain) return;
    this.isHumCut = cut;
    const target = cut ? 0.0001 : 0.08;
    this.ambientGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.04);
    // 정적은 자막으로 알리지 않음 (설명하는 순간 정적의 효과가 사라짐)
  }

  /**
   * 발소리 (일반 바닥 vs 젖은 맨발 소리)
   */
  public playFootstep(wet = false, pos?: SpatialPos): void {
    if (!this.ctx || this.isMuted) return;
    const now = this.ctx.currentTime;
    const dest = this.createPanner(pos);

    // 노이즈 버스트 생성
    const bufferSize = this.ctx.sampleRate * 0.09;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.35));
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = wet ? 'bandpass' : 'lowpass';
    filter.frequency.value = wet ? 950 + Math.random() * 350 : 240 + Math.random() * 60;
    filter.Q.value = wet ? 3.5 : 1.0;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(wet ? 0.26 : 0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    noise.start(now);
  }

  /**
   * 끼익거리는 소리 (문, 의자 끌기, 녹슨 경첩)
   */
  public playCreak(pos?: SpatialPos, label = '[문이 끼익거림]'): void {
    if (!this.ctx || this.isMuted) return;
    const now = this.ctx.currentTime;
    const dest = this.createPanner(pos);
    this.emitSubtitle(label);

    const dur = 0.85 + Math.random() * 0.6;
    const carrier = this.ctx.createOscillator();
    const mod = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    const baseFreq = 290 + Math.random() * 190;
    carrier.type = 'sawtooth';
    carrier.frequency.setValueAtTime(baseFreq, now);
    carrier.frequency.linearRampToValueAtTime(baseFreq * 0.62, now + dur * 0.5);
    carrier.frequency.linearRampToValueAtTime(baseFreq * 1.18, now + dur);

    mod.type = 'sine';
    mod.frequency.setValueAtTime(18 + Math.random() * 12, now);
    modGain.gain.setValueAtTime(65, now);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(780, now);
    filter.Q.value = 6;

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(filter);
    filter.connect(gain);
    gain.connect(dest);

    carrier.start(now);
    mod.start(now);
    carrier.stop(now + dur);
    mod.stop(now + dur);
  }

  /**
   * 주온 스타일 목에서 나는 "으으으… 딸깍딸깍" 래틀 소리
   */
  public playDeathRattle(pos?: SpatialPos, far = false): void {
    if (!this.ctx || this.isMuted) return;
    const now = this.ctx.currentTime;
    const dest = this.createPanner(pos, far);
    this.emitSubtitle('[목에서 긁히는 소리]');

    const clicks = 14;
    for (let i = 0; i < clicks; i++) {
      const t = now + i * (0.055 + (i % 3) * 0.018);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(95 + (i % 4) * 28, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.035);

      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + 0.042);
    }
  }

  /**
   * 귀신 목소리 (성별·나이대에 맞는 키득거리는 웃음 / 흐느낌).
   * volume: 크기 배율 (멀리서 들리는 목소리는 작게)
   * 녹음 파일이 있으면 그것을, 없으면 합성 목소리를 냅니다.
   * 목소리 정보가 없는 귀신은 목 긁는 소리로 대신합니다.
   */
  public playGhostVoice(tag: GhostVoiceTag | undefined, pos?: SpatialPos, far = false, volume = 1): void {
    if (!this.ctx || this.isMuted) return;
    if (!tag) {
      this.playDeathRattle(pos, far);
      return;
    }
    const kind = pickVoiceKind(tag);
    const dest = this.createPanner(pos, far);
    this.emitSubtitle(voiceSubtitle(tag, kind));

    const files = (VOICE_FILES[voiceGroupId(tag)]?.[kind] ?? [])
      .map((url) => this.voiceBuffers.get(url))
      .filter((b): b is AudioBuffer => !!b);
    if (files.length > 0) {
      const src = this.ctx.createBufferSource();
      src.buffer = files[Math.floor(Math.random() * files.length)];
      // 매번 조금씩 다르게 들리도록 높이를 살짝 흔듦
      src.playbackRate.value = 0.94 + Math.random() * 0.1;
      const g = this.ctx.createGain();
      g.gain.value = volume;
      src.connect(g);
      g.connect(dest);
      src.start();
      return;
    }
    synthGhostVoice(this.ctx, dest, tag, kind, this.ctx.currentTime, volume);
  }

  /**
   * 칠판 분필/손톱 긁는 소름끼치는 소리
   */
  public playChalkScrape(pos?: SpatialPos): void {
    if (!this.ctx || this.isMuted) return;
    const now = this.ctx.currentTime;
    const dest = this.createPanner(pos);
    this.emitSubtitle('[긁는 소리]');

    const dur = 1.1;
    const bufferSize = Math.floor(this.ctx.sampleRate * dur);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (0.5 + 0.5 * Math.sin(i * 0.03));
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2600, now);
    filter.frequency.linearRampToValueAtTime(3400, now + dur);
    filter.Q.value = 12;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    noise.start(now);
  }

  /**
   * 기분 나쁜 속삭임 / 여자 콧노래 / 왜곡된 부름
   */
  public playEerieHumOrWhisper(pos?: SpatialPos, label = '[낮은 흥얼거림]', reversed = false): void {
    if (!this.ctx || this.isMuted) return;
    const now = this.ctx.currentTime;
    const dest = this.createPanner(pos);
    this.emitSubtitle(label, reversed);

    const notes = [311.13, 293.66, 261.63, 246.94]; // D#4, D4, C4, B3 불협 하강
    notes.forEach((freq, idx) => {
      if (!this.ctx) return;
      const t = now + idx * 0.42;
      const osc = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);

      lfo.frequency.value = 5.5;
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.14, t + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + 0.42);
      lfo.stop(t + 0.42);
    });
  }

  /**
   * 무속 방울 / 장구 타격음 (4층 굿 연출용)
   */
  public playShamanBell(pos?: SpatialPos): void {
    if (!this.ctx || this.isMuted) return;
    const now = this.ctx.currentTime;
    const dest = this.createPanner(pos);
    this.emitSubtitle('[방울 소리]');

    const freqs = [1760, 2349, 3135, 4186];
    freqs.forEach((f, i) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f + Math.random() * 40, now + i * 0.03);
      gain.gain.setValueAtTime(0.11, now + i * 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35 + i * 0.03);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(now + i * 0.03);
      osc.stop(now + 0.38 + i * 0.03);
    });
  }

  /**
   * VHS 화이트노이즈 버스트 (B1 비디오 대여점 & 루프 리셋 연출)
   */
  public playVhsStatic(duration = 0.45): void {
    if (!this.ctx || !this.masterGain || this.isMuted) return;
    const now = this.ctx.currentTime;
    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.6;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(now);
  }

  /**
   * 점프스케어 / 비명 사운드 (층당 최대 1회, 불협화음 + 포먼트 변조 노이즈)
   */
  public playScream(): void {
    if (!this.ctx || !this.masterGain || this.isMuted) return;
    const now = this.ctx.currentTime;
    this.emitSubtitle('[비명]');

    const dur = 1.15;
    const freqs = [587, 830, 1174, 1567];
    freqs.forEach((f) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, now);
      osc.frequency.exponentialRampToValueAtTime(f * 1.35, now + 0.18);
      osc.frequency.exponentialRampToValueAtTime(f * 0.72, now + dur);

      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + dur);
    });

    this.playVhsStatic(dur);

    if ('vibrate' in navigator) {
      try {
        navigator.vibrate([180, 60, 280]);
      } catch {
        // Ignore on unsupported browsers
      }
    }
  }
}
