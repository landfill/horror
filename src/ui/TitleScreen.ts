/**
 * 첫 화면의 작은 연출.
 * - 04:44 시계가 아주 가끔 한순간 04:45가 됐다가 돌아옴
 * - 아래 한 줄이 영·일·한 문장 사이를 천천히 바뀌어 감 (복도에서 실제로 겪게 될 일들의 예고)
 * - 두 번째 방문부터는 "여기 와 본 적 있죠" 류의 문장으로 시작
 * 피, 비명, 큰 글리치는 쓰지 않습니다.
 */

type Lang = 'en' | 'ja' | 'ko';
interface Line {
  lang: Lang;
  text: string;
}

const WHISPERS: Line[] = [
  { lang: 'en', text: 'The lights were already on when you came in.' },
  { lang: 'ja', text: 'さっきの扉、閉めてきましたか。' },
  { lang: 'ko', text: '아무도 없는데, 의자가 벽을 보고 있습니다.' },
  { lang: 'en', text: 'Do not count the doors.' },
  { lang: 'ja', text: '靴が、きちんと揃えてありました。' },
  { lang: 'ko', text: '이 복도는 아까보다 조금 깁니다.' },
  { lang: 'en', text: 'Someone left the television on.' },
  { lang: 'ja', text: '同じ廊下を、もう一度歩いています。' },
  { lang: 'ko', text: '방금 지나온 문, 닫고 왔나요?' },
];

const RETURN_LINES: Line[] = [
  { lang: 'en', text: 'You have been here before.' },
  { lang: 'ja', text: '前にも、ここに来ましたね。' },
  { lang: 'ko', text: '여기, 와 본 적 있죠.' },
];

const VISITS_KEY = 'no-4th-floor.visits';
const WHISPER_HOLD_MS = 7000;
const WHISPER_FADE_MS = 2200;

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** 방문 횟수를 하나 올리고 이전 값을 돌려줌. 저장소를 못 쓰면 0. */
function bumpVisits(): number {
  try {
    const prev = Number(localStorage.getItem(VISITS_KEY)) || 0;
    localStorage.setItem(VISITS_KEY, String(prev + 1));
    return prev;
  } catch {
    return 0;
  }
}

export class TitleScreen {
  private clockEl = document.getElementById('title-clock');
  private whisperEl = document.getElementById('title-whisper');
  private timers: number[] = [];
  private running = false;
  private order: Line[] = [];
  private index = 0;

  public start(): void {
    if (this.running) return;
    this.running = true;

    const previousVisits = bumpVisits();
    const offset = Math.floor(Math.random() * WHISPERS.length);
    this.order = WHISPERS.map((_, k) => WHISPERS[(k + offset) % WHISPERS.length]);
    if (previousVisits > 0) {
      this.order.unshift(RETURN_LINES[Math.floor(Math.random() * RETURN_LINES.length)]);
    }
    this.index = 0;

    this.later(() => this.showWhisper(), 2600);
    this.scheduleClock();
  }

  public stop(): void {
    this.running = false;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
  }

  private later(fn: () => void, ms: number): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private showWhisper(): void {
    if (!this.running || !this.whisperEl) return;
    const line = this.order[this.index % this.order.length];
    this.index++;
    this.whisperEl.lang = line.lang;
    this.whisperEl.textContent = line.text;
    this.whisperEl.classList.add('visible');
    this.later(() => {
      this.whisperEl?.classList.remove('visible');
      this.later(() => this.showWhisper(), WHISPER_FADE_MS + 400);
    }, WHISPER_HOLD_MS);
  }

  /** 시계가 아주 가끔 한순간 1분 넘어갔다가 다시 04:44로 돌아옴 */
  private scheduleClock(): void {
    this.later(() => {
      if (!this.running || !this.clockEl) return;
      this.clockEl.textContent = '04:45';
      this.later(() => {
        if (this.clockEl) this.clockEl.textContent = '04:44';
        this.scheduleClock();
      }, 420);
    }, rand(9000, 20000));
  }
}

/** 탭을 떠나 있을 때 탭 제목 (세 언어 중 하나를 돌아가며) */
export const AWAY_TITLES = ['…まだ、そこにいますか', '…still there?', '…아직 거기 있나요'];
export const HOME_TITLE = '04:44 — NO EXIT · 出口なし · 출구 없음';
