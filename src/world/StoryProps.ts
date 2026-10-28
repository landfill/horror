import * as THREE from 'three';
import type { SpotSpec } from './Anomalies';
import { HALF } from './Maze';
import { DOOR_MOTION_SEC, DoorUnit, makeProp, plane } from './Props';
import { Mat } from './Textures';

/** 문은 눈앞에서 천천히 열리고, 실내화는 시야 밖에서만 돌아서는 하나의 사건입니다. */
export function addRoom404Story(group: THREE.Group, door: DoorUnit, side: number, z: number): SpotSpec {
  door.setOpen(false);
  // 404호 문이 벌어진 틈 안쪽에만 두 눈이 드러납니다.
  door.setEyes?.(true);
  door.group.name = 'room404-door';
  door.group.userData.story = 'room404';
  door.group.userData.stage = 0;
  const towardCorridor = -side * Math.PI / 2;
  const shoes = makeProp('shoes');
  shoes.name = 'room404-slippers';
  shoes.userData.story = 'room404';
  // 문 바로 앞의 회전 궤적을 피하고, 문 옆 벽을 따라 가지런히 둠.
  const shoesZ = z + 0.85;
  shoes.position.set(side * (HALF - 0.26), 0, shoesZ);
  shoes.rotation.y = towardCorridor + Math.PI;
  group.add(shoes);

  return {
    x: side * (HALF - 0.55), z, kind: 'room404',
    animatedDoor: true,
    opening: true,
    motionDuration: DOOR_MOTION_SEC,
    update: (dt) => door.update?.(dt) ?? false,
    // 문짝 폭·열린 문 앞쪽·실내화의 회전 범위까지 검사합니다.
    safetyPoints: [
      { x: side * (HALF - 0.03), z: z - 0.55 },
      { x: side * (HALF - 0.03), z: z + 0.55 },
      { x: side * (HALF - 0.58), z: z - 0.55 },
      { x: side * (HALF - 0.58), z: z + 0.55 },
      // 문 옆으로 옮긴 실내화의 양 방향과 회전 영역도 시야 밖이어야 함.
      ...[-0.24, 0, 0.24].flatMap((dx) => [-0.24, 0, 0.24].map((dz) => ({
        x: shoes.position.x + dx, z: shoesZ + dz,
      }))),
    ],
    stages: [
      { apply: () => {
        if (door.animateTo) door.animateTo(true);
        else door.setOpen(true);
        door.group.userData.stage = 1;
      }, sound: 'creak', duration: DOOR_MOTION_SEC },
      { delay: 14, apply: () => {
        shoes.rotation.y = towardCorridor;
        door.group.userData.stage = 2;
      } },
    ],
  };
}

/**
 * 문으로 들어간 자국 옆에서, 문 밖으로 나오는 자국 두 쌍이 차례로 늘어납니다.
 * 평면 세 장과 공유 텍스처 한 장만 만들고 사건 중에는 visible만 변경합니다.
 */
export function addFootstepStory(group: THREE.Group, side: number, z: number): SpotSpec {
  const trail = new THREE.Group();
  trail.name = 'footsteps-trail';
  trail.userData.story = 'footsteps';
  trail.userData.stage = 0;
  const pair = (name: string, x: number, atZ: number, headingX: number, headingZ: number) => {
    const mesh = plane(0.65, 1.1, Mat.decal('footprintPair'));
    mesh.name = name;
    mesh.renderOrder = 1;
    mesh.rotation.x = -Math.PI / 2;
    // 회전 뒤 텍스처 위쪽(발끝)이 지정한 바닥 방향을 향합니다.
    mesh.rotation.z = Math.atan2(-headingX, -headingZ);
    mesh.position.set(x, 0.009, atZ);
    trail.add(mesh);
    return mesh;
  };
  pair('footsteps-incoming', side * 0.90, z - 0.62, side * 0.8, 0.6);
  const first = pair('footsteps-outgoing-1', side * 0.90, z + 0.62, -side * 0.8, 0.6);
  const second = pair('footsteps-outgoing-2', -side * 0.06, z + 1.34, -side * 0.8, 0.6);
  first.visible = second.visible = false;
  group.add(trail);

  // 전체 자국(숨겨진 다음 단계 포함)의 바닥 경계와 중앙을 함께 검사합니다.
  const safetyPoints: { x: number; z: number }[] = [];
  for (const mesh of [first, second]) {
    // 확대·회전된 평면 전체를 포함하는 경계(.635m, .59m)에 여유를 둠.
    for (const dx of [-0.65, 0, 0.65]) {
      for (const dz of [-0.61, 0, 0.61]) {
        safetyPoints.push({ x: mesh.position.x + dx, z: mesh.position.z + dz });
      }
    }
  }
  return {
    x: side * 0.90, z, kind: 'footsteps', safetyPoints,
    stages: [
      { apply: () => { first.visible = true; trail.userData.stage = 1; }, sound: 'wetstep' },
      { delay: 16, apply: () => { second.visible = true; trail.userData.stage = 2; } },
    ],
  };
}
