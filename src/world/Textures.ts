import * as THREE from 'three';

/**
 * 모든 공간/귀신 텍스처를 캔버스로 절차 생성하고 캐시합니다.
 * 무한히 생성·삭제되는 구간들이 텍스처와 머티리얼을 공유하므로
 * 구간 삭제 시에는 지오메트리만 해제하면 됩니다.
 */

type Draw = (c: CanvasRenderingContext2D, w: number, h: number) => void;

const texCache = new Map<string, THREE.CanvasTexture>();
const matCache = new Map<string, THREE.Material>();

export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function makeCanvasTexture(w: number, h: number, draw: Draw, repeat = true): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.magFilter = THREE.LinearFilter;
  return t;
}

function tex(key: string, w: number, h: number, draw: Draw, repeat = true): THREE.CanvasTexture {
  let t = texCache.get(key);
  if (!t) {
    t = makeCanvasTexture(w, h, draw, repeat);
    texCache.set(key, t);
  }
  return t;
}

// ---------------------------------------------------------------------------
// 낡음 효과 헬퍼
// ---------------------------------------------------------------------------

function grime(c: CanvasRenderingContext2D, w: number, h: number, count: number, maxA: number, light = false): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = rand(3, w * 0.14);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const a = Math.random() * maxA;
    g.addColorStop(0, light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function speckle(c: CanvasRenderingContext2D, w: number, h: number, count: number, maxA: number): void {
  for (let i = 0; i < count; i++) {
    const v = Math.random() > 0.5 ? 255 : 0;
    c.fillStyle = `rgba(${v},${v},${v},${Math.random() * maxA})`;
    c.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }
}

function drips(c: CanvasRenderingContext2D, w: number, h: number, count: number, maxA: number): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * w;
    const y0 = Math.random() * h * 0.45;
    const len = rand(h * 0.15, h * 0.7);
    const g = c.createLinearGradient(0, y0, 0, y0 + len);
    g.addColorStop(0, `rgba(0,0,0,${Math.random() * maxA})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(x, y0, rand(1, 3.5), len);
  }
}

// ---------------------------------------------------------------------------
// 텍스처
// ---------------------------------------------------------------------------

export const Tex = {
  concrete: () =>
    tex('concrete', 256, 256, (c, w, h) => {
      c.fillStyle = '#6d6d6a';
      c.fillRect(0, 0, w, h);
      grime(c, w, h, 70, 0.28);
      grime(c, w, h, 20, 0.08, true);
      drips(c, w, h, 30, 0.4);
      speckle(c, w, h, 3000, 0.25);
    }),

  schoolWall: () =>
    tex('schoolWall', 256, 256, (c, w, h) => {
      c.fillStyle = '#b2b2ac';
      c.fillRect(0, 0, w, h * 0.55);
      c.fillStyle = '#585c56';
      c.fillRect(0, h * 0.55, w, h * 0.45);
      c.fillStyle = '#262826';
      c.fillRect(0, h * 0.545, w, 5);
      grime(c, w, h, 45, 0.25);
      drips(c, w, h, 28, 0.38);
      speckle(c, w, h, 2000, 0.18);
    }),

  tileFloor: () =>
    tex('tileFloor', 128, 128, (c, w, h) => {
      const s = w / 4;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          c.fillStyle = (x + y) % 2 === 0 ? '#4c4c4a' : '#3a3a39';
          c.fillRect(x * s, y * s, s, s);
          c.strokeStyle = 'rgba(0,0,0,0.5)';
          c.strokeRect(x * s + 0.5, y * s + 0.5, s, s);
        }
      }
      grime(c, w, h, 25, 0.35);
      speckle(c, w, h, 900, 0.3);
    }),

  ceilingTile: () =>
    tex('ceilingTile', 128, 128, (c, w, h) => {
      c.fillStyle = '#8a8a86';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#3b3b3a';
      c.lineWidth = 3;
      c.strokeRect(1, 1, w - 2, h - 2);
      for (let i = 0; i < 260; i++) {
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.fillRect(Math.random() * w, Math.random() * h, 1, 1);
      }
      // 물 샌 얼룩
      grime(c, w, h, 6, 0.45);
    }),

  woodDoor: () =>
    tex('woodDoor', 128, 256, (c, w, h) => {
      c.fillStyle = '#4a4744';
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 3) {
        c.fillStyle = `rgba(0,0,0,${Math.random() * 0.18})`;
        c.fillRect(x, 0, 1, h);
      }
      c.fillStyle = '#0b0b0b';
      c.fillRect(22, 26, 84, 70);
      c.strokeStyle = '#2a2826';
      c.lineWidth = 5;
      c.strokeRect(22, 26, 84, 70);
      c.fillStyle = '#3e3b38';
      c.fillRect(20, 118, 88, 116);
      c.fillStyle = '#8e8e8a';
      c.beginPath();
      c.arc(104, 140, 5, 0, Math.PI * 2);
      c.fill();
      grime(c, w, h, 18, 0.35);
    }, false),

  steelDoor: () =>
    tex('steelDoor', 128, 256, (c, w, h) => {
      c.fillStyle = '#7a7b79';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#4a4b49';
      c.lineWidth = 4;
      c.strokeRect(8, 8, w - 16, h - 16);
      // 도어스코프
      c.fillStyle = '#111';
      c.beginPath();
      c.arc(w / 2, 78, 4, 0, Math.PI * 2);
      c.fill();
      // 손잡이
      c.fillStyle = '#2e2e2d';
      c.fillRect(96, 128, 18, 8);
      // 떨어져나간 전단지 자국
      for (let i = 0; i < 6; i++) {
        c.fillStyle = `rgba(220,220,215,${rand(0.2, 0.5)})`;
        c.fillRect(rand(14, 80), rand(150, 220), rand(10, 30), rand(6, 18));
      }
      grime(c, w, h, 22, 0.35);
      drips(c, w, h, 12, 0.4);
    }, false),

  shoji: () =>
    tex('shoji', 128, 256, (c, w, h) => {
      c.fillStyle = '#c9c7bf';
      c.fillRect(0, 0, w, h);
      grime(c, w, h, 14, 0.25);
      // 찢어진 창호지 구멍
      for (let i = 0; i < 3; i++) {
        c.fillStyle = '#0a0a0a';
        const x = rand(10, w - 20);
        const y = rand(30, h - 40);
        c.beginPath();
        c.ellipse(x, y, rand(3, 9), rand(4, 12), rand(0, 3), 0, Math.PI * 2);
        c.fill();
      }
      c.strokeStyle = '#2b2925';
      c.lineWidth = 4;
      for (let x = 0; x <= w; x += w / 3) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.stroke();
      }
      for (let y = 0; y <= h; y += h / 6) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
      }
      c.lineWidth = 10;
      c.strokeRect(0, 0, w, h);
    }),

  woodFloor: () =>
    tex('woodFloor', 128, 128, (c, w, h) => {
      for (let x = 0; x < w; x += 16) {
        const v = Math.floor(rand(52, 70));
        c.fillStyle = `rgb(${v},${v - 2},${v - 4})`;
        c.fillRect(x, 0, 16, h);
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.fillRect(x, 0, 1, h);
        c.fillRect(x, rand(0, h), 16, 1);
      }
      grime(c, w, h, 15, 0.35);
      speckle(c, w, h, 500, 0.25);
    }),

  darkWood: () =>
    tex('darkWood', 128, 128, (c, w, h) => {
      c.fillStyle = '#2b2a28';
      c.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) {
        c.fillStyle = `rgba(0,0,0,${Math.random() * 0.2})`;
        c.fillRect(0, y, w, 1);
      }
      grime(c, w, h, 10, 0.3);
    }),

  subwayTile: () =>
    tex('subwayTile', 128, 128, (c, w, h) => {
      c.fillStyle = '#3a3a39';
      c.fillRect(0, 0, w, h);
      const s = 16;
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          const v = Math.floor(rand(170, 200));
          c.fillStyle = `rgb(${v},${v},${v - 3})`;
          c.fillRect(x + 1, y + 1, s - 2, s - 2);
        }
      }
      grime(c, w, h, 30, 0.3);
      drips(c, w, h, 14, 0.35);
    }),

  wallpaper: () =>
    tex('wallpaper', 128, 256, (c, w, h) => {
      c.fillStyle = '#a9a69a';
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 8) {
        c.fillStyle = 'rgba(0,0,0,0.06)';
        c.fillRect(x, 0, 3, h);
      }
      for (let y = 10; y < h; y += 24) {
        for (let x = 4; x < w; x += 16) {
          c.fillStyle = 'rgba(0,0,0,0.08)';
          c.fillRect(x, y, 4, 4);
        }
      }
      grime(c, w, h, 20, 0.3);
      drips(c, w, h, 18, 0.3);
    }),

  carpet: () =>
    tex('carpet', 128, 128, (c, w, h) => {
      c.fillStyle = '#6b685e';
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, 5000, 0.25);
      grime(c, w, h, 16, 0.4);
    }),

  vhsShelf: () =>
    tex('vhsShelf', 256, 256, (c, w, h) => {
      c.fillStyle = '#121212';
      c.fillRect(0, 0, w, h);
      const rows = 5;
      const rh = h / rows;
      for (let r = 0; r < rows; r++) {
        let x = 2;
        while (x < w - 4) {
          const sw = Math.floor(rand(6, 11));
          if (Math.random() < 0.08) {
            x += sw; // 빠진 자리
            continue;
          }
          const v = Math.floor(rand(30, 150));
          c.fillStyle = `rgb(${v},${v},${v})`;
          c.fillRect(x, r * rh + 6, sw - 1, rh - 10);
          c.fillStyle = `rgba(230,230,230,${rand(0.3, 0.8)})`;
          c.fillRect(x + 1, r * rh + rh * 0.35, sw - 3, rand(4, 10));
          x += sw;
        }
        c.fillStyle = '#2d2c2a';
        c.fillRect(0, (r + 1) * rh - 4, w, 4);
      }
      grime(c, w, h, 14, 0.4);
    }),

  metal: () =>
    tex('metal', 128, 128, (c, w, h) => {
      c.fillStyle = '#8c8d8b';
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x++) {
        c.fillStyle = `rgba(${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},0.04)`;
        c.fillRect(x, 0, 1, h);
      }
      grime(c, w, h, 12, 0.3);
      // 긁힌 자국
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      for (let i = 0; i < 10; i++) {
        c.beginPath();
        const x = rand(0, w);
        const y = rand(0, h);
        c.moveTo(x, y);
        c.lineTo(x + rand(-20, 20), y + rand(10, 40));
        c.stroke();
      }
    }),

  locker: () =>
    tex('locker', 128, 128, (c, w, h) => {
      c.fillStyle = '#5a5c5a';
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 32) {
        c.fillStyle = '#2a2b2a';
        c.fillRect(x, 0, 2, h);
        for (let y = 12; y < 40; y += 5) {
          c.fillStyle = '#1a1a1a';
          c.fillRect(x + 8, y, 16, 2);
        }
      }
      grime(c, w, h, 18, 0.35);
    }),

  poster: () =>
    tex('poster', 128, 180, (c, w, h) => {
      c.fillStyle = '#d5d4cc';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#111';
      c.font = 'bold 26px serif';
      c.textAlign = 'center';
      c.fillText('찾습니다', w / 2, 30);
      // 흐릿한 얼굴 사진 (이목구비 없음)
      c.fillStyle = '#4a4a48';
      c.fillRect(24, 42, 80, 86);
      const g = c.createRadialGradient(64, 82, 4, 64, 82, 36);
      g.addColorStop(0, 'rgba(200,200,195,0.85)');
      g.addColorStop(1, 'rgba(60,60,58,0)');
      c.fillStyle = g;
      c.fillRect(24, 42, 80, 86);
      c.fillStyle = 'rgba(0,0,0,0.85)';
      c.fillRect(24, 42, 80, 26); // 앞머리처럼 덮인 검은 부분
      for (let i = 0; i < 4; i++) {
        c.fillStyle = '#555';
        c.fillRect(18, 140 + i * 9, rand(60, 92), 4);
      }
      grime(c, w, h, 16, 0.35);
      drips(c, w, h, 8, 0.4);
    }, false),

  clock: () =>
    tex('clock', 128, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.fillStyle = '#d9d9d4';
      c.beginPath();
      c.arc(64, 64, 58, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 6;
      c.strokeStyle = '#1f1f1f';
      c.stroke();
      c.strokeStyle = '#111';
      c.lineWidth = 4;
      // 4시 44분에 멈춰 있음
      c.beginPath();
      c.moveTo(64, 64);
      c.lineTo(64 + Math.cos((4.73 / 12) * Math.PI * 2 - Math.PI / 2) * 30, 64 + Math.sin((4.73 / 12) * Math.PI * 2 - Math.PI / 2) * 30);
      c.stroke();
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(64, 64);
      c.lineTo(64 + Math.cos((44 / 60) * Math.PI * 2 - Math.PI / 2) * 46, 64 + Math.sin((44 / 60) * Math.PI * 2 - Math.PI / 2) * 46);
      c.stroke();
      grime(c, w, h, 6, 0.3);
    }, false),

  /** 벽에 찍힌 손자국 몇 개 (일부는 끌린 자국). 배경은 투명 */
  handprints: () =>
    tex('handprints', 256, 256, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      const n = Math.floor(rand(3, 6));
      for (let i = 0; i < n; i++) {
        const x = rand(40, w - 40);
        const y = rand(50, h - 40);
        const s = rand(0.75, 1.05);
        const a = rand(0.45, 0.8);
        c.save();
        c.translate(x, y);
        c.rotate(rand(-0.5, 0.5));
        c.scale(s, s);
        c.fillStyle = `rgba(12,12,12,${a})`;
        // 손바닥
        c.beginPath();
        c.ellipse(0, 10, 15, 18, 0, 0, Math.PI * 2);
        c.fill();
        // 손가락 네 개 + 엄지
        for (const [fx, fy, len, rot] of [[-11, -14, 22, -0.12], [-3, -18, 26, -0.03], [5, -17, 25, 0.05], [12, -12, 19, 0.16], [-19, 6, 15, -0.9]]) {
          c.save();
          c.translate(fx, fy);
          c.rotate(rot);
          c.beginPath();
          c.ellipse(0, -len / 2 + 6, 3.6, len / 2, 0, 0, Math.PI * 2);
          c.fill();
          c.restore();
        }
        // 아래로 끌린 자국
        if (Math.random() < 0.5) {
          const g = c.createLinearGradient(0, 20, 0, 20 + rand(30, 70));
          g.addColorStop(0, `rgba(12,12,12,${a * 0.7})`);
          g.addColorStop(1, 'rgba(12,12,12,0)');
          c.fillStyle = g;
          for (let k = -2; k <= 2; k++) c.fillRect(k * 6 - 1.5, 20, 3, 70);
        }
        c.restore();
      }
      speckle(c, w, h, 400, 0.15);
    }, false),

  /** 젖은 맨발 자국 세 걸음 (아래에서 위로 걸어감). 배경은 투명. 0.55m × 1.1m 평면에 붙임 */
  footprints: () =>
    tex('footprints', 128, 256, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      const steps = 3;
      for (let i = 0; i < steps; i++) {
        const left = i % 2 === 0;
        const x = w / 2 + (left ? -22 : 22) + rand(-3, 3);
        const y = h - 50 - i * 78;
        const a = 0.82 - i * 0.14; // 갈수록 옅어짐
        c.save();
        c.translate(x, y);
        c.rotate(rand(-0.1, 0.1) + (left ? -0.08 : 0.08));
        c.scale(1.6, 1.6);
        c.fillStyle = `rgba(8,8,8,${a})`;
        c.beginPath();
        c.ellipse(0, 0, 7, 12, 0, 0, Math.PI * 2); // 앞꿈치
        c.fill();
        c.beginPath();
        c.ellipse(0, 15, 5.5, 7, 0, 0, Math.PI * 2); // 뒤꿈치
        c.fill();
        for (let t = 0; t < 5; t++) {
          c.beginPath();
          c.arc((left ? 1 : -1) * (t * 2.6 - 5), -14 + Math.abs(t - 1) * 0.7, t === 0 ? 2.6 : 1.8, 0, Math.PI * 2);
          c.fill();
        }
        c.restore();
      }
    }, false),

  /** 아파트 우편함 앞면: 칸마다 404호, 전단지가 삐져나옴 */
  mailbox: () =>
    tex('mailbox', 256, 128, (c, w, h) => {
      c.fillStyle = '#4a4a47';
      c.fillRect(0, 0, w, h);
      const cols = 4;
      const rows = 2;
      const cw = w / cols;
      const ch = h / rows;
      c.font = 'bold 13px sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const px = x * cw;
          const py = y * ch;
          c.fillStyle = '#5c5c58';
          c.fillRect(px + 4, py + 4, cw - 8, ch - 8);
          c.fillStyle = '#101010';
          c.fillRect(px + 12, py + 24, cw - 24, 6); // 투입구
          c.fillStyle = '#cfcfca';
          c.fillText('404', px + cw / 2, py + 14);
          if (Math.random() < 0.55) {
            // 꽂힌 채 쌓인 전단지
            c.fillStyle = '#c8c8c2';
            c.fillRect(px + rand(14, 24), py + 18, rand(16, 28), 10);
          }
        }
      }
      grime(c, w, h, 16, 0.4);
      drips(c, w, h, 6, 0.35);
    }, false),

  /** 실종 전단지의 이상한 판: 얼굴 자리에 뒤통수 (이상 현상용) */
  posterBack: () =>
    tex('posterBack', 128, 180, (c, w, h) => {
      c.fillStyle = '#d5d4cc';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#111';
      c.font = 'bold 26px serif';
      c.textAlign = 'center';
      c.fillText('찾습니다', w / 2, 30);
      c.fillStyle = '#4a4a48';
      c.fillRect(24, 42, 80, 86);
      // 사진 속 사람이 돌아서 있음: 검은 머리카락만
      const g = c.createRadialGradient(64, 92, 6, 64, 92, 40);
      g.addColorStop(0, 'rgba(8,8,8,0.95)');
      g.addColorStop(0.75, 'rgba(14,14,14,0.9)');
      g.addColorStop(1, 'rgba(60,60,58,0)');
      c.fillStyle = g;
      c.fillRect(24, 42, 80, 86);
      for (let i = 0; i < 4; i++) {
        c.fillStyle = '#555';
        c.fillRect(18, 140 + i * 9, rand(60, 92), 4);
      }
      grime(c, w, h, 16, 0.35);
      drips(c, w, h, 8, 0.4);
    }, false),

  /** 벽·바닥·천장에 붙이는 얼룩 (투명 배경). 0: 물 샌 자국, 1: 그을음·곰팡이, 2: 흘러내린 자국 */
  stain: (v: number) =>
    tex(`stain:${v}`, 128, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      if (v === 0) {
        for (let k = 0; k < 3; k++) {
          const r = w * rand(0.25, 0.45);
          const x = w / 2 + rand(-10, 10);
          const y = h / 2 + rand(-10, 10);
          const g = c.createRadialGradient(x, y, r * 0.55, x, y, r);
          g.addColorStop(0, 'rgba(0,0,0,0.08)');
          g.addColorStop(0.85, 'rgba(0,0,0,0.42)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g;
          c.fillRect(0, 0, w, h);
        }
      } else if (v === 1) {
        for (let k = 0; k < 40; k++) {
          const x = w / 2 + rand(-1, 1) * rand(0, w * 0.4);
          const y = h / 2 + rand(-1, 1) * rand(0, h * 0.4);
          const r = rand(3, 16);
          const g = c.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(0,0,0,${rand(0.2, 0.55)})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g;
          c.fillRect(x - r, y - r, r * 2, r * 2);
        }
      } else {
        for (let k = 0; k < 14; k++) {
          const x = rand(w * 0.2, w * 0.8);
          const len = rand(h * 0.3, h * 0.95);
          const g = c.createLinearGradient(0, 0, 0, len);
          g.addColorStop(0, `rgba(0,0,0,${rand(0.3, 0.6)})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g;
          c.fillRect(x, 0, rand(1.5, 5), len);
        }
      }
    }, false),

  // ---------------- 귀신 ----------------

  dress: () =>
    tex('dress', 128, 256, (c, w, h) => {
      c.fillStyle = '#cfcfca';
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x++) {
        const s = Math.sin(x * 0.45) * 0.08 + Math.sin(x * 0.13) * 0.06;
        c.fillStyle = s > 0 ? `rgba(0,0,0,${s})` : `rgba(255,255,255,${-s * 0.6})`;
        c.fillRect(x, 0, 1, h);
      }
      // 밑단부터 스며든 검은 물
      const g = c.createLinearGradient(0, h * 0.55, 0, h);
      g.addColorStop(0, 'rgba(10,10,10,0)');
      g.addColorStop(0.5, 'rgba(25,25,24,0.55)');
      g.addColorStop(1, 'rgba(8,8,8,0.92)');
      c.fillStyle = g;
      c.fillRect(0, h * 0.55, w, h * 0.45);
      grime(c, w, h, 30, 0.4);
      drips(c, w, h, 30, 0.5);
    }),

  skin: () =>
    tex('skin', 64, 64, (c, w, h) => {
      c.fillStyle = '#9fa29f';
      c.fillRect(0, 0, w, h);
      grime(c, w, h, 10, 0.3);
      speckle(c, w, h, 400, 0.2);
    }),

  hair: () =>
    tex('hair', 32, 256, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      for (let i = 0; i < 9; i++) {
        let x = rand(2, w - 2);
        const lw = rand(1.2, 3.2);
        const endY = h * rand(0.75, 1.0);
        c.strokeStyle = `rgba(255,255,255,${rand(0.75, 1)})`;
        c.lineWidth = lw;
        c.beginPath();
        c.moveTo(x, 0);
        for (let y = 0; y < endY; y += 16) {
          x += rand(-1.5, 1.5);
          c.lineTo(Math.max(1, Math.min(w - 1, x)), y);
        }
        c.stroke();
      }
    }, false),
};

