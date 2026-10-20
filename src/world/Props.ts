import * as THREE from 'three';
import { Mat, rand } from './Textures';
import { SEG_H } from './Maze';

/**
 * 복도·교차로에 놓는 작은 사물과 여닫히는 문.
 * 모두 단순한 상자·원기둥이며 재질은 캐시된 공유 재질만 씁니다
 * (조각이 해제될 때 지오메트리만 정리하면 되도록).
 * 사물의 원점은 바닥, 앞면은 +z 방향입니다.
 */

export type PropKind = 'chair' | 'shoes' | 'bucket' | 'box' | 'umbrella' | 'stool';
export const LANDMARK_KINDS: PropKind[] = ['chair', 'shoes', 'bucket', 'box', 'umbrella', 'stool'];

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

export function makeProp(kind: PropKind): THREE.Group {
  const g = new THREE.Group();
  switch (kind) {
    case 'chair': {
      // 학교 의자: 앉으면 +z를 바라봄
      const metal = Mat.darkMetal();
      const wood = Mat.darkWood();
      g.add(box(0.42, 0.03, 0.4, wood, 0, 0.44, 0));
      for (const [x, z] of [[-0.19, -0.17], [0.19, -0.17], [-0.19, 0.17], [0.19, 0.17]]) {
        g.add(box(0.025, 0.44, 0.025, metal, x, 0.22, z));
      }
      g.add(box(0.025, 0.36, 0.025, metal, -0.19, 0.62, -0.18));
      g.add(box(0.025, 0.36, 0.025, metal, 0.19, 0.62, -0.18));
      g.add(box(0.42, 0.2, 0.025, wood, 0, 0.72, -0.19));
      break;
    }
    case 'shoes': {
      // 가지런히 놓인 흰 실내화 한 켤레
      const pale = Mat.plain(0xbdbdb8);
      for (const x of [-0.075, 0.075]) {
        g.add(box(0.095, 0.06, 0.25, pale, x, 0.03, 0));
        g.add(box(0.095, 0.05, 0.09, pale, x, 0.08, -0.08));
      }
      break;
    }
    case 'bucket': {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.3, 14, 1, true), Mat.metal());
      m.position.y = 0.15;
      g.add(m);
      const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.13, 14), Mat.black());
      bottom.rotation.x = -Math.PI / 2;
      bottom.position.y = 0.01;
      g.add(bottom);
      break;
    }
    case 'box': {
      g.add(box(0.46, 0.32, 0.36, Mat.plain(0x6a675f), 0, 0.16, 0));
      g.add(box(0.47, 0.012, 0.06, Mat.plain(0x9a9893), 0, 0.322, 0));
      break;
    }
    case 'umbrella': {
      // 벽에 기대 놓인 접힌 검은 우산
      const u = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.05, 0.7, 8), Mat.plain(0x1a1a1a));
      body.position.y = 0.42;
      const handle = box(0.02, 0.1, 0.02, Mat.darkWood(), 0, 0.82, 0);
      const tip = box(0.012, 0.07, 0.012, Mat.darkMetal(), 0, 0.035, 0);
      u.add(body, handle, tip);
      u.rotation.z = 0.22;
      g.add(u);
      break;
    }
    case 'stool': {
      const plastic = Mat.plain(0x8a8a86);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 14), plastic);
      top.position.y = 0.45;
      g.add(top);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const leg = box(0.03, 0.45, 0.03, plastic, Math.cos(a) * 0.12, 0.22, Math.sin(a) * 0.12);
        leg.rotation.z = Math.cos(a) * 0.08;
        leg.rotation.x = -Math.sin(a) * 0.08;
        g.add(leg);
      }
      break;
    }
  }
  return g;
}

export interface DoorUnit {
  group: THREE.Group;
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
}

