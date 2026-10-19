import * as THREE from 'three';
import { Mat, rand } from './Textures';
import { DIRS, Dir, DOOR_WALL_Z, HALF, SEG_H, SEG_LEN, SEG_W, ZoneKind, edgeOpen } from './Maze';

/** 로컬 좌표의 형광등 위치와 세기 */
export interface FixtureSpec {
  x: number;
  y: number;
  z: number;
  base: number;
  mat: THREE.MeshBasicMaterial;
}

function wallMatFor(zone: ZoneKind): THREE.Material {
  return zone === 'school'
    ? Mat.schoolWall()
    : zone === 'apt404'
      ? Mat.wallpaper()
      : zone === 'tatami'
        ? Mat.shoji()
        : zone === 'subway'
          ? Mat.subwayTile()
          : Mat.darkConcrete();
}

function floorMatFor(zone: ZoneKind): THREE.Material {
  return zone === 'school'
    ? Mat.tileFloor()
    : zone === 'apt404'
      ? Mat.carpet()
      : zone === 'tatami'
        ? Mat.woodFloor()
        : Mat.concrete();
}

function ceilMatFor(zone: ZoneKind): THREE.Material {
  return zone === 'tatami' ? Mat.darkWood() : Mat.ceilingTile();
}

function addFixture(group: THREE.Group, out: FixtureSpec[], x: number, z: number, base: number): void {
  const mat = new THREE.MeshBasicMaterial({ color: 0xd8d8d2 });
  const tube = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.04, 0.14), mat);
  tube.position.set(x, SEG_H - 0.03, z);
  tube.userData.fixture = true;
  group.add(tube);
  out.push({ x, y: SEG_H - 0.18, z, base, mat });
}

/**
 * 복도 하나 (로컬 원점 = 소유 교차로 가장자리, 로컬 -z 방향으로 18m).
 * 반환된 group은 호출 측에서 월드 위치/회전을 지정합니다.
 */
export function buildCorridor(zone: ZoneKind, lightFull: number): { group: THREE.Group; fixtures: FixtureSpec[] } {
  const group = new THREE.Group();
  const fixtures: FixtureSpec[] = [];

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(SEG_W, SEG_LEN), floorMatFor(zone));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -SEG_LEN / 2);
  group.add(floor);

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(SEG_W, SEG_LEN), ceilMatFor(zone));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, SEG_H, -SEG_LEN / 2);
  group.add(ceil);

  const wallGeo = new THREE.PlaneGeometry(SEG_LEN, SEG_H);
  const wallMat = wallMatFor(zone);
  const leftWall = new THREE.Mesh(wallGeo, wallMat);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-HALF, SEG_H / 2, -SEG_LEN / 2);
  const rightWall = new THREE.Mesh(wallGeo.clone(), wallMat);
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.position.set(HALF, SEG_H / 2, -SEG_LEN / 2);
  group.add(leftWall, rightWall);

  buildThresholdDoorway(group, DOOR_WALL_Z);

  // 형광등 2개 (두 번째는 자주 흐리거나 꺼져 있음)
  addFixture(group, fixtures, 0, -SEG_LEN * 0.28, lightFull);
  addFixture(group, fixtures, 0, -SEG_LEN * 0.76, Math.random() < 0.75 ? lightFull * 0.45 : lightFull);

  populateZoneDetails(group, zone);
  return { group, fixtures };
}

/**
 * 교차로 (월드 좌표 중심 기준 로컬). 복도가 없는 방향은 벽으로 막음.
 */
export function buildJunction(i: number, j: number, zone: ZoneKind, lightFull: number): { group: THREE.Group; fixtures: FixtureSpec[] } {
  const group = new THREE.Group();
  const fixtures: FixtureSpec[] = [];

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(SEG_W, SEG_W), floorMatFor(zone));
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(SEG_W, SEG_W), ceilMatFor(zone));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = SEG_H;
  group.add(ceil);

  const wallMat = wallMatFor(zone);
  (Object.keys(DIRS) as Dir[]).forEach((dir) => {
    if (edgeOpen(i, j, dir)) return;
    const w = new THREE.Mesh(new THREE.PlaneGeometry(SEG_W, SEG_H), wallMat);
    const { di, dj } = DIRS[dir];
    w.position.set(di * HALF, SEG_H / 2, dj * HALF);
    // 벽이 교차로 안쪽을 보도록 회전
    w.rotation.y = Math.atan2(-di, -dj);
    group.add(w);
  });

  // 교차로 조명은 대체로 흐림. 가끔 완전히 꺼져 있는 교차로도 있음.
  const r = Math.random();
  if (r > 0.2) addFixture(group, fixtures, 0, 0, r > 0.7 ? lightFull * 0.7 : lightFull * 0.3);

  return { group, fixtures };
}

