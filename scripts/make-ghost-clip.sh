#!/usr/bin/env bash
# 귀신 영상(AI 생성본 또는 촬영본)을 앱에서 쓰는 "stacked-alpha" MP4로 변환합니다.
#   위쪽 절반 = 색상, 아래쪽 절반 = 투명도 마스크(흰색=보임)
# 일반 H.264라서 iOS Safari를 포함한 모든 브라우저에서 재생됩니다.
#
# 사용법:
#   scripts/make-ghost-clip.sh <입력영상> <출력이름> [옵션]
#
# 옵션:
#   --key green|black   배경 종류 (기본 green)
#   --lo N --hi N       [green] 초록이 빨강·파랑보다 lo 이하로 강하면 완전히 보임, hi 이상이면 완전히 지움
#                       (0~255, 기본 25 / 70). 배경이 덜 지워지면 hi를 낮추고, 몸이 비치면 lo를 올림
#   --cover WxH         오른쪽 아래 W×H 픽셀을 배경으로 덮음 (AI 생성 표시 워터마크 제거용. 예: 90x90)
#   --keyer chroma      [green] 예전 방식(색 거리)으로 지움. --color --sim --blend와 함께 사용
#   --color 0xRRGGBB    지울 배경색 (chroma/black 방식)
#   --sim 0.0~1.0       키 색상 허용 범위 (chroma 0.16 / black 0.10)
#   --blend 0.0~1.0     가장자리 부드러움 (기본 0.06)
#   --height N          색상 부분 세로 픽셀 (기본 960, 짝수)
#   --fps N             출력 프레임레이트 (기본 30)
#   --intra             모든 프레임을 키프레임으로 인코딩 (프레임 탐색/역방향 스텝용, 파일 커짐)
#   --reverse           역재생 버전(<출력이름>_rev.mp4)도 함께 생성
#   --start S --dur D   입력에서 S초부터 D초만 사용
#   --loopfade S        끝 S초를 처음과 겹쳐 서서히 넘어가게 함 (영상 안에서 귀신이 이동해
#                       반복할 때 위치가 튀는 경우. 결과는 S초 짧아짐. 예: 1.2)
#   --out DIR           출력 폴더 (기본 public/ghosts)
#
# 예시:
#   scripts/make-ghost-clip.sh raw/walk_back.mov walk --key green --reverse
#   → public/ghosts/walk.mp4, public/ghosts/walk_rev.mp4
set -euo pipefail

if [ $# -lt 2 ]; then
  sed -n '2,32p' "$0"
  exit 1
fi

IN="$1"; NAME="$2"; shift 2
KEY=green; KEYER=diff; LO=25; HI=70; SIM=""; BLEND=0.06; COLOR=""; COVER=""; HEIGHT=960; FPS=30; INTRA=0; REVERSE=0
START=""; DUR=""; OUT=public/ghosts; LOOPFADE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --color) COLOR="$2"; shift 2 ;;
    --keyer) KEYER="$2"; shift 2 ;;
    --lo) LO="$2"; shift 2 ;;
    --hi) HI="$2"; shift 2 ;;
    --cover) COVER="$2"; shift 2 ;;
    --sim) SIM="$2"; shift 2 ;;
    --blend) BLEND="$2"; shift 2 ;;
    --height) HEIGHT="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --intra) INTRA=1; shift ;;
    --reverse) REVERSE=1; shift ;;
    --start) START="$2"; shift 2 ;;
    --dur) DUR="$2"; shift 2 ;;
    --loopfade) LOOPFADE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

if [ $((HEIGHT % 2)) -ne 0 ]; then echo "--height는 짝수여야 합니다" >&2; exit 1; fi

