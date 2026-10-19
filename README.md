# 04:44 — 출구 없음

게임이 아니라 **공포 체험**을 목표로 하는 웹앱입니다. 흑백 화면 속 끝없이 이어지는 복도 미로를 걷는 동안, 링·주온 스타일의 실사 귀신이 드물고 느리게 나타납니다. 점수, 목표, 클리어가 없습니다.

- 교차로에서 좌우로 갈라지는 무한 복도. **지나온 길은 바뀝니다** (안 보이는 곳의 복도가 열리고 닫히고, 멀리 갔다 오면 구조와 공간 테마가 새로 정해짐)
- 귀신은 AI(구글 Flow / Veo)로 만든 실사 영상을 3D 공간에 합성
- 공간 음향(HRTF)과 콘크리트 복도 잔향, 정적을 활용한 소리 연출

## 실행

```bash
npm install
npm run dev      # http://localhost:4444
npm run build    # dist/ 로 빌드
```

`main` 브랜치에 푸시하면 Vercel이 자동으로 배포합니다.

## 조작

| PC | 동작 |
|---|---|
| ↑ ↓ / W S | 전진 · 후진 |
| ← → | 제자리 방향 전환 |
| A D | 옆걸음 |
| 마우스 | 시점 (화면 클릭 시 고정, 안 되면 드래그) |
| ESC | 일시정지 |

모바일은 왼쪽 조이스틱으로 이동, 오른쪽 스와이프로 시점을 돌립니다. 헤드폰 착용을 권장합니다.

## 귀신

한 번에 하나만 나타나고, 플레이어가 보고 있는 곳에서는 갑자기 생기지 않습니다.

| 귀신 | 동작 | 영상 |
|---|---|---|
| 다가오기 (`approach`) | 복도 끝에서 아주 천천히 다가옴. 코앞까지 오면 마주침 | 실사 |
| 기어오기 (`crawling`) | 바닥을 기어옴 | 실사 |
| 천장 (`ceiling`) | 천장에 거꾸로 매달림. 아래에서 올려다보면 마주침, 그냥 지나치면 등 뒤로 내려와 따라옴 | 실사 |
| 벽 기어가기 (`wallcrawl`) | 보고 있으면 멈추고, 시선을 돌리면 다가옴 | 실사 |
| 서 있기 (`standing`) | 지켜보다가 다시 보면 없어져 있음 | 실사 |
| 따라오는 귀신 | 지나온 길을 따라옴. 돌아볼 때마다 더 가까이 있음 | 실사 (`standing`) |
| 엿보기 (`peeking`) | 교차로 문틀 옆에서 내다보다 숨음 | 실사 |
| 웅크림 (`crouched`) | 벽 아래 웅크려 고개를 듦 | 실사 |
| 공중에 뜸 (`suspended`) | 허공에 떠 있음 | 임시 영상 (출현 안 함) |

천장·기어오기·다가오기는 다른 귀신보다 3배 자주 나옵니다. 출현 확률과 쉬는 시간은 `src/world/Haunts.ts` 위쪽 상수로 조절합니다.

## 귀신 영상 추가하기

1. Flow(https://flow.google.com/)에서 초록 배경, 고정 카메라 영상을 만듭니다. 귀신 종류별로 필요한 동작은 [docs/ghost-footage.md](docs/ghost-footage.md)를 참고하세요.
2. 원본을 `ghost-raw/`에 넣습니다 (git에 올라가지 않음).
3. 변환합니다. 결과는 `public/ghosts/<이름>.mp4` (위 절반 색상, 아래 절반 투명도 마스크).

   ```bash
   scripts/make-ghost-clip.sh ghost-raw/standing.mp4 standing --cover 90x90 --height 1280 --fps 24
   ```

   | 옵션 | 용도 |
   |---|---|
   | `--cover 90x90` | 오른쪽 아래 AI 생성 표시 제거 (Flow 영상은 항상) |
   | `--lo N` / `--hi N` | 배경 지우는 기준. 몸이 비치면 `--lo`를 올리고, 배경이 남으면 `--hi`를 낮춤 (기본 25 / 70) |
   | `--loopfade S` | 영상 안에서 귀신이 이동해 반복 때 튀는 경우, 끝 S초를 처음과 겹쳐 이어 붙임 |
   | `--pingpong` | 한 방향 동작(고개 들기 등)을 정방향 + 역방향으로 왕복 |
   | `--reverse` | 역재생본도 함께 생성 |

   ffmpeg가 필요합니다.
4. `src/ghost/clips.ts`의 `GHOST_CLIPS`에 항목을 추가합니다. 실제 영상은 같은 역할의 임시 영상보다 우선 쓰입니다.

   | 필드 | 의미 |
   |---|---|
   | `aspect` | 변환 스크립트가 출력하는 값 |
   | `frameHeightM` | 프레임 세로 전체가 공간에서 몇 m인지 |
   | `footV` | 발이 프레임 아래에서 몇 % 높이에 있는지 |
   | `hangV` | 천장에 매달린 영상일 때, 천장에 닿는 지점(프레임 위에서부터 비율) |
   | `roles` | 이 영상을 쓸 귀신 종류 |
   | `stepFps` | 동작을 뚝뚝 끊는 프레임레이트 (12 권장) |

## 확인용 주소

| 주소 | 용도 |
|---|---|
| `/?debug=ghosts` | 모든 복도(시작 지점 포함)에 귀신 배치 |
| `/?debug=ghosts&haunt=ceiling` | 한 종류만 강제 (`approach`, `floorcrawl`, `ceiling`, `wallcrawl`, `watcher`, `peek`, `crouched`, `suspended`, `follower`) |
| `/?mutate=fast` | 지나온 길이 바뀌는 것을 자주 시도 |

## 구조

```
src/
  main.ts                  앱 시작, 렌더링 루프, UI
  input/FirstPersonControls.ts  키보드·마우스·터치 조작
  fx/MonochromeShader.ts   흑백·필름 그레인·이벤트 시 화면 왜곡
  audio/SoundManager.ts    절차적 효과음, 3D 음향, 잔향
  world/
    Maze.ts                격자 미로 규칙, 이동 가능 영역(충돌), 시선 판정
    EndlessWorld.ts        구역 생성/해제, 지나온 길 바꾸기, 환경음
    CorridorBuilder.ts     복도·교차로 형태와 공간별 소품
    Lighting.ts            형광등 깜빡임, 고정 개수 조명 풀
    Haunts.ts              귀신 배치·행동·출현 빈도
    GhostFigure.ts         영상을 못 불러올 때 쓰는 대체 모델
  ghost/
    clips.ts               귀신 영상 목록
    VideoGhost.ts          영상 귀신을 공간에 합성 (안개·조명·그림자·끊김)
    VideoClipPool.ts       영상 재생 공유와 프레임 제어
scripts/make-ghost-clip.sh 귀신 영상 변환
public/ghosts/             변환된 귀신 영상
ghost-raw/                 원본 영상 보관 (git 제외)
docs/ghost-footage.md      귀신 영상 제작 가이드
```
