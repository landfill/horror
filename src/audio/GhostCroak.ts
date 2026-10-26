/**
 * "꺼거걱" 하는 목 막힌 소리 (보컬 프라이) 합성.
 *
 * 목이 막힌 채 성대가 아주 느리게 떨리면, 한 번 한 번의 떨림이 따로 들리는
 * "딱딱딱" 소리가 됩니다. 이 맥박(초당 15~50번)이 목과 입의 울림(모음 "어/으")을
 * 때리는 방식으로 만듭니다. 맥박 간격과 세기를 불규칙하게 흔들어야 사람 목처럼 들립니다.
 *
 * Web Audio 노드를 쓰지 않고 숫자 배열로 한 번 계산해 두고 재생합니다.
 * (맥박마다 노드를 만들면 모바일에서 부담이 큼)
 */

/** 한 마디: 맥박이 이어지는 구간 */
interface Phrase {
  /** 길이(초) */
  dur: number;
  /** 시작·끝 맥박 빠르기(초당 횟수) */
  rateFrom: number;
  rateTo: number;
  /** 크기 */
  gain: number;
}

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** 모음 울림 (F1, F2, F3, Hz). 어 → 으 사이를 천천히 오감 */
const EO: [number, number, number] = [620, 1050, 2500];
const EU: [number, number, number] = [380, 1350, 2450];
/** 울림 폭(Hz). 넓을수록 빨리 사그라들어 "딱" 소리가 짧아짐 */
const BW: [number, number, number] = [80, 120, 200];
const F_GAIN: [number, number, number] = [1, 0.6, 0.25];

/** 성대가 열렸다 탁 닫히는 맥박 하나 (약 2.5ms). 끝이 급하게 닫혀야 "딱" 소리가 남 */
const PULSE_MS = 2.5;
function addPulse(x: Float32Array, env: Float32Array, i: number, amp: number, sampleRate: number): void {
  const n = Math.max(3, Math.floor((sampleRate * PULSE_MS) / 1000));
  if (i < 0 || i + n + 2 >= x.length) return;
  // 열리는 동안 천천히 올라가는 공기 흐름의 기울기 → 닫히는 순간 큰 음의 값
  for (let k = 0; k < n; k++) {
    const ph = k / n;
    x[i + k] += amp * 0.25 * Math.sin(Math.PI * ph) * (ph < 0.8 ? 1 : 0.4);
  }
  x[i + n] -= amp;
  x[i + n + 1] -= amp * 0.3;
  // 맥박 뒤 짧은 숨소리 구간 (약 15ms)
  const tail = Math.min(env.length, i + Math.floor(sampleRate * 0.015));
  for (let j = i; j < tail; j++) env[j] = Math.max(env[j], amp * (1 - (j - i) / (tail - i)) + amp * 0.25);
}

/** 마디 구성: "꺼… 거거거걱… 꺼어억" 처럼 2~3마디, 사이에 숨이 걸리듯 끊김 */
function makePhrases(): Phrase[] {
  const n = Math.random() < 0.55 ? 2 : 3;
  const out: Phrase[] = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    out.push({
      dur: last ? rnd(0.7, 1.1) : rnd(0.35, 0.7),
      // 느리게 시작해 빨라지다가, 마지막 마디는 다시 느려지며 끝남
      rateFrom: rnd(16, 24),
      rateTo: last ? rnd(18, 26) : rnd(34, 48),
      gain: last ? 1 : rnd(0.65, 0.9),
    });
  }
  return out;
}

/**
 * 목 막힌 소리를 계산합니다. 반환값은 모노 샘플 배열 (-1~1).
 * @param pitch 높이 배율 (여자·아이는 조금 높게)
 */
