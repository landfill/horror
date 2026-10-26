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

/** 귀신 목소리 구분용: 영상 속 인물의 성별 */
export type GhostGender = 'female' | 'male';
/** 귀신 목소리 구분용: 영상 속 인물의 나이대 */
export type GhostAge = 'child' | 'adult' | 'elderly';
/** 귀신이 내는 사람 목소리 종류: 키득거리는 얕은 웃음, 흐느낌 */
export type VoiceKind = 'giggle' | 'sob';

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
  /**
   * 천장에 거꾸로 매달린 영상일 때: 손발이 천장에 닿는 높이 (프레임 위에서부터의 비율).
   * 있으면 그 지점이 천장에 오도록 판을 매달고, 플레이어 쪽을 향해 돌림. footV는 쓰지 않음.
   */
  hangV?: number;
  /** 이 영상을 쓸 수 있는 연출 */
  roles: GhostRole[];
  /** 끊김 연출 기본 프레임레이트. 낮을수록 동작이 뚝뚝 끊깁니다. 0이면 원본 그대로. */
  stepFps: number;
  /** 다가오기 이동 속도(m/s). 생략하면 연출의 기본 속도를 사용. */
  approachSpeedMps?: number;
  /** 영상 속 인물의 성별. 목소리 효과음을 고를 때 씀 (없으면 목 긁는 소리) */
  gender?: GhostGender;
  /** 영상 속 인물의 나이대. 목소리 효과음을 고를 때 씀 */
  age?: GhostAge;
  /** 이 귀신에 어울리는 목소리 종류 (생략하면 그 성별·나이대의 기본 목록) */
  voices?: VoiceKind[];
  /** 임시 영상 여부 (실제 촬영본이 들어오면 삭제) */
  placeholder?: boolean;
}

