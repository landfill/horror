/**
 * 귀신 실사 영상 목록.
 * 실제 촬영본으로 바꿀 때는 scripts/make-ghost-clip.sh로 변환한 뒤
 * public/ghosts/에 넣고 아래 항목만 추가/수정하면 됩니다.
 */

/** 영상이 어떤 연출에 쓰이는지 */
export type GhostRole =
  | 'standing'
  | 'approach'
  | 'crawling'
  | 'peeking'
  | 'crouched'
  | 'suspended'
  /** 천장에 붙어 내려다봄 (바닥에 누운 배우를 바로 위에서 촬영) */
  | 'ceiling'
  /** 벽을 기어감 (바닥을 기는 배우를 위에서 촬영해 벽에 붙임) */
  | 'wallcrawl';

export interface GhostClip {
  id: string;
  /** stacked-alpha MP4 경로 (위=색상, 아래=투명도) */
  src: string;
  /** 미리 역재생해 둔 버전 (선택). 브라우저의 역방향 재생은 불안정해서 파일로 준비합니다. */
  srcReversed?: string;
  /** 색상 부분의 가로/세로 비율 (변환 스크립트가 출력해 줌) */
  aspect: number;
  /** 화면 속 인물의 실제 키(m). 색상 프레임 전체 높이가 이 값이 되도록 맞춥니다. */
  frameHeightM: number;
  /** 발이 닿는 위치. 색상 프레임 아래에서부터의 비율 (0 = 맨 아래) */
  footV: number;
  /** 이 영상을 쓸 수 있는 연출 */
  roles: GhostRole[];
  /** 끊김 연출 기본 프레임레이트. 낮을수록 동작이 뚝뚝 끊깁니다. 0이면 원본 그대로. */
  stepFps: number;
  /** 임시 영상 여부 (실제 촬영본이 들어오면 삭제) */
  placeholder?: boolean;
}

export const GHOST_CLIPS: GhostClip[] = [
  {
    // Flow(Veo) 생성본. 원본: ghost-raw/standing_test_720p.mp4
    // 변환: scripts/make-ghost-clip.sh ghost-raw/standing_test_720p.mp4 standing --cover 90x90 --height 1280 --fps 24
    id: 'standing',
    src: '/ghosts/standing.mp4',
    aspect: 0.5594,
    // 인물이 프레임 높이의 약 85%를 차지 → 키 약 1.65m로 보이게
    frameHeightM: 1.94,
    footV: 0.06,
    roles: ['standing'],
    stepFps: 12,
  },
  {
    id: 'test_placeholder',
    src: '/ghosts/test_placeholder.mp4',
    srcReversed: '/ghosts/test_placeholder_rev.mp4',
    aspect: 0.4167,
    frameHeightM: 1.9,
    footV: 0.02,
    roles: ['standing', 'approach', 'crawling', 'peeking', 'crouched', 'suspended', 'ceiling', 'wallcrawl'],
    stepFps: 12,
    placeholder: true,
  },
];

export function clipForRole(role: GhostRole): GhostClip | undefined {
  // 실제 촬영본이 있으면 임시 영상보다 우선
  const candidates = GHOST_CLIPS.filter((c) => c.roles.includes(role));
  const real = candidates.filter((c) => !c.placeholder);
  const pool = real.length > 0 ? real : candidates;
  return pool[Math.floor(Math.random() * pool.length)];
}