export interface LabelOptions {
  w?: number;
  h?: number;
  fg?: string;
  bg?: string;
  font?: string;
  border?: boolean;
}

export function labelTex(text: string, o: LabelOptions = {}): THREE.CanvasTexture {
  const w = o.w ?? 256;
  const h = o.h ?? 128;
  const key = `label:${text}:${w}:${h}:${o.fg}:${o.bg}:${o.font}:${o.border}`;
  return tex(key, w, h, (c) => {
    c.clearRect(0, 0, w, h);
    if (o.bg) {
      c.fillStyle = o.bg;
      c.fillRect(0, 0, w, h);
    }
    if (o.border) {
      c.strokeStyle = o.fg ?? '#d0d0d0';
      c.lineWidth = 6;
      c.strokeRect(5, 5, w - 10, h - 10);
    }
    c.fillStyle = o.fg ?? '#cfcfcf';
    c.font = o.font ?? `bold ${Math.floor(h * 0.55)}px serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 + 2);
    if (o.bg) {
      grime(c, w, h, 10, 0.3);
      speckle(c, w, h, 300, 0.25);
    }
  }, false);
}

// ---------------------------------------------------------------------------
// 머티리얼 캐시
// ---------------------------------------------------------------------------

function lambert(
  key: string,
  map: (() => THREE.Texture) | null,
  color = 0xffffff,
  extra: THREE.MeshLambertMaterialParameters = {}
): THREE.MeshLambertMaterial {
  let m = matCache.get(key) as THREE.MeshLambertMaterial | undefined;
  if (!m) {
    m = new THREE.MeshLambertMaterial({ map: map ? map() : null, color, ...extra });
    matCache.set(key, m);
  }
  return m;
}

function basic(key: string, color: number): THREE.MeshBasicMaterial {
  let m = matCache.get(key) as THREE.MeshBasicMaterial | undefined;
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    matCache.set(key, m);
  }
  return m;
}

const VARIANT_TINTS = [0xffffff, 0xdcdcda, 0xbdbdba, 0x9e9e9b];

/**
 * 같은 재질의 변형: 밝기를 조금 바꾸고 무늬 위치를 밀거나 좌우를 뒤집음.
 * 텍스처는 원본 이미지를 공유하므로 GPU 메모리는 늘지 않습니다. 변형은 v 값마다 하나씩만 캐시됩니다.
 */
export function variantOf(base: THREE.Material, v: number): THREE.Material {
  if (v === 0 || !(base instanceof THREE.MeshLambertMaterial)) return base;
  const key = `variant:${base.uuid}:${v}`;
  let m = matCache.get(key);
  if (!m) {
    const lm = base.clone();
    lm.color.setHex(VARIANT_TINTS[v % VARIANT_TINTS.length]).multiply(base.color);
    if (base.map) {
      const t = base.map.clone();
      t.offset.set((v * 0.37) % 1, (v * 0.23) % 1);
      if (v % 2 === 1 && t.wrapS === THREE.RepeatWrapping) t.repeat.x = -1;
      t.needsUpdate = true;
      lm.map = t;
    }
    m = lm;
    matCache.set(key, m);
  }
  return m;
}

export const VARIANT_COUNT = VARIANT_TINTS.length;

export const Mat = {
  concrete: () => lambert('concrete', Tex.concrete),
  darkConcrete: () => lambert('darkConcrete', Tex.concrete, 0x555555),
  schoolWall: () => lambert('schoolWall', Tex.schoolWall),
  tileFloor: () => lambert('tileFloor', Tex.tileFloor),
  ceilingTile: () => lambert('ceilingTile', Tex.ceilingTile),
  woodDoor: () => lambert('woodDoor', Tex.woodDoor),
  steelDoor: () => lambert('steelDoor', Tex.steelDoor),
  shoji: () => lambert('shoji', Tex.shoji, 0xffffff, { emissive: 0x1c1c1a }),
  woodFloor: () => lambert('woodFloor', Tex.woodFloor),
  darkWood: () => lambert('darkWood', Tex.darkWood),
  subwayTile: () => lambert('subwayTile', Tex.subwayTile),
  wallpaper: () => lambert('wallpaper', Tex.wallpaper),
  carpet: () => lambert('carpet', Tex.carpet),
  vhsShelf: () => lambert('vhsShelf', Tex.vhsShelf),
  metal: () => lambert('metal', Tex.metal),
  locker: () => lambert('locker', Tex.locker),
  poster: () => lambert('poster', Tex.poster),
  posterBack: () => lambert('posterBack', Tex.posterBack),
  stain: (v: number) =>
    lambert(`stain:${v}`, () => Tex.stain(v), 0xffffff, {
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    }),
  /** 꺼진 / 켜진 브라운관 화면, 희미하게 불 켜진 창 */
  screenOff: () => basic('screenOff', 0x101010),
  screenOn: () => basic('screenOn', 0xe6e6e1),
  dimGlass: () => basic('dimGlass', 0x2e2e2c),
  clock: () => lambert('clock', Tex.clock, 0xffffff, { transparent: true, alphaTest: 0.1 }),
  darkMetal: () => lambert('darkMetal', null, 0x2a2a2a),
  plain: (v: number) => lambert(`plain:${v}`, null, v),
  black: () => basic('black', 0x000000),
  /** 벽·바닥에 붙이는 투명 자국 (손자국, 발자국) */
  decal: (name: 'handprints' | 'footprints') =>
    lambert(`decal:${name}`, Tex[name], 0xffffff, {
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    }),
  mailbox: () => lambert('mailbox', Tex.mailbox),
  label: (text: string, o: LabelOptions = {}) =>
    lambert(`labelmat:${text}:${JSON.stringify(o)}`, () => labelTex(text, o), 0xffffff, o.bg ? {} : { transparent: true, alphaTest: 0.1 }),
};
