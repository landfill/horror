import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/world/PosterPortrait.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(document, Image) {
  const module = { exports: {} };
  new Function('module', 'exports', 'document', 'Image', compiled)(module, module.exports, document, Image);
  return module.exports;
}
const api = load();
const width = api.POSTER_PHOTO_WIDTH, height = api.POSTER_PHOTO_HEIGHT;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4;
  pixels[i] = (x * 3 + y * 5) % 256;
  pixels[i + 1] = (x + y * 3) % 256;
  pixels[i + 2] = (x * 2 + y) % 256;
  pixels[i + 3] = 255;
}

test('the selected PNG remains byte-for-byte the supplied image and its crop is inside the photo', () => {
  const image = readFileSync(new URL('../public/posters/corridor-woman.png', import.meta.url));
  assert.equal(createHash('sha256').update(image).digest('hex'), '3849262b2263fb1da38fbafef192de5f2fdd0316ae8dc2420e0899b940569ddb');
  const crop = api.POSTER_PHOTO_CROP;
  assert.ok(crop.x >= 0 && crop.y >= 0);
  assert.ok(crop.x + crop.width <= image.readUInt32BE(16));
  assert.ok(crop.y + crop.height <= image.readUInt32BE(20));
});

test('neutral frame copies original pixels without redrawing the face', () => {
  const neutral = api.makePosterPhotoFrame(pixels, width, height, 'neutral');
  assert.notEqual(neutral, pixels);
  assert.deepEqual(neutral, pixels);
});

test('expressions alter only the eye or mouth region and never modify the source', () => {
  const original = new Uint8ClampedArray(pixels);
  for (const frame of ['blink-half', 'blink', 'smile-half', 'smile']) {
    const result = api.makePosterPhotoFrame(pixels, width, height, frame);
    const regions = frame.startsWith('blink') ? api.POSTER_PHOTO_FEATURES.eyes : [api.POSTER_PHOTO_FEATURES.mouth];
    let changes = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const changed = result[i] !== pixels[i] || result[i + 1] !== pixels[i + 1] || result[i + 2] !== pixels[i + 2];
      if (changed) {
        changes++;
        assert.ok(regions.some(r => ((x - r.x) / r.rx) ** 2 + ((y - r.y) / r.ry) ** 2 < 1), `${frame} changed a pixel outside its feature`);
      }
      assert.equal(result[i + 3], 255);
    }
    assert.ok(changes > 20, `${frame} has a visible pixel change`);
  }
  assert.deepEqual(pixels, original);
});

test('the portrait loads once and prepares all cached frames before reporting readiness', async () => {
  let requests = 0;
  const draws = [];
  const prepared = [];
  class ImageMock {
    set src(url) { requests++; assert.equal(url, api.POSTER_PHOTO_SOURCE); queueMicrotask(() => this.onload()); }
  }
  const document = { createElement: () => ({ getContext: () => ({
    drawImage: (...args) => draws.push(args),
    getImageData: () => ({ data: pixels }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (data) => prepared.push(data),
  }) }) };
  const loaded = load(document, ImageMock);
  const first = loaded.posterPhotoReady();
  assert.equal(loaded.posterPhotoReady(), first);
  assert.equal(await first, true);
  assert.equal(requests, 1);
  assert.equal(prepared.length, 5);
  const c = { drawImage: (...args) => draws.push(args) };
  for (const frame of ['neutral', 'blink-half', 'blink', 'smile-half', 'smile']) loaded.drawPosterPortrait(c, 28, 56, 128, 124, 0, frame);
  assert.equal(draws.length, 6, 'one source crop plus five cached-frame draws');
  assert.deepEqual(prepared[0].data, pixels);
  assert.equal(requests, 1);
});