# 키잉 필터 (입력은 rgba)
case "$KEY" in
  green)
    if [ "$KEYER" = chroma ]; then
      SIM="${SIM:-0.16}"
      KEYF="format=yuva444p,chromakey=color=${COLOR:-0x00FF00}:similarity=${SIM}:blend=${BLEND},format=rgba"
    else
      # 초록 초과량 = G - max(R, B). 흰 옷·피부·머리카락은 거의 0, 초록 배경은 크게 나옴.
      # AI 영상처럼 초록이 탁해도 몸이 비치지 않음. 초록 번짐도 같이 제거(despill).
      EX="(g(X,Y)-max(r(X,Y),b(X,Y)))"
      KEYF="geq=r='r(X,Y)':g='min(g(X,Y),max(r(X,Y),b(X,Y)))':b='b(X,Y)':a='clip(255*(1-(${EX}-${LO})/(${HI}-${LO})),0,255)'"
    fi ;;
  black) SIM="${SIM:-0.10}"; KEYF="format=yuva444p,colorkey=color=${COLOR:-0x000000}:similarity=${SIM}:blend=${BLEND},format=rgba" ;;
  *) echo "--key는 green 또는 black" >&2; exit 1 ;;
esac

mkdir -p "$OUT"

TRIM=()
[ -n "$START" ] && TRIM+=(-ss "$START")
[ -n "$DUR" ] && TRIM+=(-t "$DUR")

GOP=$([ $INTRA -eq 1 ] && echo 1 || echo "$FPS")

# 키잉 → 프리멀티플라이(배경색 번짐 제거) → 색상/알파 분리 → 위아래로 쌓기
# 영상 가장자리 4px은 잘라냄 (AI 영상은 테두리 픽셀이 배경색이 아닌 경우가 많아 세로선으로 남음)
# 워터마크 자리는 키 색으로 덮어 함께 지워지게 함
PRE="crop=iw-8:ih-8:4:4,"
if [ -n "$COVER" ]; then
  CW="${COVER%x*}"; CH="${COVER#*x}"
  FILL="$([ "$KEY" = green ] && echo 0x00FF00 || echo "${COLOR:-0x000000}")"
  PRE="drawbox=x=iw-${CW}:y=ih-${CH}:w=${CW}:h=${CH}:color=${FILL}:t=fill,${PRE}"
fi

# 반복 이음매: [S, 끝] 구간 뒤에 [0, S] 구간을 S초 동안 겹쳐 녹임 → 마지막 프레임이 첫 프레임으로 자연스럽게 이어짐
if [ -n "$LOOPFADE" ]; then
  D="${DUR:-$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")}"
  [ -n "$START" ] && [ -z "$DUR" ] && D=$(awk "BEGIN { print $D - $START }")
  OFF=$(awk "BEGIN { print $D - 2 * $LOOPFADE }")
  PRE="fps=${FPS},split[lx][ly];[lx]trim=start=${LOOPFADE},setpts=PTS-STARTPTS[la];[ly]trim=end=${LOOPFADE},setpts=PTS-STARTPTS[lb];[la][lb]xfade=transition=fade:duration=${LOOPFADE}:offset=${OFF},${PRE}"
fi

BASE="${PRE}scale=-2:${HEIGHT}:flags=lanczos,fps=${FPS},format=rgba,${KEYF},premultiply=inplace=1,format=rgba"
STACK="split[c][a];[a]alphaextract,format=yuv420p[m];[c]format=yuv420p[cc];[cc][m]vstack,format=yuv420p"

encode() {
  local filter="$1" dst="$2"
  ffmpeg -y -loglevel error -stats "${TRIM[@]}" -i "$IN" \
    -filter_complex "[0:v]${filter}" \
    -an -c:v libx264 -preset slow -crf 19 -profile:v high -pix_fmt yuv420p \
    -g "$GOP" -movflags +faststart "$dst"
  echo "생성: $dst"
}

encode "${BASE},${STACK}" "$OUT/${NAME}.mp4"
if [ $REVERSE -eq 1 ]; then
  encode "${BASE},reverse,${STACK}" "$OUT/${NAME}_rev.mp4"
fi

# 매니페스트(src/ghost/clips.ts)에 넣을 aspect 값 출력
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$OUT/${NAME}.mp4")
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$OUT/${NAME}.mp4")
echo "크기: ${W}x${H} (색상 부분 ${W}x$((H / 2)))"
echo "clips.ts의 aspect 값: $(awk "BEGIN { printf \"%.4f\", $W / ($H / 2) }")"
