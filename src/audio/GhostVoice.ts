import type { GhostAge, GhostGender, VoiceKind } from '../ghost/clips';

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
  // 예: 'adult-female': { laugh: ['/voices/adult-female/laugh-1.ogg'] },
};

/** 성별·나이대별 기본 목소리 종류 */
const DEFAULT_KINDS: Record<VoiceGroupId, VoiceKind[]> = {
  'child-female': ['laugh', 'cry'],
  'child-male': ['laugh', 'cry'],
  'adult-female': ['sob', 'cry', 'whisper', 'laugh'],
  'adult-male': ['whisper', 'laugh', 'sob'],
  'elderly-female': ['whisper', 'laugh', 'sob'],
  'elderly-male': ['whisper', 'sob'],
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
  laugh: '웃음소리',
  cry: '울음소리',
  sob: '흐느끼는 소리',
  whisper: '속삭임',
};

export function voiceSubtitle(tag: GhostVoiceTag, kind: VoiceKind): string {
  return `[${WHO[voiceGroupId(tag)]}의 ${KIND_LABEL[kind]}]`;
}

// ---------------------------------------------------------------------------
// 합성 목소리: 녹음 파일이 없을 때 성대 울림(톱니파) + 숨소리(노이즈)를
// 모음 공명(포먼트) 필터에 통과시켜 사람 목소리처럼 만듭니다.
// 성별·나이에 따라 목소리 높이(f0)와 성도 길이(포먼트 배율)가 달라집니다.
// ---------------------------------------------------------------------------

interface VoiceProfile {
  /** 기본 목소리 높이(Hz) */
  f0: number;
  /** 포먼트 배율. 성도가 짧을수록(여자, 아이) 큼 */
  formant: number;
  /** 음높이 떨림 정도 (f0 비율) */
  jitter: number;
  /** 숨소리 비중 0~1 */
  breath: number;
  /** 말 빠르기 배율 (클수록 빠름) */
  tempo: number;
}

const PROFILES: Record<VoiceGroupId, VoiceProfile> = {
  'child-female': { f0: 330, formant: 1.32, jitter: 0.02, breath: 0.25, tempo: 1.25 },
  'child-male': { f0: 300, formant: 1.28, jitter: 0.02, breath: 0.25, tempo: 1.25 },
  'adult-female': { f0: 215, formant: 1.16, jitter: 0.025, breath: 0.35, tempo: 1 },
  'adult-male': { f0: 112, formant: 1.0, jitter: 0.025, breath: 0.3, tempo: 0.95 },
  'elderly-female': { f0: 185, formant: 1.1, jitter: 0.06, breath: 0.55, tempo: 0.8 },
  'elderly-male': { f0: 100, formant: 0.97, jitter: 0.06, breath: 0.55, tempo: 0.8 },
};

type Vowel = 'a' | 'i' | 'u' | 'o';
/** 성인 남성 기준 포먼트 (F1, F2, F3) */
const VOWELS: Record<Vowel, [number, number, number]> = {
  a: [730, 1090, 2440],
  i: [300, 2200, 2950],
  u: [320, 870, 2240],
  o: [500, 900, 2400],
};

/** 한 음절(소리 덩어리) */
interface Syllable {
  /** 시작 시각(초, 소리 전체 시작 기준) */
  at: number;
  dur: number;
  vowel: Vowel;
  /** 시작·끝 음높이 (f0 배율) */
  pitchFrom: number;
  pitchTo: number;
  /** 성대 울림 0~1 (0이면 속삭임·숨) */
  voiced: number;
  /** 숨소리 0~1 */
  breath: number;
  /** 최대 크기 */
  peak: number;
  /** 비브라토(울먹임) 깊이 (f0 비율) */
  vibrato?: number;
}

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function laughSyllables(p: VoiceProfile): Syllable[] {
  const n = Math.floor(rnd(5, 8));
  const step = 0.19 / p.tempo;
  const out: Syllable[] = [];
  let pitch = rnd(1.35, 1.55);
  for (let i = 0; i < n; i++) {
    out.push({
      at: Math.max(0, i * step + rnd(-0.015, 0.015)),
      dur: 0.12 / p.tempo,
      vowel: i % 3 === 2 ? 'i' : 'a',
      pitchFrom: pitch,
      pitchTo: pitch * 0.88,
      voiced: 1,
      breath: 0.5,
      peak: 0.9 - i * 0.06,
    });
    pitch *= 0.95;
  }
  // 끝에 숨 들이쉬기
  out.push({ at: n * step + 0.05, dur: 0.35, vowel: 'i', pitchFrom: 1, pitchTo: 1, voiced: 0, breath: 1, peak: 0.35 });
  return out;
}