export const GHOST_CLIPS: GhostClip[] = [
  {
    // Flow(Veo) 생성본. 몸을 옆으로 기울여 내다보다 천천히 세워 정면을 봄 → 왕복 재생.
    // 원본: ghost-raw/peeking_test_720p.mp4
    // 변환: scripts/make-ghost-clip.sh ghost-raw/peeking_test_720p.mp4 peeking --cover 90x90 --height 1280 --fps 24 --pingpong
    id: 'peeking',
    src: '/ghosts/peeking.mp4',
    aspect: 0.5594,
    // 선 인물이 프레임 높이의 약 93%를 차지 → 키 약 1.65m
    frameHeightM: 1.8,
    footV: 0.04,
    roles: ['peeking'],
    gender: 'female',
    age: 'adult',
    voices: ['giggle'],
    stepFps: 12,
  },
  {
    // Flow(Veo) 생성본. 무릎을 끌어안고 고개를 숙였다가 천천히 들어 올림 → 왕복 재생으로 다시 숙임.
    // 원본: ghost-raw/crouched_test_720p.mp4
    // 변환: scripts/make-ghost-clip.sh ghost-raw/crouched_test_720p.mp4 crouched --cover 90x90 --height 1280 --fps 24 --pingpong
    id: 'crouched',
    src: '/ghosts/crouched.mp4',
    aspect: 0.5594,
    // 웅크려 앉은 인물(고개를 들었을 때 약 1m)이 프레임의 약 84%를 차지
    frameHeightM: 1.2,
    footV: 0.04,
    roles: ['crouched'],
    gender: 'female',
    age: 'adult',
    voices: ['sob'],
    stepFps: 12,
  },
  {
    // Flow(Veo) 생성본. 천장에 손발을 붙이고 거꾸로 매달린 모습을 옆에서 본 영상.
    // 원본: ghost-raw/ceiling_hanging_v3_720p.mp4
    // 변환: scripts/make-ghost-clip.sh ghost-raw/ceiling_hanging_v3_720p.mp4 ceiling --cover 90x90 --height 1280 --fps 24
    id: 'ceiling',
    src: '/ghosts/ceiling.mp4',
    aspect: 0.5594,
    // 천장에서 늘어진 몸이 약 1.2m → 가장 낮은 곳이 약 1.9m (지나갈 때 머리에 닿지 않게)
    frameHeightM: 1.7,
    footV: 0,
    hangV: 0.11,
    roles: ['ceiling'],
    gender: 'female',
    age: 'adult',
    voices: ['giggle'],
    stepFps: 12,
  },
  {
    // Flow(Veo) 생성본. 벽을 기어오르는 뒷모습, 머리가 프레임 위쪽 → 앱이 벽에 눕혀 붙임.
    // 원본: ghost-raw/wallcrawl_test_720p.mp4
    // 변환: scripts/make-ghost-clip.sh ghost-raw/wallcrawl_test_720p.mp4 wallcrawl --cover 90x90 --height 1280 --fps 24 --loopfade 1.0 --lo 20 --hi 45
    id: 'wallcrawl',
    src: '/ghosts/wallcrawl.mp4',
    aspect: 0.5594,
    frameHeightM: 1.92,
    footV: 0.05,
    roles: ['wallcrawl'],
    gender: 'female',
    age: 'adult',
    voices: ['giggle', 'sob'],
    stepFps: 12,
  },
  {
    // Flow(Veo) 생성본. 카메라 쪽으로 걸어오는 영상이라 역재생본 없이 그대로 사용.
    // 원본: ghost-raw/approach_test_720p.mp4
    // 영상 속 인물이 점점 커져서 반복할 때마다 작아 보이므로, 먼저 크기를 고정함:
    //   python scripts/stabilize-ghost-clip.py ghost-raw/approach_test_720p.mp4 ghost-raw/approach_stable.mp4 --cover 90x90
    // 변환: scripts/make-ghost-clip.sh ghost-raw/approach_stable.mp4 approach --height 1280 --fps 24 --loopfade 1.2
    id: 'approach',
    src: '/ghosts/approach.mp4',
    aspect: 0.5594,
    // 인물이 프레임 높이의 약 86%를 차지 → 키 약 1.65m로 보이게
    frameHeightM: 1.92,
    footV: 0.07,
    roles: ['approach'],
    gender: 'female',
    age: 'adult',
    voices: ['sob'],
    stepFps: 12,
  },
  {
    // Flow(Veo) 생성본. 제자리에서 웃는 어린 귀신. 기존 approach 영상과 무작위로 번갈아 나옴.
    // 원본: ghost-raw/Ghost_character_smiling_on_green…_20261022222213.mp4
    // 변환: scripts/make-ghost-clip.sh <원본> smiling --cover 90x90 --height 1280 --fps 24
    // 원본의 체형과 동작을 유지하며, 성인 크기에 맞추는 크기 보정이나 역재생은 하지 않음.
    id: 'smiling',
    src: '/ghosts/smiling.mp4',
    aspect: 0.5594,
    // 인물이 프레임 높이의 약 90%를 차지 → 어린 귀신의 키 약 1.3m
    frameHeightM: 1.45,
    footV: 0.045,
    roles: ['approach'],
    gender: 'male',
    age: 'child',
    voices: ['giggle'],
    stepFps: 12,
    approachSpeedMps: 0.08,
  },
  {
    // Flow(Veo) 생성본. 원본: ghost-raw/crawling_test_720p.mp4
    // 크기 고정: python scripts/stabilize-ghost-clip.py ghost-raw/crawling_test_720p.mp4 ghost-raw/crawling_stable.mp4 --cover 90x90
    // 변환: scripts/make-ghost-clip.sh ghost-raw/crawling_stable.mp4 crawling --height 1280 --fps 24 --loopfade 1.2
    id: 'crawling',
    src: '/ghosts/crawling.mp4',
    aspect: 0.5594,
    // 웅크린 인물(약 0.9m)이 프레임의 약 62%를 차지
    frameHeightM: 1.5,
    // 손·무릎이 바닥에 닿는 높이 (프레임 아래에서 약 17%)
    footV: 0.17,
    roles: ['crawling'],
    gender: 'female',
    age: 'adult',
    voices: ['sob', 'giggle'],
    stepFps: 12,
  },
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
    gender: 'female',
    age: 'adult',
    voices: ['sob'],
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

/** 임시 영상이 아닌 실제 영상이 있는 역할인지 */
export function hasRealClip(role: GhostRole): boolean {
  return GHOST_CLIPS.some((c) => !c.placeholder && c.roles.includes(role));
}

export function clipForRole(role: GhostRole): GhostClip | undefined {
  // 실제 촬영본이 있으면 임시 영상보다 우선
  const candidates = GHOST_CLIPS.filter((c) => c.roles.includes(role));
  const real = candidates.filter((c) => !c.placeholder);
  const pool = real.length > 0 ? real : candidates;
  return pool[Math.floor(Math.random() * pool.length)];
}
