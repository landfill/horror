import type { GhostAge, GhostGender, VoiceKind } from '../ghost/clips';
import { croakBuffer } from './GhostCroak';

/** 귀신 한 명의 목소리 정보 (clips.ts의 성별·나이 태그에서 만듦) */
export interface GhostVoiceTag {
  gender: GhostGender;
  age: GhostAge;
  /** 어울리는 목소리 종류. 비어 있으면 그 성별·나이대의 기본 목록을 씀 */
  kinds?: VoiceKind[];
}

export type VoiceGroupId = `${GhostAge}-${GhostGender}`;

export function voiceGroupId(tag: GhostVoiceTag): VoiceGroupId {
  return `${tag.age}-${tag.gender}`;
}

/**
 * 실제 녹음 파일 목록. public/voices/<그룹>/ 아래에 넣고 여기에 경로를 적으면
 * 합성 목소리 대신 그 파일을 씁니다 (같은 종류가 여러 개면 무작위).
 * 넣을 수 있는 파일과 출처 기록 방법은 public/voices/README.md 참고.
 */
export const VOICE_FILES: Partial<Record<VoiceGroupId, Partial<Record<VoiceKind, string[]>>>> = {
  'adult-female': {
    giggle: ['/voices/adult-female/giggle-1.m4a', '/voices/adult-female/giggle-2.m4a', '/voices/adult-female/giggle-3.m4a'],
    sob: ['/voices/adult-female/sob-1.m4a', '/voices/adult-female/sob-2.m4a', '/voices/adult-female/sob-3.m4a'],
  },
  'child-male': {
    giggle: ['/voices/child-male/giggle-1.m4a', '/voices/child-male/giggle-2.m4a', '/voices/child-male/giggle-3.m4a'],
  },
};

/** 성별·나이대별 기본 목소리 종류 */
const DEFAULT_KINDS: Record<VoiceGroupId, VoiceKind[]> = {
  'child-female': ['giggle'],
  'child-male': ['giggle'],
  'adult-female': ['sob', 'giggle'],
  'adult-male': ['sob'],
  'elderly-female': ['sob', 'giggle'],
  'elderly-male': ['sob'],
};

export function pickVoiceKind(tag: GhostVoiceTag): VoiceKind {
  const list = tag.kinds && tag.kinds.length > 0 ? tag.kinds : DEFAULT_KINDS[voiceGroupId(tag)];
  return list[Math.floor(Math.random() * list.length)];
}

const WHO: Record<VoiceGroupId, string> = {
  'child-female': '여자아이',
  'child-male': '남자아이',
  'adult-female': '여자',
  'adult-male': '남자',
  'elderly-female': '노파',
  'elderly-male': '노인',
};
const KIND_LABEL: Record<VoiceKind, string> = {
  giggle: '키득거리는 웃음',
  sob: '흐느끼는 소리',
  croak: '목 막힌 소리',
};

export function voiceSubtitle(tag: GhostVoiceTag, kind: VoiceKind): string {
  if (kind === 'croak') return CROAK_SUBTITLE;
  return `[${WHO[voiceGroupId(tag)]}의 ${KIND_LABEL[kind]}]`;
}

/** 목 막힌 소리 자막 (누구 소리인지 밝히지 않음) */
export const CROAK_SUBTITLE = '[목에서 꺼거걱 하는 소리]';

// ---------------------------------------------------------------------------
// 합성 목소리: 녹음 파일이 없거나 아직 받는 중일 때 씁니다.
// 숨소리(노이즈)를 중심으로 두고 성대 울림은 살짝만 섞어 "흐흐흐", "흐윽" 같은
// 작은 소리를 만듭니다. 성대 울림이 크거나 떨림이 규칙적이면 기계음처럼 들리므로
// 음 높이는 불규칙한 저주파 노이즈로 흔들고, 소리 시작과 끝은 부드럽게 둡니다.
// ---------------------------------------------------------------------------

interface VoiceProfile {
  /** 기본 목소리 높이(Hz) */
  f0: number;
  /** 포먼트 배율. 성도가 짧을수록(여자, 아이) 큼 */
  formant: number;
  /** 음높이 흔들림 정도 (f0 비율) */
  jitter: number;
  /** 빠르기 배율 (클수록 빠름) */
  tempo: number;
}

