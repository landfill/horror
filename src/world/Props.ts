import * as THREE from 'three';
import { Mat, rand } from './Textures';
import { SEG_H } from './Maze';

/**
 * 복도·교차로에 놓는 작은 사물과 여닫히는 문.
 * 모두 단순한 상자·원기둥이며 재질은 캐시된 공유 재질만 씁니다
 * (조각이 해제될 때 지오메트리만 정리하면 되도록).
 * 사물의 원점은 바닥, 앞면은 +z 방향입니다.
 */

export type PropKind =
  | 'chair'
  | 'shoes'
  | 'bucket'
  | 'box'
  | 'umbrella'
  | 'stool'
  | 'extinguisher'
  | 'trashbin'
  | 'bag'
  | 'cart'
  | 'lantern'
  | 'doll';
export const LANDMARK_KINDS: PropKind[] = ['chair', 'shoes', 'bucket', 'box', 'umbrella', 'stool', 'bag'];

/**
 * 크기 1짜리 공유 지오메트리. 소품마다 새로 만들지 않고 scale로 크기를 맞춤
 * (끝없이 생성·해제되는 구간에서 지오메트리 생성·GPU 업로드를 줄임).
 * userData.shared가 붙은 지오메트리는 구간을 해제할 때 지우지 않음.
 */
function shared<T extends THREE.BufferGeometry>(g: T): T {
  g.userData.shared = true;
  return g;
}
const UNIT_BOX = shared(new THREE.BoxGeometry(1, 1, 1));
// 모바일 부담을 줄이려고 면 수를 적게: 원기둥 6각(24삼각형), 덩어리 20면체(20)
const UNIT_CYL = shared(new THREE.CylinderGeometry(0.5, 0.5, 1, 6));
const UNIT_BLOB = shared(new THREE.IcosahedronGeometry(0.5, 0));
const UNIT_PLANE = shared(new THREE.PlaneGeometry(1, 1));

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_BOX, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  return m;
}

function cyl(r: number, h: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_CYL, mat);
  m.scale.set(r * 2, h, r * 2);
  m.position.set(x, y, z);
  return m;
}

/** 공유 상자 (가로 w, 높이 h, 깊이 d). UV는 크기와 상관없이 면마다 0~1이라 텍스처도 예전과 같게 붙음 */
export function boxMesh(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_BOX, mat);
  m.scale.set(w, h, d);
  return m;
}

/** 공유 평면 (가로 w, 세로 h). 앞면 +z */
export function plane(w: number, h: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_PLANE, mat);
  m.scale.set(w, h, 1);
  return m;
}

interface SlipperParts {
  sole: THREE.BufferGeometry;
  insole: THREE.BufferGeometry;
  upper: THREE.BufferGeometry;
  upperMaterial: THREE.MeshLambertMaterial;
}
let slipperParts: SlipperParts | null = null;

