"""
초록 배경 원본 영상에서 인물 크기와 발 위치를 처음부터 끝까지 일정하게 맞춥니다.

카메라 쪽으로 걸어오거나 기어오는 영상은 인물이 프레임 안에서 점점 커집니다.
이런 영상을 그대로 반복 재생하면, 처음으로 돌아갈 때마다 귀신이 툭 작아집니다.
게임에서는 귀신을 실제로 앞으로 움직이므로, 영상 속 인물 크기는 고정되어 있어야 합니다.

make-ghost-clip.sh를 돌리기 전에 원본에 먼저 적용합니다.
크기를 먼저 맞춰 두어야 --loopfade로 겹치는 두 장면의 인물 크기도 같아집니다.

필요: numpy, pillow, ffmpeg
사용법:
  python scripts/stabilize-ghost-clip.py <입력영상> <출력영상> [--cover 90x90] [--degree 2]
예시:
  python scripts/stabilize-ghost-clip.py ghost-raw/approach_test_720p.mp4 ghost-raw/approach_stable.mp4 --cover 90x90
  scripts/make-ghost-clip.sh ghost-raw/approach_stable.mp4 approach --height 1280 --fps 24 --loopfade 1.2
"""
import argparse
import json
import subprocess

import numpy as np
from PIL import Image


def probe(path):
    out = subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', path])
    s = json.loads(out)['streams'][0]
    return s['width'], s['height'], s['r_frame_rate']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--cover', default='', help='오른쪽 아래 WxH 워터마크를 배경색으로 덮음')
    ap.add_argument('--degree', type=int, default=2, help='크기 변화 곡선 차수 (기본 2)')
    ap.add_argument('--thresh', type=int, default=45, help='초록 초과량이 이보다 작으면 인물로 봄')
    args = ap.parse_args()

    W, H, rate = probe(args.src)
    raw = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', args.src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3).copy()
    n = len(frames)

    # 워터마크 덮기 (변형하면 위치가 움직이므로 미리 지움)
    bg = np.median(frames[:, 8:40, 8:40].reshape(-1, 3), axis=0).astype(np.uint8)
    if args.cover:
        cw, ch = map(int, args.cover.split('x'))
        frames[:, H - ch:, W - cw:] = bg

    # 프레임별 인물 영역 측정 (영상 가장자리 4px는 제외)
    tops, bots, cxs = [], [], []
    for f in frames:
        g = f.astype(np.int16)
        ex = g[..., 1] - np.maximum(g[..., 0], g[..., 2])
        m = ex < args.thresh
        m[:4] = m[-4:] = False
        m[:, :4] = m[:, -4:] = False
        rows = np.where(m.sum(axis=1) >= 3)[0]
        ys, xs = np.nonzero(m)
        tops.append(rows[0])
        bots.append(rows[-1])
        cxs.append(xs.mean())
    t = np.arange(n, dtype=float)
    h = np.array(bots, float) - np.array(tops, float)
    b = np.array(bots, float)
    cx = np.array(cxs, float)

    # 움직임 자체의 흔들림은 남기고, 카메라와의 거리 변화만 부드러운 곡선으로 잡음
    fit = lambda y: np.polyval(np.polyfit(t, y, args.degree), t)
    hf, bf, cxf = fit(h), fit(b), fit(cx)
    mid = n // 2
    h_ref, b_ref, cx_ref = hf[mid], bf[mid], cxf[mid]
    scale = h_ref / hf

    print(f'{args.src}: {n}프레임 {W}x{H}')
    print(f'  인물 높이 {h.min() / H * 100:.1f}% ~ {h.max() / H * 100:.1f}% → {h_ref / H * 100:.1f}%로 고정')
    print(f'  배율 {scale.min():.3f} ~ {scale.max():.3f}')

    enc = subprocess.Popen([
        'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', f'{W}x{H}', '-r', rate, '-i', '-',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '8', '-pix_fmt', 'yuv444p', args.dst],
        stdin=subprocess.PIPE)
    fill = tuple(int(v) for v in bg)
    for k, f in enumerate(frames):
        s = scale[k]
        # 출력 좌표 (x, y) → 입력 좌표: 발 기준점을 중심으로 1/s 배
        coeffs = (1 / s, 0, cxf[k] - cx_ref / s, 0, 1 / s, bf[k] - b_ref / s)
        img = Image.fromarray(f).transform((W, H), Image.AFFINE, coeffs,
                                           resample=Image.BICUBIC, fillcolor=fill)
        enc.stdin.write(img.tobytes())
    enc.stdin.close()
    enc.wait()
    print(f'  생성: {args.dst}')
    print(f'  발 위치(아래에서): {(H - 1 - b_ref) / H:.3f}')


if __name__ == '__main__':
    main()