const PROFILES: Record<VoiceGroupId, VoiceProfile> = {
  'child-female': { f0: 340, formant: 1.3, jitter: 0.03, tempo: 1.2 },
  'child-male': { f0: 310, formant: 1.26, jitter: 0.03, tempo: 1.2 },
  'adult-female': { f0: 230, formant: 1.15, jitter: 0.035, tempo: 1 },
  'adult-male': { f0: 120, formant: 1.0, jitter: 0.035, tempo: 0.95 },
  'elderly-female': { f0: 200, formant: 1.1, jitter: 0.06, tempo: 0.85 },
  'elderly-male': { f0: 105, formant: 0.97, jitter: 0.06, tempo: 0.85 },
};

type Vowel = 'a' | 'i' | 'u' | 'o' | 'eu';
/** 성인 남성 기준 포먼트 (F1, F2, F3). eu = "으" */
const VOWELS: Record<Vowel, [number, number, number]> = {
  a: [730, 1090, 2440],
  i: [300, 2200, 2950],
  u: [320, 870, 2240],
  o: [500, 900, 2400],
  eu: [350, 1400, 2500],
};

/** 한 소리 덩어리 */
interface Syllable {
  /** 시작 시각(초, 소리 전체 시작 기준) */
  at: number;
  dur: number;
  vowel: Vowel;
  /** 끝날 때 모음 (없으면 그대로) */
  vowelTo?: Vowel;
  /** 시작·끝 음높이 (f0 배율) */
  pitchFrom: number;
  pitchTo: number;
  /** 성대 울림 0~1. 작을수록 숨소리만 남음 */
  voiced: number;
  /** 최대 크기 */
  peak: number;
  /** 소리가 올라오는 시간(초) */
  attack: number;
}

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** 키득거림: 코와 목으로 새는 짧은 "흐흐흐", 점점 작아짐. 간격은 조금씩 불규칙 */
function giggleSyllables(p: VoiceProfile): Syllable[] {
  const n = Math.floor(rnd(4, 7));
  const out: Syllable[] = [];
  let t = 0;
  let pitch = rnd(1.15, 1.3);
  for (let i = 0; i < n; i++) {
    const dur = rnd(0.07, 0.11) / p.tempo;
    // 첫 소리는 조금 작게 시작했다가 커지고 점점 사그라듦
    const peak = (i === 0 ? 0.65 : 1 - (i / n) * 0.55) * rnd(0.85, 1);
    out.push({
      at: t,
      dur,
      vowel: Math.random() < 0.6 ? 'eu' : 'i',
      pitchFrom: pitch * rnd(0.97, 1.03),
      pitchTo: pitch * 0.9,
      voiced: rnd(0.18, 0.3),
      peak,
      attack: 0.012,
    });
    pitch *= rnd(0.95, 0.99);
    t += dur + rnd(0.05, 0.09) / p.tempo + i * 0.008;
  }
  // 끝에 코로 짧게 내쉬는 숨
  out.push({ at: t + 0.04, dur: 0.22, vowel: 'u', pitchFrom: 1, pitchTo: 1, voiced: 0, peak: 0.35, attack: 0.03 });
  return out;
}

/** 흐느낌: 떨리며 들이쉬는 숨 몇 번 → 울먹이며 "흐으…" 내쉼. 두 번째는 더 작게 */
function sobSyllables(p: VoiceProfile): Syllable[] {
  const out: Syllable[] = [];
  let t = 0;
  const cycles = Math.random() < 0.5 ? 1 : 2;
  for (let c = 0; c < cycles; c++) {
    const level = c === 0 ? 1 : 0.6;
    // 떨리는 들숨 ("흑, 흑, 흑")
    const catches = Math.floor(rnd(2, 5));
    for (let k = 0; k < catches; k++) {
      const dur = rnd(0.05, 0.08);
      out.push({
        at: t,
        dur,
        vowel: 'i',
        pitchFrom: 1.5,
        pitchTo: 1.55,
        voiced: 0.08,
        peak: (0.45 + k * 0.12) * level,
        attack: 0.01,
      });
      t += dur + rnd(0.05, 0.11) / p.tempo;
    }
    t += rnd(0.04, 0.1);
    // 울먹이며 내쉬는 "흐으…"
    const dur = rnd(0.55, 0.9) / p.tempo;
    out.push({
      at: t,
      dur,
      vowel: 'eu',
      vowelTo: 'u',
      pitchFrom: rnd(1.2, 1.35),
      pitchTo: rnd(0.85, 0.95),
      voiced: rnd(0.3, 0.42),
      peak: 0.75 * level,
      attack: 0.06,
    });
    t += dur + rnd(0.3, 0.55);
  }
  return out;
}

