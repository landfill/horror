export type PosterFrame = 'neutral' | 'blink-half' | 'blink' | 'smile-half' | 'smile';

export const POSTER_PHOTO_WIDTH = 128;
export const POSTER_PHOTO_HEIGHT = 124;
/** 사용자가 제공한 PNG 원본은 그대로 보관하고, 표시할 때 얼굴 부분만 선택합니다. */
export const POSTER_PHOTO_SOURCE = '/posters/corridor-woman.png';
export const POSTER_PHOTO_CROP = { x: 32, y: 50, width: 124, height: 120 };
export const POSTER_PHOTO_FEATURES = {
  eyes: [{ x: 53.7, y: 63, rx: 10, ry: 5.8 }, { x: 83.6, y: 63, rx: 9, ry: 5.8 }],
  mouth: { x: 75, y: 104, rx: 14, ry: 12 },
};

const FRAME_NAMES: PosterFrame[] = ['neutral', 'blink-half', 'blink', 'smile-half', 'smile'];
const photoFrames = new Map<PosterFrame, HTMLCanvasElement>();
let loading: Promise<boolean> | null = null;

/** 프레임마다 종이 흔적이 고정되도록 쓰는 지역 난수. */
export function posterRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function sample(source: Uint8ClampedArray, width: number, height: number, x: number, y: number,
  target: Uint8ClampedArray, offset: number): void {
  x = Math.max(0, Math.min(width - 1, x));
  y = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  for (let channel = 0; channel < 4; channel++) {
    const top = source[(y0 * width + x0) * 4 + channel] * (1 - fx) + source[(y0 * width + x1) * 4 + channel] * fx;
    const bottom = source[(y1 * width + x0) * 4 + channel] * (1 - fx) + source[(y1 * width + x1) * 4 + channel] * fx;
    target[offset + channel] = top * (1 - fy) + bottom * fy;
  }
}

/** 원본 사진의 눈·입 주변 픽셀만 이동합니다. 얼굴을 새로 그리거나 다른 인물로 바꾸지 않습니다. */
export function makePosterPhotoFrame(source: Uint8ClampedArray, width: number, height: number,
  frame: PosterFrame): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source);
  if (frame === 'neutral') return output;
  const blink = frame === 'blink' || frame === 'blink-half';
  const strength = frame === 'blink-half' || frame === 'smile-half' ? 0.5 : 1;
  const sx = width / POSTER_PHOTO_WIDTH, sy = height / POSTER_PHOTO_HEIGHT;
  const regions = blink ? POSTER_PHOTO_FEATURES.eyes : [POSTER_PHOTO_FEATURES.mouth];
  for (const region of regions) {
    const cx = region.x * sx, cy = region.y * sy;
    const rx = region.rx * sx, ry = region.ry * sy;
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(height - 1, Math.ceil(cy + ry)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(width - 1, Math.ceil(cx + rx)); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        const radius = dx * dx + dy * dy;
        if (radius >= 1) continue;
        const fade = (1 - radius) * (1 - radius);
        let sourceX = x, sourceY = y;
        if (blink) {
          // 눈을 얇은 선으로 접으면서 위·아래 피부를 그 자리로 자연스럽게 끌어옴.
          const aperture = 1 - strength * 0.92 * fade;
          const core = ry * 0.55;
          const compressed = core * aperture;
          const distance = Math.abs(y - cy);
          const restored = distance <= compressed ? distance / aperture
            : core + (distance - compressed) * (ry - core) / (ry - compressed);
          sourceY = cy + Math.sign(y - cy) * restored;
        } else {
          // 한쪽 입꼬리를 눈에 띄게 위·바깥으로 당기되 경계에서 원본으로 부드럽게 연결.
          sourceY += 9 * sy * strength * fade;
          sourceX -= 3 * sx * strength * fade;
        }
        sample(source, width, height, sourceX, sourceY, output, (y * width + x) * 4);
      }
    }
  }
  return output;
}

/** 원본 PNG 한 장을 받은 뒤 표현용 작은 캔버스 5장을 한 번만 준비합니다. */
export function posterPhotoReady(): Promise<boolean> {
  if (loading) return loading;
  if (typeof Image === 'undefined') return Promise.resolve(false);
  loading = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      try {
        const base = document.createElement('canvas');
        base.width = POSTER_PHOTO_WIDTH; base.height = POSTER_PHOTO_HEIGHT;
        const context = base.getContext('2d', { willReadFrequently: true })!;
        const crop = POSTER_PHOTO_CROP;
        context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, base.width, base.height);
        const pixels = context.getImageData(0, 0, base.width, base.height).data;
        for (const frame of FRAME_NAMES) {
          const canvas = document.createElement('canvas');
          canvas.width = base.width; canvas.height = base.height;
          const c = canvas.getContext('2d')!;
          const data = c.createImageData(base.width, base.height);
          data.data.set(makePosterPhotoFrame(pixels, base.width, base.height, frame));
          c.putImageData(data, 0, 0);
          photoFrames.set(frame, canvas);
        }
        resolve(true);
      } catch (error) {
        console.warn('[poster] 사진을 준비하지 못했습니다.', error);
        resolve(false);
      }
    };
    image.onerror = () => {
      console.warn('[poster] 사진을 불러오지 못했습니다:', POSTER_PHOTO_SOURCE);
      resolve(false);
    };
    image.src = POSTER_PHOTO_SOURCE;
  });
  return loading;
}

export function drawPosterPortrait(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  _variant: number, frame: PosterFrame = 'neutral'): void {
  const image = photoFrames.get(frame);
  if (image) c.drawImage(image, x, y, w, h);
  else {
    c.fillStyle = '#151515'; c.fillRect(x, y, w, h);
    void posterPhotoReady();
  }
}
