#!/usr/bin/env bash
# 촬영한 귀신 영상을 앱에서 쓰는 "stacked-alpha" MP4로 변환합니다.
#   위쪽 절반 = 색상, 아래쪽 절반 = 투명도 마스크(흰색=보임)
# 일반 H.264라서 iOS Safari를 포함한 모든 브라우저에서 재생됩니다.
#
# 사용법:
#   scripts/make-ghost-clip.sh <입력영상> <출력이름> [옵션]
#
# 옵션:
#   --key green|black   배경 종류 (기본 green)
#   --sim 0.0~1.0       키 색상 허용 범위 (기본 green 0.16 / black 0.10)
#   --blend 0.0~1.0     가장자리 부드러움 (기본 0.06)
#   --height N          색상 부분 세로 픽셀 (기본 960, 짝수)
#   --fps N             출력 프레임레이트 (기본 30)
#   --intra             모든 프레임을 키프레임으로 인코딩 (프레임 탐색/역방향 스텝용, 파일 커짐)
#   --reverse           역재생 버전(<출력이름>_rev.mp4)도 함께 생성
#   --start S --dur D   입력에서 S초부터 D초만 사용
#   --out DIR           출력 폴더 (기본 public/ghosts)
#
# 예시:
#   scripts/make-ghost-clip.sh raw/walk_back.mov walk --key green --reverse
#   → public/ghosts/walk.mp4, public/ghosts/walk_rev.mp4
set -euo pipefail

if [ $# -lt 2 ]; then
  sed -n '2,24p' "$0"
  exit 1
fi

IN="$1"; NAME="$2"; shift 2
KEY=green; SIM=""; BLEND=0.06; HEIGHT=960; FPS=30; INTRA=0; REVERSE=0
START=""; DUR=""; OUT=public/ghosts

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --sim) SIM="$2"; shift 2 ;;
    --blend) BLEND="$2"; shift 2 ;;
    --height) HEIGHT="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --intra) INTRA=1; shift ;;
    --reverse) REVERSE=1; shift ;;
    --start) START="$2"; shift 2 ;;
    --dur) DUR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

if [ $((HEIGHT % 2)) -ne 0 ]; then echo "--height는 짝수여야 합니다" >&2; exit 1; fi

case "$KEY" in
  green) SIM="${SIM:-0.16}"; KEYF="chromakey=color=0x00FF00:similarity=${SIM}:blend=${BLEND}" ;;
  black) SIM="${SIM:-0.10}"; KEYF="colorkey=color=0x000000:similarity=${SIM}:blend=${BLEND}" ;;
  *) echo "--key는 green 또는 black" >&2; exit 1 ;;
esac

mkdir -p "$OUT"

TRIM=()
[ -n "$START" ] && TRIM+=(-ss "$START")
[ -n "$DUR" ] && TRIM+=(-t "$DUR")

GOP=$([ $INTRA -eq 1 ] && echo 1 || echo "$FPS")

# 키잉 → 프리멀티플라이(배경색 번짐 제거) → 색상/알파 분리 → 위아래로 쌓기
BASE="scale=-2:${HEIGHT}:flags=lanczos,fps=${FPS},format=yuva444p,${KEYF},format=rgba,premultiply=inplace=1,format=rgba"
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