function crySyllables(p: VoiceProfile): Syllable[] {
  const long = rnd(1.4, 1.9) / p.tempo;
  return [
    { at: 0, dur: long, vowel: 'a', pitchFrom: 1.45, pitchTo: 0.85, voiced: 1, breath: 0.45, peak: 0.85, vibrato: 0.045 },
    { at: long + 0.12, dur: 0.3, vowel: 'i', pitchFrom: 1, pitchTo: 1, voiced: 0, breath: 1, peak: 0.35 },
    { at: long + 0.5, dur: long * 0.6, vowel: 'o', pitchFrom: 1.3, pitchTo: 0.8, voiced: 1, breath: 0.5, peak: 0.7, vibrato: 0.05 },
  ];
}

function sobSyllables(p: VoiceProfile): Syllable[] {
  const out: Syllable[] = [];
  let t = 0;
  const cycles = 3;
  for (let c = 0; c < cycles; c++) {
    // 떨리는 들숨 두세 번
    const catches = Math.floor(rnd(2, 4));
    for (let k = 0; k < catches; k++) {
      out.push({ at: t, dur: 0.09, vowel: 'i', pitchFrom: 1.6, pitchTo: 1.5, voiced: 0.15, breath: 1, peak: 0.45 });
      t += 0.13 / p.tempo;
    }
    // 울먹이는 "으흐흑"
    out.push({ at: t, dur: 0.42 / p.tempo, vowel: 'u', pitchFrom: 1.25, pitchTo: 0.9, voiced: 1, breath: 0.6, peak: 0.75, vibrato: 0.06 });
    t += 0.42 / p.tempo + rnd(0.25, 0.4);
  }
  return out;
}

function whisperSyllables(p: VoiceProfile): Syllable[] {
  const vowels: Vowel[] = ['a', 'i', 'u', 'o'];
  const n = Math.floor(rnd(5, 8));
  const out: Syllable[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const dur = rnd(0.14, 0.26) / p.tempo;
    out.push({ at: t, dur, vowel: vowels[Math.floor(Math.random() * vowels.length)], pitchFrom: 1, pitchTo: 1, voiced: 0, breath: 1, peak: 0.9 });
    t += dur + rnd(0.04, 0.12);
  }
  return out;
}

const SYLLABLES: Record<VoiceKind, (p: VoiceProfile) => Syllable[]> = {
  laugh: laughSyllables,
  cry: crySyllables,
  sob: sobSyllables,
  whisper: whisperSyllables,
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
  const syl = SYLLABLES[kind](p);
  const f0 = p.f0 * rnd(0.95, 1.05);

  // 모든 음절이 지나가는 공통 출력 (크기 맞춤 + 귀신답게 살짝 어둡게)
  const out = ctx.createGain();
  out.gain.value = 0.55 * volume;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 5200;
  out.connect(tone);
  tone.connect(dest);

  let end = 0;
  for (const s of syl) {
    const t0 = when + s.at;
    const t1 = t0 + s.dur;
    end = Math.max(end, s.at + s.dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(s.peak, t0 + Math.min(0.03, s.dur * 0.3));
    env.gain.setValueAtTime(s.peak, Math.max(t0 + 0.03, t1 - s.dur * 0.35));
    env.gain.exponentialRampToValueAtTime(0.0001, t1);
    env.connect(out);

    // 모음 공명 (포먼트 3개 병렬)
    const fm = VOWELS[s.vowel];
    const bank = ctx.createGain();
    const fGains = [1, 0.55, 0.28];
    fm.forEach((f, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * p.formant;
      bp.Q.value = [7, 10, 14][i];
      const g = ctx.createGain();
      g.gain.value = fGains[i] * 4;
      bank.connect(bp);
      bp.connect(g);
      g.connect(env);
    });

    // 성대 울림
    if (s.voiced > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0 * s.pitchFrom, t0);
      osc.frequency.exponentialRampToValueAtTime(f0 * s.pitchTo, t1);
      // 떨림(노화·울먹임)
      const lfo = ctx.createOscillator();
      lfo.frequency.value = s.vibrato ? 5.5 : 9 + Math.random() * 3;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = f0 * (s.vibrato ?? p.jitter);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      const vg = ctx.createGain();
      vg.gain.value = s.voiced * 0.6;
      osc.connect(vg);
      vg.connect(bank);
      osc.start(t0);
      lfo.start(t0);
      osc.stop(t1 + 0.02);
      lfo.stop(t1 + 0.02);
    }

    // 숨소리
    const breath = Math.min(1, s.breath * (s.voiced > 0 ? p.breath * 2 : 1));
    if (breath > 0) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      const ng = ctx.createGain();
      ng.gain.value = breath * (s.voiced > 0 ? 0.5 : 0.6);
      n.connect(ng);
      ng.connect(bank);
      n.start(t0, Math.random());
      n.stop(t1 + 0.02);
    }
  }
  return end;
}