/**
 * 구간과 구간 사이를 잇는 좁은 문틀과 반쯤 열린 문짝.
 * 엘리베이터 없이 걸어갈수록 학교 → 아파트 → 여관 → 비디오가게 → 지하철 통로가 기괴하게 직결됩니다.
 */
export function buildThresholdDoorway(group: THREE.Group, zLocal: number): void {
  const doorOpenW = 1.35;
  const sideW = (SEG_W - doorOpenW) / 2;
  const doorH = 2.25;
  const topH = SEG_H - doorH;

  const frameMat = Mat.darkConcrete();

  const leftWall = new THREE.Mesh(
    new THREE.BoxGeometry(sideW, SEG_H, 0.28),
    frameMat
  );
  leftWall.position.set(-SEG_W / 2 + sideW / 2, SEG_H / 2, zLocal);

  const rightWall = new THREE.Mesh(
    new THREE.BoxGeometry(sideW, SEG_H, 0.28),
    frameMat
  );
  rightWall.position.set(SEG_W / 2 - sideW / 2, SEG_H / 2, zLocal);

  const lintel = new THREE.Mesh(
    new THREE.BoxGeometry(doorOpenW, topH, 0.28),
    frameMat
  );
  lintel.position.set(0, doorH + topH / 2, zLocal);

  // 반쯤 삐딱하게 열려 있는 낡은 문짝
  const ajarDoor = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, doorH - 0.04, 0.05),
    Mat.woodDoor()
  );
  ajarDoor.position.set(-doorOpenW / 2 + 0.22, doorH / 2, zLocal - 0.35);
  ajarDoor.rotation.y = 1.12;

  group.add(leftWall, rightWall, lintel, ajarDoor);
}