/** 밑창·안창·뒤가 열린 갑피를 한 번 만들어 모든 실내화가 공유합니다. 앞쪽은 +z. */
function getSlipperParts(): SlipperParts {
  if (slipperParts) return slipperParts;
  const outline = new THREE.Shape();
  outline.moveTo(0, -0.155);
  outline.bezierCurveTo(-0.042, -0.155, -0.057, -0.139, -0.057, -0.108);
  outline.bezierCurveTo(-0.057, -0.061, -0.058, 0.016, -0.063, 0.068);
  outline.bezierCurveTo(-0.071, 0.122, -0.05, 0.155, 0, 0.155);
  outline.bezierCurveTo(0.05, 0.155, 0.071, 0.122, 0.063, 0.068);
  outline.bezierCurveTo(0.058, 0.016, 0.057, -0.061, 0.057, -0.108);
  outline.bezierCurveTo(0.057, -0.139, 0.042, -0.155, 0, -0.155);

  // 얇고 모서리가 둥근 고무 밑창. 0~18mm 높이로 바닥에 닿습니다.
  const sole = shared(new THREE.ExtrudeGeometry(outline, {
    curveSegments: 4, steps: 1, depth: 0.012,
    bevelEnabled: true, bevelSegments: 1, bevelSize: 0.003, bevelThickness: 0.003,
  }));
  sole.rotateX(Math.PI / 2);
  sole.translate(0, 0.015, 0);

  // 창 테두리보다 작은 어두운 안창. 뒤꿈치 쪽은 갑피로 덮지 않습니다.
  const insole = shared(new THREE.ShapeGeometry(outline, 4));
  insole.scale(0.86, 0.93, 1);
  insole.rotateX(-Math.PI / 2);
  insole.rotateY(Math.PI);
  insole.translate(0, 0.019, 0);

  // 발등을 덮는 낮은 곡면. 뒷면을 막지 않고 안쪽 면까지 만들어 실제 빈 입구를 남깁니다.
  const rows = [
    { z: -0.035, width: 0.057, height: 0.074 },
    { z: 0.012, width: 0.061, height: 0.078 },
    { z: 0.065, width: 0.062, height: 0.072 },
    { z: 0.112, width: 0.054, height: 0.048 },
    { z: 0.142, width: 0.027, height: 0.020 },
    { z: 0.151, width: 0.006, height: 0.005 },
  ];
  const segments = 8;
  const stride = segments + 1;
  const surfaceSize = rows.length * stride;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let inner = 0; inner < 2; inner++) {
    for (let row = 0; row < rows.length; row++) {
      const r = rows[row];
      const width = r.width - inner * 0.003;
      const height = r.height - inner * 0.003;
      for (let j = 0; j <= segments; j++) {
        const angle = (j / segments) * Math.PI;
        positions.push(-width * Math.cos(angle), 0.019 + height * Math.sin(angle), r.z);
        // 입구 테두리와 발등의 접힌 부분은 조금 때가 탄 색, 내부는 어둡게.
        const shade = inner ? 0.28 : row === 0 ? 0.72 : row === 2 ? 0.86 : 1;
        colors.push(shade, shade, shade);
      }
    }
    const offset = inner * surfaceSize;
    for (let row = 0; row < rows.length - 1; row++) {
      for (let j = 0; j < segments; j++) {
        const a = offset + row * stride + j;
        const b = a + stride;
        if (inner) indices.push(a, a + 1, b, a + 1, b + 1, b);
        else indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  // 입구는 곡면 테두리만 연결하고 가운데를 비워 둡니다.
  for (let j = 0; j < segments; j++) {
    indices.push(j, j + 1, surfaceSize + j, j + 1, surfaceSize + j + 1, surfaceSize + j);
  }
  // 발가락 끝은 닫혀 있지만 뒤꿈치는 열려 있는 실내화 형태.
  const cap = positions.length / 3;
  positions.push(0, 0.019, rows[rows.length - 1].z);
  colors.push(1, 1, 1);
  const front = (rows.length - 1) * stride;
  for (let j = 0; j < segments; j++) indices.push(cap, front + j + 1, front + j);
  const upper = shared(new THREE.BufferGeometry());
  upper.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  upper.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  upper.setIndex(indices);
  upper.computeVertexNormals();
  slipperParts = {
    sole, insole, upper,
    upperMaterial: new THREE.MeshLambertMaterial({ color: 0xc8c6bc, vertexColors: true }),
  };
  return slipperParts;
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
      const parts = getSlipperParts();
      for (const x of [-0.087, 0.087]) {
        const slipper = new THREE.Group();
        slipper.name = x < 0 ? 'slipper-left' : 'slipper-right';
        slipper.position.x = x;
        const sole = new THREE.Mesh(parts.sole, Mat.plain(0x96958d));
        sole.name = 'slipper-sole';
        const insole = new THREE.Mesh(parts.insole, Mat.plain(0x59574f));
        insole.name = 'slipper-insole';
        const upper = new THREE.Mesh(parts.upper, parts.upperMaterial);
        upper.name = 'slipper-upper';
        slipper.add(sole, insole, upper);
        g.add(slipper);
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
    case 'extinguisher': {
      // 벽 앞 바닥에 세워 둔 소화기 (원기둥 하나)
      g.add(cyl(0.08, 0.5, Mat.plain(0x4c4c4a), 0, 0.25, 0));
      break;
    }
    case 'trashbin': {
      // 뚜껑 덮인 둥근 쓰레기통 (원기둥 하나)
      g.add(cyl(0.22, 0.72, Mat.metal(), 0, 0.36, 0));
      break;
    }
    case 'bag': {
      // 묶어 둔 검은 쓰레기봉투
      const bag = new THREE.Mesh(UNIT_BLOB, Mat.plain(0x161616));
      bag.scale.set(rand(0.4, 0.5), rand(0.32, 0.42), rand(0.36, 0.46));
      bag.position.y = bag.scale.y / 2 - 0.02;
      bag.rotation.y = rand(0, Math.PI);
      g.add(bag);
      break;
    }
    case 'cart': {
      // 비디오 반납 카트: 몸통, 위에 쌓인 테이프, 바퀴 받침
      g.add(box(0.5, 0.55, 0.8, Mat.darkMetal(), 0, 0.42, 0));
      g.add(box(0.42, 0.1, 0.7, Mat.vhsShelf(), 0, 0.745, 0));
      g.add(box(0.46, 0.06, 0.76, Mat.plain(0x1a1a1a), 0, 0.06, 0));
      break;
    }
    case 'lantern': {
      // 천장에 붙여 매단 종이 등 (원점이 천장, 메시 하나)
      g.add(cyl(0.17, 0.42, Mat.shoji(), 0, -0.25, 0));
      break;
    }
    case 'doll': {
      // 벽에 기대 앉은 일본 인형: 기모노 몸통, 창백한 얼굴, 검은 단발
      g.add(box(0.24, 0.26, 0.16, Mat.plain(0x2e2c2a), 0, 0.13, 0));
      const head = new THREE.Mesh(UNIT_BLOB, Mat.plain(0xd2d1cb));
      head.scale.setScalar(0.15);
      head.position.set(0, 0.34, 0.01);
      g.add(head);
      g.add(box(0.17, 0.16, 0.12, Mat.plain(0x0c0c0c), 0, 0.37, -0.025));
      break;
    }
  }
  return g;
}

export interface DoorUnit {
  group: THREE.Group;
  /** 애니메이션 중에는 도달할 목표 상태를 반환합니다. */
  isOpen: () => boolean;
  /** 생성·초기 배치용: 움직임 없이 즉시 적용합니다. */
  setOpen: (open: boolean) => void;
  animateTo?: (open: boolean) => void;
  /** 움직이는 동안 true, 목표에 도달하면 false. */
  update?: (dt: number) => boolean;
  isMoving?: () => boolean;
  /** 문 뒤의 두 눈. 필요한 문에서만 처음 한 번 생성하며, 이후에는 표시 상태만 바꿉니다. */
  setEyes?: (enabled: boolean) => void;
}

export const DOOR_MOTION_SEC = 2.8;

let doorEyeGeometry: THREE.BufferGeometry | null = null;

/** 얼굴 없이 눈의 윤곽·검은 동공·작은 반사점만 가진 공유 평면 지오메트리. */
function getDoorEyeGeometry(): THREE.BufferGeometry {
  if (doorEyeGeometry) return doorEyeGeometry;
  const outline = new THREE.Shape();
  outline.moveTo(-0.028, 0);
  outline.quadraticCurveTo(0, 0.018, 0.028, 0);
  outline.quadraticCurveTo(0, -0.014, -0.028, 0);
  const pupilHole = new THREE.Path();
  pupilHole.absellipse(0, 0, 0.0037, 0.0058, 0, Math.PI * 2, true, 0);
  outline.holes.push(pupilHole);

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const append = (geometry: THREE.BufferGeometry, tint: number) => {
    const offset = positions.length / 3;
    const position = geometry.getAttribute('position');
    const color = new THREE.Color(tint);
    for (let i = 0; i < position.count; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      colors.push(color.r, color.g, color.b);
    }
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(offset + index.getX(i));
    } else {
      for (let i = 0; i < position.count; i++) indices.push(offset + i);
    }
    geometry.dispose();
  };
  append(new THREE.ShapeGeometry(outline, 8), 0x8d8d87);
  // 동공 자리에는 흰 면을 만들지 않아 투명도 변화 때도 검게 남습니다.
  const pupil = new THREE.CircleGeometry(1, 16);
  pupil.scale(0.0037, 0.0058, 1);
  append(pupil, 0x080808);
  const catchlight = new THREE.CircleGeometry(0.0011, 6);
  catchlight.translate(-0.0012, 0.0022, 0.0006);
  append(catchlight, 0xb7b7b1);
  doorEyeGeometry = shared(new THREE.BufferGeometry());
  doorEyeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  doorEyeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  doorEyeGeometry.setIndex(indices);
  doorEyeGeometry.computeVertexNormals();
  return doorEyeGeometry;
}

/** 문 종류와 관계없이 같은 속도로 천천히 출발하고 멈춥니다. */
function doorMotion(group: THREE.Group, open: boolean, apply: (progress: number) => void): DoorUnit {
  let state = open;
  let progress = open ? 1 : 0;
  let from = progress;
  let target = progress;
  let elapsed = 0;
  let moving = false;
  apply(progress);
  return {
    group,
    isOpen: () => state,
    isMoving: () => moving,
    setOpen: (next) => {
      state = next;
      progress = from = target = next ? 1 : 0;
      elapsed = 0;
      moving = false;
      apply(progress);
    },
    animateTo: (next) => {
      const nextTarget = next ? 1 : 0;
      if (nextTarget === target && moving) return;
      state = next;
      from = progress;
      target = nextTarget;
      elapsed = 0;
      moving = from !== target;
    },
    update: (dt) => {
      if (!moving || !Number.isFinite(dt) || dt <= 0) return moving;
      elapsed = Math.min(DOOR_MOTION_SEC, elapsed + dt);
      const t = elapsed / DOOR_MOTION_SEC;
      const eased = t * t * (3 - 2 * t);
      progress = THREE.MathUtils.lerp(from, target, eased);
      apply(progress);
      moving = elapsed < DOOR_MOTION_SEC;
      return moving;
    },
  };
}

/**
 * 벽에 붙은 여닫이 문. 로컬 좌표: 문은 z=0 평면, 앞면 +z, 가운데 x=0, 바닥 y=0.
 * 열리면 문짝이 살짝(20° 남짓) 벌어지고 그 뒤로 칠흑 같은 틈이 보입니다.
 * 문짝은 복도 이동 영역을 거의 침범하지 않도록 조금만 열립니다.
 */
export function makeSwingDoor(mat: THREE.Material, open: boolean, w = 0.95, h = 2.05): DoorUnit {
  const group = new THREE.Group();

  const voidMesh = plane(w, h, Mat.black());
  voidMesh.position.set(0, h / 2, 0.01);

  const pivot = new THREE.Group();
  pivot.name = 'door-hinge';
  pivot.position.set(w / 2, 0, 0.03);
  const leaf = boxMesh(w, h, 0.04, mat);
  leaf.name = 'door-leaf';
  leaf.position.set(-w / 2, h / 2, 0.02);
  pivot.add(leaf);
  const openAngle = rand(0.3, 0.42);

  let openness = open ? 1 : 0;
  let eyesEnabled = false;
  let eyes: THREE.Group | null = null;
  let eyeMaterial: THREE.MeshBasicMaterial | null = null;
  const updateEyes = () => {
    if (!eyes || !eyeMaterial) return;
    const reveal = eyesEnabled ? THREE.MathUtils.smoothstep(openness, 0.45, 0.95) : 0;
    eyes.visible = reveal > 0;
    eyeMaterial.opacity = reveal * 0.72;
  };

  // 닫힌 평면과 열린 문짝을 교체하지 않고 같은 문짝을 경첩 중심으로 회전합니다.
  group.add(voidMesh, pivot);
  const motion = doorMotion(group, open, (progress) => {
    openness = progress;
    pivot.rotation.y = openAngle * progress;
    // 닫힌 문 뒤의 완전히 가려진 배경은 드로콜을 쓰지 않게 합니다.
    voidMesh.visible = progress > 0;
    updateEyes();
  });
  return {
    ...motion,
    setEyes: (enabled) => {
      eyesEnabled = enabled;
      if (enabled && !eyes) {
        eyes = new THREE.Group();
        eyes.name = 'door-eyes';
        // 검은 배경(z=.01) 앞, 실제 문짝(z>=.03) 뒤. 문짝과 벽이 눈을 가립니다.
        eyes.position.set(-w * 0.3, Math.min(1.55, h - 0.4), 0.017);
        eyeMaterial = new THREE.MeshBasicMaterial({
          vertexColors: true, transparent: true, opacity: 0,
          depthTest: true, depthWrite: false, fog: true,
        });
        eyeMaterial.name = 'door-eyes-material';
        for (let i = 0; i < 2; i++) {
          const eye = new THREE.Mesh(getDoorEyeGeometry(), eyeMaterial);
          eye.name = i === 0 ? 'door-eye-left' : 'door-eye-right';
          // 어둠 속에서도 두 눈의 형태를 읽을 수 있도록 크기와 간격을 함께 확대.
          eye.scale.set(2, 2, 1);
          eye.position.x = i === 0 ? -0.084 : 0.084;
          // 두 메시가 같은 문 전용 재질을 공유하므로 해제 책임은 하나에만 둡니다.
          if (i === 0) eye.userData.disposeMaterial = true;
          eyes.add(eye);
        }
        group.add(eyes);
      }
      updateEyes();
    },
  };
}

/**
 * 미닫이 벽장(후스마). 열리면 창호지 판이 옆으로 밀려나고 안쪽 어둠이 보입니다.
 */
export function makeSlidingCloset(w: number, open: boolean): DoorUnit {
  const group = new THREE.Group();
  const h = 1.9;
  const voidMesh = plane(w, h, Mat.black());
  voidMesh.position.set(0, h / 2, 0.01);
  const panel = boxMesh(w / 2, h, 0.03, Mat.shoji());
  panel.name = 'closet-moving-panel';
  panel.position.y = h / 2;
  const panel2 = boxMesh(w / 2, h, 0.03, Mat.shoji());
  panel2.position.set(w / 4, h / 2, 0.035);
  group.add(voidMesh, panel, panel2);

  return doorMotion(group, open, (progress) => {
    // 닫힘: 두 판이 틈을 덮음 / 열림: 한 판이 다른 판 앞으로 밀려 틈의 절반이 드러남
    panel.position.set(THREE.MathUtils.lerp(-w / 4, w / 4, progress), h / 2, 0.025);
  });
}

/** 브라운관 TV. 화면 재질을 바꿔 켜고 끔 */
export function makeTV(on: boolean): { group: THREE.Group; setOn: (on: boolean) => void } {
  const group = new THREE.Group();
  group.add(box(0.58, 0.48, 0.46, Mat.darkMetal(), 0, 0.24, 0));
  const screen = plane(0.46, 0.36, on ? Mat.screenOn() : Mat.screenOff());
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
  const m = plane(w, h, Mat.stain(Math.floor(Math.random() * 3)));
  m.renderOrder = 1;
  return m;
}

/** 천장 타일이 빠진 자리 (가끔 전선이 늘어져 있음) */
export function makeCeilingHole(): THREE.Group {
  const g = new THREE.Group();
  const s = rand(0.5, 0.62);
  const hole = plane(s, s, Mat.black());
  hole.rotation.x = Math.PI / 2;
  hole.position.y = SEG_H - 0.004;
  g.add(hole);
  if (Math.random() < 0.45) {
    const len = rand(0.35, 0.9);
    g.add(box(0.012, len, 0.012, Mat.darkMetal(), rand(-s / 3, s / 3), SEG_H - len / 2, rand(-s / 3, s / 3)));
  }
  return g;
}