export function renderCroak(sampleRate: number, pitch = 1): Float32Array {
  const phrases = makePhrases();
  const gap = () => rnd(0.08, 0.16);
  const total = phrases.reduce((s, p) => s + p.dur, 0) + gap() * phrases.length + 0.25;
  const len = Math.ceil(total * sampleRate);
  const x = new Float32Array(len); // 맥박 + 숨
  const env = new Float32Array(len); // 숨소리 크기용

  // 1. 맥박 열 만들기
  let t = 0.02;
  for (const ph of phrases) {
    const start = t;
    while (t < start + ph.dur) {
      const k = (t - start) / ph.dur;
      const rate = ph.rateFrom + (ph.rateTo - ph.rateFrom) * k;
      // 마디 안 크기: 살짝 부풀었다가 끝에서 줄어듦
      const shape = Math.sin(Math.PI * Math.min(1, k * 1.15)) ** 0.6;
      const amp = ph.gain * shape * rnd(0.55, 1.15);
      const i = Math.floor(t * sampleRate);
      addPulse(x, env, i, amp, sampleRate);
      // 가끔 맥박이 곧바로 한 번 더 걸림 (목이 걸리는 "ㄱㄱ" 느낌)
      if (Math.random() < 0.35) addPulse(x, env, i + Math.floor(sampleRate * rnd(0.003, 0.007)), amp * rnd(0.35, 0.6), sampleRate);
      t += (1 / rate) * rnd(0.75, 1.3);
    }
    t += gap();
  }

  // 2. 숨소리를 섞음: 맥박 직후는 거칠게, 마디 안에서는 낮게 계속 깔림
  for (let i = 0; i < len; i++) x[i] += (Math.random() * 2 - 1) * env[i] * 0.05;

  // 3. 모음 울림 3개 (2극 공명 필터). 모음은 어 ↔ 으 사이를 천천히 오감
  const out = new Float32Array(len);
  const y1 = [0, 0, 0];
  const y2 = [0, 0, 0];
  const r = BW.map((b) => Math.exp((-Math.PI * b) / sampleRate));
  const drift = rnd(0.6, 1.4);
  for (let i = 0; i < len; i++) {
    const m = 0.5 + 0.5 * Math.sin((i / sampleRate) * drift * Math.PI);
    let s = 0;
    for (let f = 0; f < 3; f++) {
      const freq = (EO[f] + (EU[f] - EO[f]) * m) * pitch;
      const a1 = 2 * r[f] * Math.cos((2 * Math.PI * freq) / sampleRate);
      const a2 = -r[f] * r[f];
      const y = x[i] + a1 * y1[f] + a2 * y2[f];
      y2[f] = y1[f];
      y1[f] = y;
      s += y * F_GAIN[f];
    }
    out[i] = s;
  }

  // 4. 크기 맞추기 + 끝 페이드
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
  const norm = peak > 0 ? 0.9 / peak : 1;
  const fade = Math.floor(sampleRate * 0.15);
  for (let i = 0; i < len; i++) {
    const f = i > len - fade ? (len - i) / fade : 1;
    out[i] *= norm * f;
  }
  return out;
}

/** 높이별로 만들어 둘 변형 수 (다 만든 뒤에는 그중에서 골라 씀) */
const CROAK_VARIANTS = 4;
const croakCache = new Map<number, AudioBuffer[]>();
let lastCroak: AudioBuffer | null = null;

/**
 * 재생할 목 막힌 소리 버퍼. 처음 몇 번은 새로 계산하고(약 1~2ms), 그 뒤에는 만들어 둔 것 중
 * 방금 쓴 것을 빼고 골라 씀.
 */
export function croakBuffer(ctx: BaseAudioContext, pitch = 1): AudioBuffer {
  const key = Math.round(pitch * 100);
  let list = croakCache.get(key);
  if (!list) {
    list = [];
    croakCache.set(key, list);
  }
  let buf: AudioBuffer;
  if (list.length < CROAK_VARIANTS) {
    const data = renderCroak(ctx.sampleRate, pitch);
    buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.getChannelData(0).set(data);
    list.push(buf);
  } else {
    const pool = list.filter((b) => b !== lastCroak);
    buf = pool[Math.floor(Math.random() * pool.length)];
  }
  lastCroak = buf;
  return buf;
}