export function populateZoneDetails(group: THREE.Group, zone: ZoneKind): void {
  switch (zone) {
    case 'school': {
      // 교실 문, 검은 창문, 사물함, 4:44 시계
      for (const z of [-3.5, -9.0, -14.2]) {
        const door = new THREE.Mesh(
          new THREE.PlaneGeometry(0.95, 2.05),
          Mat.woodDoor()
        );
        door.rotation.y = Math.PI / 2;
        door.position.set(-SEG_W / 2 + 0.02, 1.025, z);
        group.add(door);

        // 복도 쪽 교실 창문 (안쪽은 칠흑 같은 어둠)
        const win = new THREE.Mesh(
          new THREE.PlaneGeometry(1.8, 0.95),
          Mat.black()
        );
        win.rotation.y = Math.PI / 2;
        win.position.set(-SEG_W / 2 + 0.02, 1.55, z - 2.1);
        group.add(win);
      }

      // 오른쪽 벽 사물함
      const locker = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 1.85, 3.6),
        Mat.locker()
      );
      locker.position.set(SEG_W / 2 - 0.22, 0.925, -7.5);
      group.add(locker);

      // 4시 44분 시계
      const clock = new THREE.Mesh(
        new THREE.PlaneGeometry(0.45, 0.45),
        Mat.clock()
      );
      clock.rotation.y = -Math.PI / 2;
      clock.position.set(SEG_W / 2 - 0.02, 2.45, -11.5);
      group.add(clock);
      break;
    }

    case 'apt404': {
      // 양옆으로 늘어선 철문들과 부적, '404' 호수판
      for (const z of [-3.2, -7.8, -12.4, -15.8]) {
        for (const side of [-1, 1]) {
          const door = new THREE.Mesh(
            new THREE.PlaneGeometry(0.95, 2.05),
            Mat.steelDoor()
          );
          door.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
          door.position.set(side * (SEG_W / 2 - 0.02), 1.025, z);
          group.add(door);

          // 호수판 (전부 404호)
          const plate = new THREE.Mesh(
            new THREE.PlaneGeometry(0.28, 0.12),
            Mat.label('404', { bg: '#1a1a1a', fg: '#d8d8d2', border: true })
          );
          plate.rotation.y = door.rotation.y;
          plate.position.set(side * (SEG_W / 2 - 0.03), 1.68, z);
          group.add(plate);

          // 문 위와 주변에 어지럽게 붙은 부적 조각들
          for (let t = 0; t < 4; t++) {
            const talisman = new THREE.Mesh(
              new THREE.PlaneGeometry(0.11, 0.26),
              Mat.label('勅令', { bg: '#bfbeb6', fg: '#111111', border: true })
            );
            talisman.rotation.y = door.rotation.y;
            talisman.rotation.z = rand(-0.25, 0.25);
            talisman.position.set(
              side * (SEG_W / 2 - 0.035),
              1.85 + rand(-0.25, 0.28),
              z + rand(-0.35, 0.35)
            );
            group.add(talisman);
          }
        }
      }
      break;
    }

    case 'tatami': {
      // 다다미 여관 기둥과 반쯤 열린 벽장(후스마) 어둠
      for (let z = -2.5; z > -SEG_LEN; z -= 3.5) {
        for (const side of [-1, 1]) {
          const pillar = new THREE.Mesh(
            new THREE.BoxGeometry(0.12, SEG_H, 0.12),
            Mat.darkWood()
          );
          pillar.position.set(side * (SEG_W / 2 - 0.06), SEG_H / 2, z);
          group.add(pillar);
        }
      }

      // 반쯤 열린 벽장 틈새 (칠흑 같은 내부)
      const closetVoid = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 1.9, 1.4),
        Mat.black()
      );
      closetVoid.position.set(-SEG_W / 2 + 0.03, 0.95, -9.2);
      group.add(closetVoid);
      break;
    }

    case 'video': {
      // 복도를 좁게 조여오는 양옆 VHS 비디오 진열장 + 바닥의 우물 테두리 + 브라운관 TV
      for (const z of [-4.0, -9.0, -14.0]) {
        for (const side of [-1, 1]) {
          const shelf = new THREE.Mesh(
            new THREE.BoxGeometry(0.45, 2.15, 3.2),
            Mat.vhsShelf()
          );
          shelf.position.set(side * (SEG_W / 2 - 0.24), 1.075, z);
          group.add(shelf);
        }
      }

      // 복도 한가운데 솟아 있는 돌 우물 테두리
      const well = new THREE.Mesh(
        new THREE.CylinderGeometry(0.62, 0.66, 0.68, 18, 1, true),
        Mat.darkConcrete()
      );
      well.position.set(0.35, 0.34, -11.2);
      group.add(well);

      const wellInside = new THREE.Mesh(
        new THREE.CircleGeometry(0.6, 16),
        Mat.black()
      );
      wellInside.rotation.x = -Math.PI / 2;
      wellInside.position.set(0.35, 0.66, -11.2);
      group.add(wellInside);

      // 바닥에 놓인 브라운관 TV (창백한 정적 빛 방출)
      const tvBox = new THREE.Mesh(
        new THREE.BoxGeometry(0.58, 0.48, 0.46),
        Mat.darkMetal()
      );
      tvBox.position.set(-0.45, 0.24, -13.2);
      tvBox.rotation.y = 0.25;
      group.add(tvBox);

      const tvScreen = new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.36),
        new THREE.MeshBasicMaterial({ color: 0xeaeae5 })
      );
      tvScreen.position.set(-0.45 + Math.sin(0.25) * 0.235, 0.25, -13.2 + Math.cos(0.25) * 0.235);
      tvScreen.rotation.y = 0.25;
      group.add(tvScreen);
      break;
    }

    case 'subway': {
      // 지하철 환승통로 안내판(출구 없음)과 얼굴 지워진 실종 전단지, 기둥
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 0.34, 0.08),
        Mat.label('← 환승통로 (출구 없음)', {
          w: 512,
          h: 128,
          bg: '#141414',
          fg: '#deded8',
          border: true,
        })
      );
      sign.position.set(0, 2.55, -6.5);
      group.add(sign);

      for (const z of [-4.5, -8.5, -13.0]) {
        const poster = new THREE.Mesh(
          new THREE.PlaneGeometry(0.42, 0.58),
          Mat.poster()
        );
        poster.rotation.y = Math.PI / 2;
        poster.position.set(-SEG_W / 2 + 0.02, 1.48, z);
        group.add(poster);
      }
      break;
    }
  }
}