/**
 * 벽에 붙은 여닫이 문. 로컬 좌표: 문은 z=0 평면, 앞면 +z, 가운데 x=0, 바닥 y=0.
 * 열리면 문짝이 살짝(20° 남짓) 벌어지고 그 뒤로 칠흑 같은 틈이 보입니다.
 * 문짝은 복도 이동 영역을 거의 침범하지 않도록 조금만 열립니다.
 */
export function makeSwingDoor(mat: THREE.Material, open: boolean, w = 0.95, h = 2.05): DoorUnit {
  const group = new THREE.Group();

  const closed = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  closed.position.set(0, h / 2, 0.02);

  const voidMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), Mat.black());
  voidMesh.position.set(0, h / 2, 0.01);

  const pivot = new THREE.Group();
  pivot.position.set(w / 2, 0, 0.03);
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), mat);
  leaf.position.set(-w / 2, h / 2, 0.02);
  pivot.add(leaf);
  pivot.rotation.y = rand(0.3, 0.42);

  group.add(closed, voidMesh, pivot);

  let state = open;
  const apply = () => {
    closed.visible = !state;
    voidMesh.visible = state;
    pivot.visible = state;
  };
  apply();
  return {
    group,
    isOpen: () => state,
    setOpen: (o: boolean) => {
      state = o;
      apply();
    },
  };
}

/**
 * 미닫이 벽장(후스마). 열리면 창호지 판이 옆으로 밀려나고 안쪽 어둠이 보입니다.
 */
export function makeSlidingCloset(w: number, open: boolean): DoorUnit {
  const group = new THREE.Group();
  const h = 1.9;
  const voidMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), Mat.black());
  voidMesh.position.set(0, h / 2, 0.01);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(w / 2, h, 0.03), Mat.shoji());
  panel.position.y = h / 2;
  const panel2 = new THREE.Mesh(new THREE.BoxGeometry(w / 2, h, 0.03), Mat.shoji());
  panel2.position.set(w / 4, h / 2, 0.035);
  group.add(voidMesh, panel, panel2);

  let state = open;
  const apply = () => {
    // 닫힘: 두 판이 틈을 덮음 / 열림: 한 판이 다른 판 앞으로 밀려 틈의 절반이 드러남
    panel.position.set(state ? w / 4 : -w / 4, h / 2, 0.025);
  };
  apply();
  return {
    group,
    isOpen: () => state,
    setOpen: (o: boolean) => {
      state = o;
      apply();
    },
  };
}

/** 브라운관 TV. 화면 재질을 바꿔 켜고 끔 */
export function makeTV(on: boolean): { group: THREE.Group; setOn: (on: boolean) => void } {
  const group = new THREE.Group();
  group.add(box(0.58, 0.48, 0.46, Mat.darkMetal(), 0, 0.24, 0));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.36), on ? Mat.screenOn() : Mat.screenOff());
  screen.position.set(0, 0.25, 0.235);
  group.add(screen);
  return {
    group,
    setOn: (o: boolean) => {
      screen.material = o ? Mat.screenOn() : Mat.screenOff();
    },
  };
}

/** 얼룩 한 장. 평면의 앞면(+z)이 보이는 쪽 */
export function makeStain(w: number, h: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), Mat.stain(Math.floor(Math.random() * 3)));
  m.renderOrder = 1;
  return m;
}

/** 천장 타일이 빠진 자리 (가끔 전선이 늘어져 있음) */
export function makeCeilingHole(): THREE.Group {
  const g = new THREE.Group();
  const s = rand(0.5, 0.62);
  const hole = new THREE.Mesh(new THREE.PlaneGeometry(s, s), Mat.black());
  hole.rotation.x = Math.PI / 2;
  hole.position.y = SEG_H - 0.004;
  g.add(hole);
  if (Math.random() < 0.45) {
    const len = rand(0.35, 0.9);
    g.add(box(0.012, len, 0.012, Mat.darkMetal(), rand(-s / 3, s / 3), SEG_H - len / 2, rand(-s / 3, s / 3)));
  }
  return g;
}