const SYLLABLES: Record<Exclude<VoiceKind, 'croak'>, (p: VoiceProfile) => Syllable[]> = {
  giggle: giggleSyllables,
  sob: sobSyllables,
};

let noiseCache: { ctx: BaseAudioContext; buf: AudioBuffer } | null = null;
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noiseCache && noiseCache.ctx === ctx) return noiseCache.buf;
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noiseCache = { ctx, buf };
  return buf;
}

/**
 * 합성 목소리를 재생합니다. 반환값은 소리 길이(초).
 * @param volume 전체 크기 배율
 */
export function synthGhostVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  tag: GhostVoiceTag,
  kind: VoiceKind,
  when = ctx.currentTime,
  volume = 1,
): number {
  const p = PROFILES[voiceGroupId(tag)];
  if (kind === 'croak') {
    // 목 막힌 소리는 따로 계산해 둔 버퍼를 씀. 성도가 짧을수록(여자, 아이) 울림이 높음
    const src = ctx.createBufferSource();
    src.buffer = croakBuffer(ctx, p.formant);
    const g = ctx.createGain();
    g.gain.value = 0.9 * volume;
    src.connect(g);
    g.connect(dest);
    src.start(when);
    return src.buffer.duration;
  }
  const syl = SYLLABLES[kind](p);
  const f0 = p.f0 * rnd(0.94, 1.06);
  const noise = noiseBuffer(ctx);

  // 공통 출력: 낮은 웅웅거림과 날카로운 고음을 깎아 부드럽게
  const out = ctx.createGain();
  out.gain.value = 0.9 * volume;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 140;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4200;
  lp.Q.value = 0.5;
  out.connect(hp);
  hp.connect(lp);
  lp.connect(dest);

  let end = 0;
  for (const s of syl) {
    const t0 = when + s.at;
    const t1 = t0 + s.dur;
    end = Math.max(end, s.at + s.dur);

    // 부드럽게 올라왔다가 자연스럽게 사그라드는 크기
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.setTargetAtTime(s.peak, t0, s.attack / 3);
    env.gain.setTargetAtTime(0, t0 + s.dur * 0.55, s.dur * 0.18);
    env.connect(out);

    // 모음 공명 (포먼트 3개 병렬). Q를 낮게 두어 휘파람 같은 울림을 막음
    const from = VOWELS[s.vowel];
    const to = VOWELS[s.vowelTo ?? s.vowel];
    const bank = ctx.createGain();
    const fGains = [1.6, 1.0, 0.5];
    const qs = [4, 6, 8];
    for (let i = 0; i < 3; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(from[i] * p.formant, t0);
      if (to !== from) bp.frequency.linearRampToValueAtTime(to[i] * p.formant, t1);
      bp.Q.value = qs[i];
      const g = ctx.createGain();
      g.gain.value = fGains[i];
      bank.connect(bp);
      bp.connect(g);
      g.connect(env);
    }

    // 숨소리 (중심)
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const ng = ctx.createGain();
    ng.gain.value = 1 - s.voiced * 0.5;
    n.connect(ng);
    ng.connect(bank);
    n.start(t0, Math.random() * 3);
    n.stop(t1 + 0.3);

    // 성대 울림 (살짝만). 톱니파를 한 번 걸러 버저처럼 들리지 않게 함
    if (s.voiced > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0 * s.pitchFrom, t0);
      osc.frequency.exponentialRampToValueAtTime(f0 * s.pitchTo, t1);
      // 불규칙한 음높이 흔들림: 아주 느린 노이즈로 주파수를 흔듦 (사인파 떨림은 기계음처럼 들림)
      const wob = ctx.createBufferSource();
      wob.buffer = noise;
      const wobLp = ctx.createBiquadFilter();
      wobLp.type = 'lowpass';
      wobLp.frequency.value = 12;
      const wobGain = ctx.createGain();
      // 12Hz로 거른 노이즈는 크기가 아주 작아져서 크게 키움
      wobGain.gain.value = f0 * p.jitter * 40;
      wob.connect(wobLp);
      wobLp.connect(wobGain);
      wobGain.connect(osc.frequency);
      const soft = ctx.createBiquadFilter();
      soft.type = 'lowpass';
      soft.frequency.value = f0 * 6;
      const vg = ctx.createGain();
      vg.gain.value = s.voiced * 0.9;
      osc.connect(soft);
      soft.connect(vg);
      vg.connect(bank);
      osc.start(t0);
      wob.start(t0, Math.random() * 3);
      osc.stop(t1 + 0.3);
      wob.stop(t1 + 0.3);
    }
  }
  return end + 0.3;
}
