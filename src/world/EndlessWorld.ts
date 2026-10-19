import * as THREE from 'three';
import { SoundManager } from '../audio/SoundManager';
import { GhostFigure, GhostPose } from './GhostFigure';
import { Mat, Tex, pick, rand } from './Textures';

export type ZoneKind = 'school' | 'apt404' | 'tatami' | 'video' | 'subway';

interface ZoneMeta {
  kind: ZoneKind;
  name: string;
  whisper: string;
}

const ZONES: ZoneMeta[] = [
  {
    kind: 'school',
    name: '폐교 5층 복도',
    whisper: '[4시 44분에 멈춘 복도… 끝이 보이지 않는다]',
  },
  {
    kind: 'apt404',
    name: '404호 복도',
    whisper: '[문마다 부적이 덕지덕지 붙어 있다…]',
  },
  {
    kind: 'tatami',
    name: '3층 다다미 복도',
    whisper: '[마룻바닥이 발밑에서 길게 신음한다…]',
  },
  {
    kind: 'video',
    name: '지하 비디오 대여점',
    whisper: '[치지직거리는 흑백 주사선 불빛이 바닥을 적신다]',
  },
  {
    kind: 'subway',
    name: '심야 환승통로',
    whisper: '[내 발소리가 반 박자 늦게 뒤에서 따라 울린다…]',
  },
];

const SEG_LEN = 18; // 각 구간 길이 (m)
const SEG_W = 3.2;  // 복도 폭 (m)
const SEG_H = 3.1;  // 천장 높이 (m)

interface SegmentGhost {
  figure: GhostFigure;
  behavior: 'watcher' | 'glacial' | 'peeker' | 'corner' | 'crt_crawler';
  speed: number;
  triggeredSound: boolean;
  vanished: boolean;
  initialX: number;
}

interface WorldSegment {
  index: number;
  zone: ZoneKind;
  zStart: number; // +Z 쪽 경계 (index * -SEG_LEN)
  zEnd: number;   // -Z 쪽 경계 ((index + 1) * -SEG_LEN)
  group: THREE.Group;
  lights: {
    point: THREE.PointLight;
    fixtureMat: THREE.MeshBasicMaterial;
    baseIntensity: number;
    flickerSeed: number;
    dead: boolean;
  }[];
  ghosts: SegmentGhost[];
  entered: boolean;
}

/**
 * 엘리베이터나 게임 목표 없이, 5개의 공포 공간이 문과 통로를 통해
 * 앞뒤로 끝없이 이어지는 탈출 불가능한 세계 생성기.
 */
export class EndlessWorld {
  private scene: THREE.Scene;
  private sound: SoundManager;
  private segments = new Map<number, WorldSegment>();
  private currentSegIndex = 0;
  private zoneSequenceIdx = 0;

  // 뒤돌아볼 때 등 뒤에 나타나는 그림자 (장산범/미행자)
  private stalker: GhostFigure;
  private stalkerActive = false;
  private stalkerTimer = 0;

  // 화면 왜곡/암전 연출 상태 (main.ts의 MonochromeShader에 전달)
  public visualDistort = 0;
  public visualBrightness = 1.0;

  private ambientEventTimer = 6;
  private footstepEchoTimer = 0;
  private onZoneWhisper?: (text: string) => void;

  constructor(
    scene: THREE.Scene,
    sound: SoundManager,
    onZoneWhisper?: (text: string) => void
  ) {
    this.scene = scene;
    this.sound = sound;
    this.onZoneWhisper = onZoneWhisper;

    // 등 뒤 미행자 초기화
    this.stalker = new GhostFigure('standing');
    this.stalker.root.visible = false;
    this.scene.add(this.stalker.root);

    // 초기 구간 생성 (-1 ~ 3)
    for (let idx = -1; idx <= 3; idx++) {
      this.ensureSegment(idx);
    }
  }

  private pickZoneForIndex(index: number): ZoneKind {
    // 2구간마다 자연스럽게 다른 층/공간으로 변이하여 끝없이 연결됨
    const cycle = Math.abs(Math.floor(index / 2)) % ZONES.length;
    return ZONES[cycle].kind;
  }

  private ensureSegment(index: number): void {
    if (this.segments.has(index)) return;
    const zone = this.pickZoneForIndex(index);
    const seg = this.buildSegment(index, zone);
    this.segments.set(index, seg);
    this.scene.add(seg.group);
  }

  private disposeSegment(seg: WorldSegment): void {
    this.scene.remove(seg.group);
    seg.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
  }

  private buildSegment(index: number, zone: ZoneKind): WorldSegment {
    const group = new THREE.Group();
    const zStart = -index * SEG_LEN;
    const zEnd = -(index + 1) * SEG_LEN;
    group.position.set(0, 0, zStart);

    const lights: WorldSegment['lights'] = [];
    const ghosts: SegmentGhost[] = [];

    // 구간별 기본 벽/바닥/천장 머티리얼 선택
    const wallMat =
      zone === 'school'
        ? Mat.schoolWall()
        : zone === 'apt404'
          ? Mat.wallpaper()
          : zone === 'tatami'
            ? Mat.shoji()
            : zone === 'subway'
              ? Mat.subwayTile()
              : Mat.darkConcrete();

    const floorMat =
      zone === 'school'
        ? Mat.tileFloor()
        : zone === 'apt404'
          ? Mat.carpet()
          : zone === 'tatami'
            ? Mat.woodFloor()
            : Mat.concrete();

    const ceilMat =
      zone === 'tatami' ? Mat.darkWood() : Mat.ceilingTile();

    // 바닥 & 천장
    const floorGeo = new THREE.PlaneGeometry(SEG_W, SEG_LEN);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -SEG_LEN / 2);
    group.add(floor);

    const ceilGeo = new THREE.PlaneGeometry(SEG_W, SEG_LEN);
    const ceil = new THREE.Mesh(ceilGeo, ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, SEG_H, -SEG_LEN / 2);
    group.add(ceil);

    // 좌우 벽
    const wallGeo = new THREE.PlaneGeometry(SEG_LEN, SEG_H);
    const leftWall = new THREE.Mesh(wallGeo, wallMat);
    leftWall.rotation.y = Math.PI / 2;
    leftWall.position.set(-SEG_W / 2, SEG_H / 2, -SEG_LEN / 2);
    group.add(leftWall);

    const rightWall = new THREE.Mesh(wallGeo, wallMat);
    rightWall.rotation.y = -Math.PI / 2;
    rightWall.position.set(SEG_W / 2, SEG_H / 2, -SEG_LEN / 2);
    group.add(rightWall);

    // 구간 경계마다 답답한 문틀(Threshold Partition) 배치 — 복도가 끝없이 다른 공간으로 이어지는 느낌
    this.buildThresholdDoorway(group, -SEG_LEN);

    // 천장 형광등 (구간당 2개, 두 번째 등은 자주 깜빡이거나 꺼져 있음)
    const lightZPositions = [-SEG_LEN * 0.28, -SEG_LEN * 0.76];
    lightZPositions.forEach((lz, i) => {
      const fixtureMat = new THREE.MeshBasicMaterial({ color: 0xd8d8d2 });
      const tube = new THREE.Mesh(
        new THREE.BoxGeometry(0.65, 0.04, 0.14),
        fixtureMat
      );
      tube.position.set(0, SEG_H - 0.03, lz);
      group.add(tube);

      const isDim = i === 1 && Math.random() < 0.75;
      const baseIntensity = isDim ? 0.55 : 1.15;
      const point = new THREE.PointLight(0xffffff, baseIntensity, 9.5, 1.9);
      point.position.set(0, SEG_H - 0.18, lz);
      group.add(point);

      lights.push({
        point,
        fixtureMat,
        baseIntensity,
        flickerSeed: Math.random() * 100,
        dead: false,
      });
    });

    // 공간별 디테일 소품 조립
    this.populateZoneDetails(group, zone);

    // 첫 시작 구간(index === 0)의 앞부분만 살짝 비워두고, 모든 구간에 기괴한 형체 배치
    if (index !== 0) {
      this.spawnSegmentGhost(group, zone, ghosts);
    } else {
      // 시작 구간에서도 저 멀리 안개 끝에 서 있는 실루엣 하나 배치
      const watcher = new GhostFigure('standing');
      watcher.root.position.set(0, 0, -SEG_LEN + 2.2);
      group.add(watcher.root);
      ghosts.push({
        figure: watcher,
        behavior: 'watcher',
        speed: 0,
        triggeredSound: false,
        vanished: false,
        initialX: 0,
      });
    }

    return {
      index,
      zone,
      zStart,
      zEnd,
      group,
      lights,
      ghosts,
      entered: index === 0,
    };
  }

  /**
   * 구간과 구간 사이를 잇는 좁은 문틀과 반쯤 열린 문짝.
   * 엘리베이터 없이 걸어갈수록 학교 → 아파트 → 여관 → 비디오가게 → 지하철 통로가 기괴하게 직결됩니다.
   */
  private buildThresholdDoorway(group: THREE.Group, zLocal: number): void {
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

  private populateZoneDetails(group: THREE.Group, zone: ZoneKind): void {
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

  /**
   * 각 구간마다 공간 분위기에 맞는 기괴한 형체 배치.
   * 모든 움직임은 극도로 느리거나 미동도 하지 않으며, 만화적인 연출 없이 침묵과 실루엣으로 압박합니다.
   */
  private spawnSegmentGhost(
    group: THREE.Group,
    zone: ZoneKind,
    ghosts: SegmentGhost[]
  ): void {
    if (zone === 'school') {
      // 복도 끝 안개 속에서 고개를 꺾은 채 극도로 느리게 다가오거나 서 있는 소복 형체
      const fig = new GhostFigure('standing');
      const z = rand(-14.5, -10.5);
      fig.root.position.set(rand(-0.35, 0.35), 0, z);
      group.add(fig.root);
      ghosts.push({
        figure: fig,
        behavior: Math.random() < 0.55 ? 'glacial' : 'watcher',
        speed: rand(0.22, 0.36), // 극도로 느린 걸음
        triggeredSound: false,
        vanished: false,
        initialX: fig.root.position.x,
      });
    } else if (zone === 'apt404') {
      // 부적 붙은 복도 허공에 매달려 흔들리거나 문틈에서 고개만 내민 형체
      const isSuspended = Math.random() < 0.6;
      const fig = new GhostFigure(isSuspended ? 'suspended' : 'peeking');
      if (isSuspended) {
        fig.root.position.set(0, 0.25, -11.5);
        group.add(fig.root);
        ghosts.push({
          figure: fig,
          behavior: 'watcher',
          speed: 0,
          triggeredSound: false,
          vanished: false,
          initialX: 0,
        });
      } else {
        fig.root.position.set(-SEG_W / 2 + 0.35, 0, -10.2);
        group.add(fig.root);
        ghosts.push({
          figure: fig,
          behavior: 'peeker',
          speed: 0.35,
          triggeredSound: false,
          vanished: false,
          initialX: fig.root.position.x,
        });
      }
    } else if (zone === 'tatami') {
      // 천장 구석이나 반쯤 열린 벽장 틈에 웅크리고 박혀 있는 형체 (주온)
      const inCeilingCorner = Math.random() < 0.55;
      const fig = new GhostFigure('crouched');
      if (inCeilingCorner) {
        fig.root.position.set(SEG_W / 2 - 0.42, SEG_H - 1.15, -10.8);
        fig.root.rotation.z = 0.35;
      } else {
        fig.root.position.set(-SEG_W / 2 + 0.32, 0, -9.2);
        fig.root.rotation.y = Math.PI / 2;
      }
      group.add(fig.root);
      ghosts.push({
        figure: fig,
        behavior: 'corner',
        speed: 0,
        triggeredSound: false,
        vanished: false,
        initialX: fig.root.position.x,
      });
    } else if (zone === 'video') {
      // 우물과 TV 정적 앞에서 바닥을 기어오는 검은 머리카락 형체 (링)
      const fig = new GhostFigure('crawling');
      fig.root.position.set(0.1, 0, -12.0);
      group.add(fig.root);
      ghosts.push({
        figure: fig,
        behavior: 'crt_crawler',
        speed: 0.18, // 1초에 18cm씩 기어옴
        triggeredSound: false,
        vanished: false,
        initialX: 0.1,
      });
    } else if (zone === 'subway') {
      // 먼 통로 한가운데 서 있는 창백한 장신 실루엣 + 문틀 너머로 엿보는 형체
      const fig = new GhostFigure('standing');
      fig.root.scale.set(0.92, 1.16, 0.92); // 비정상적으로 키가 큰 실루엣
      fig.root.position.set(0, 0, -14.8);
      group.add(fig.root);
      ghosts.push({
        figure: fig,
        behavior: 'glacial',
        speed: 0.28,
        triggeredSound: false,
        vanished: false,
        initialX: 0,
      });
    }
  }

  /**
   * 매 프레임 플레이어 이동·충돌·무한 구간 생성·귀신 연출 업데이트
   */
  public update(
    dt: number,
    elapsed: number,
    playerPos: THREE.Vector3,
    cameraForward: THREE.Vector3,
    isMoving: boolean
  ): void {
    // 화면 왜곡/밝기 서서히 복구
    this.visualDistort = Math.max(0, this.visualDistort - dt * 1.4);
    this.visualBrightness += (1.0 - this.visualBrightness) * Math.min(1, dt * 3.5);

    // 1. 복도 좌우 벽 및 문틀(Threshold) 충돌 처리
    const halfW = SEG_W / 2 - 0.38;
    playerPos.x = Math.max(-halfW, Math.min(halfW, playerPos.x));

    // 문틀 부근(SEG_LEN 배수 지점)에서는 중앙 통로 폭(doorOpenW = 1.35m)으로 자연스럽게 유도
    const modZ = ((playerPos.z % SEG_LEN) + SEG_LEN) % SEG_LEN;
    if (modZ < 0.45 || modZ > SEG_LEN - 0.45) {
      const doorHalfW = 0.48;
      if (Math.abs(playerPos.x) > doorHalfW) {
        playerPos.x = Math.sign(playerPos.x) * doorHalfW;
      }
    }

    // 2. 현재 구간 인덱스 계산 및 앞뒤 무한 스트리밍
    const segIdx = Math.floor(-playerPos.z / SEG_LEN);
    if (segIdx !== this.currentSegIndex) {
      this.currentSegIndex = segIdx;
      this.zoneSequenceIdx++;
    }

    // 플레이어 앞뒤로 항상 구간이 존재하도록 보장 (앞으로 가든 뒤로 도망치든 끝없이 이어짐)
    for (let i = this.currentSegIndex - 2; i <= this.currentSegIndex + 3; i++) {
      this.ensureSegment(i);
    }

    // 멀어진 구간 메모리 해제 (뒤로 돌아갈 때 공간이 변이되도록 이전 구간도 재생성 대상이 됨)
    for (const [idx, seg] of this.segments.entries()) {
      if (idx < this.currentSegIndex - 2 || idx > this.currentSegIndex + 3) {
        this.disposeSegment(seg);
        this.segments.delete(idx);
      }
    }

    // 3. 새 구간 진입 시 분위기 속삭임 및 공간 음향 트리거
    const activeSeg = this.segments.get(this.currentSegIndex);
    if (activeSeg && !activeSeg.entered) {
      activeSeg.entered = true;
      const meta = ZONES.find((z) => z.kind === activeSeg.zone);
      if (meta && this.onZoneWhisper) {
        this.onZoneWhisper(meta.whisper);
      }
      this.triggerZoneEntrySound(activeSeg.zone, playerPos);
    }

    // 4. 등 뒤 미행자 (장산범 효과: 앞으로 걸을 때 뒤에서 젖은 발소리가 따라오고, 갑자기 뒤돌아보면 서 있음)
    this.updateBehindStalker(dt, elapsed, playerPos, cameraForward, isMoving);

    // 5. 각 구간의 조명 깜빡임 및 귀신 형체 업데이트
    for (const seg of this.segments.values()) {
      this.updateSegment(seg, dt, elapsed, playerPos, cameraForward);
    }

    // 6. 간헐적 불쾌한 환경음 (끼익거림, 목 딸깍임, 방울, 칠판 긁기)
    this.ambientEventTimer -= dt;
    if (this.ambientEventTimer <= 0) {
      this.ambientEventTimer = rand(7.5, 14.5);
      this.triggerRandomDreadAudio(playerPos, activeSeg?.zone ?? 'school');
    }
  }

  private triggerZoneEntrySound(zone: ZoneKind, playerPos: THREE.Vector3): void {
    const ahead = { x: 0, y: 1.5, z: playerPos.z - 8 };
    switch (zone) {
      case 'school':
        this.sound.playChalkScrape(ahead);
        break;
      case 'apt404':
        this.sound.playShamanBell(ahead);
        break;
      case 'tatami':
        this.sound.playDeathRattle(ahead);
        break;
      case 'video':
        this.sound.playVhsStatic(0.35);
        break;
      case 'subway':
        this.sound.playEerieHumOrWhisper(
          { x: 0, y: 1.6, z: playerPos.z + 3.5 },
          '[바로 등 뒤에서 누군가 내 숨소리를 따라 한다…]',
          true
        );
        break;
    }
  }

  private triggerRandomDreadAudio(playerPos: THREE.Vector3, zone: ZoneKind): void {
    const pos = {
      x: rand(-1.4, 1.4),
      y: rand(0.5, 2.2),
      z: playerPos.z + pick([-9, -6, 4.5, 7]),
    };
    const r = Math.random();
    if (r < 0.28) {
      this.sound.playCreak(pos, '[어둠 속에서 문이 혼자 끼익거린다…]');
    } else if (r < 0.52) {
      this.sound.playDeathRattle(pos);
    } else if (r < 0.75) {
      if (zone === 'apt404') {
        this.sound.playShamanBell(pos);
      } else if (zone === 'school') {
        this.sound.playChalkScrape(pos);
      } else {
        this.sound.playEerieHumOrWhisper(pos);
      }
    } else {
      // 순간 정적: 형광등 웅웅거림이 뚝 끊김
      this.sound.setSilenceCut(true);
      setTimeout(() => this.sound.setSilenceCut(false), 2200);
    }
  }

  private updateBehindStalker(
    dt: number,
    elapsed: number,
    playerPos: THREE.Vector3,
    cameraForward: THREE.Vector3,
    isMoving: boolean
  ): void {
    this.stalker.update(dt, elapsed);

    // 플레이어가 앞으로(-Z) 걷고 있을 때 간헐적으로 등 뒤에서 젖은 발소리가 반 박자 늦게 울림
    if (isMoving && cameraForward.z < -0.4) {
      this.footstepEchoTimer -= dt;
      if (this.footstepEchoTimer <= 0) {
        this.footstepEchoTimer = rand(1.8, 3.6);
        this.sound.playFootstep(true, {
          x: playerPos.x + rand(-0.2, 0.2),
          y: 0.1,
          z: playerPos.z + 3.2,
        });
      }
    }

    const lookingBackward = cameraForward.z > 0.55;

    if (!this.stalkerActive && !lookingBackward && Math.random() < dt * 0.08) {
      // 플레이어가 앞을 보고 있을 때 등 뒤 5.5m 거리에 소리 없이 배치
      this.stalkerActive = true;
      this.stalkerTimer = 6.5;
      this.stalker.root.position.set(playerPos.x * 0.5, 0, playerPos.z + 5.5);
      this.stalker.root.rotation.y = Math.PI; // 플레이어의 등을 바라봄
      this.stalker.root.visible = true;
    }

    if (this.stalkerActive) {
      this.stalkerTimer -= dt;
      // 플레이어가 뒤를 돌아보면 미동도 없이 서 있다가 불빛이 깜빡이며 사라짐
      if (lookingBackward) {
        this.visualDistort = Math.max(this.visualDistort, 0.12);
        if (this.stalkerTimer > 1.4) {
          this.stalkerTimer = 1.4;
          this.sound.playEerieHumOrWhisper(
            {
              x: this.stalker.root.position.x,
              y: 1.6,
              z: this.stalker.root.position.z,
            },
            '[뒤돌아본 복도 한가운데에 누군가 서 있다…]'
          );
        }
      }

      if (this.stalkerTimer <= 0) {
        this.stalkerActive = false;
        this.stalker.root.visible = false;
        if (lookingBackward) {
          this.visualBrightness = 0.15;
          this.visualDistort = 0.35;
        }
      }
    }
  }

  private updateSegment(
    seg: WorldSegment,
    dt: number,
    elapsed: number,
    playerPos: THREE.Vector3,
    cameraForward: THREE.Vector3
  ): void {
    // 1. 형광등 깜빡임 및 귀신 근처 전압 강하
    for (const l of seg.lights) {
      if (l.dead) {
        l.point.intensity = 0;
        l.fixtureMat.color.setHex(0x181818);
        continue;
      }
      const n =
        Math.sin(elapsed * 19 + l.flickerSeed) *
        Math.sin(elapsed * 43 + l.flickerSeed * 2.1);
      const drop = n > 0.82 ? 0.18 : n < -0.9 ? 0.45 : 1.0;
      l.point.intensity = l.baseIntensity * drop;
      const c = Math.floor(drop * 215);
      l.fixtureMat.color.setRGB(c / 255, c / 255, c / 255);
    }

    // 2. 구간 내 귀신 형체 업데이트
    for (const g of seg.ghosts) {
      if (g.vanished) continue;
      g.figure.update(dt, elapsed);

      const worldPos = new THREE.Vector3();
      g.figure.root.getWorldPosition(worldPos);
      const dist = worldPos.distanceTo(playerPos);

      // 플레이어를 향한 방향 회전 (corner/peeker 제외)
      if (g.behavior === 'glacial' || g.behavior === 'watcher' || g.behavior === 'crt_crawler') {
        const dx = playerPos.x - worldPos.x;
        const dz = playerPos.z - worldPos.z;
        g.figure.root.rotation.y = Math.atan2(dx, dz);
      }

      // 가까워질수록 주변 형광등이 어두워지고 화면 노이즈가 미세하게 증가
      if (dist < 6.5) {
        const proximity = 1 - dist / 6.5;
        this.visualDistort = Math.max(this.visualDistort, proximity * 0.16);
      }

      // 행동 패턴별 처리
      if (g.behavior === 'glacial' || g.behavior === 'crt_crawler') {
        if (dist < 14 && dist > 1.25) {
          // 극도로 느리고 무겁게 한 걸음씩 접근
          const dirZ = Math.sign(playerPos.z - worldPos.z);
          g.figure.root.position.z += dirZ * g.speed * dt;
        }
      } else if (g.behavior === 'peeker') {
        // 플레이어가 가까이 다가오거나 정면으로 응시하면 문틈 어둠 속으로 스르륵 숨음
        if (dist < 6.0 && cameraForward.z < -0.3) {
          g.figure.root.position.x -= g.speed * dt;
          if (!g.triggeredSound) {
            g.triggeredSound = true;
            this.sound.playCreak(
              { x: worldPos.x, y: 1.5, z: worldPos.z },
              '[문틈 너머의 시선이 어둠 속으로 미끄러져 들어간다…]'
            );
          }
          if (Math.abs(g.figure.root.position.x - g.initialX) > 0.65) {
            g.vanished = true;
            g.figure.root.visible = false;
          }
        }
      } else if (g.behavior === 'corner') {
        if (dist < 5.5 && !g.triggeredSound) {
          g.triggeredSound = true;
          this.sound.playDeathRattle({
            x: worldPos.x,
            y: worldPos.y + 1.2,
            z: worldPos.z,
          });
        }
      }

      // 게임오버 대신: 형체와 코앞(1.35m 이내)까지 마주치면
      // 순간적으로 모든 불이 꺼지고 VHS 화면이 찢어지며 형체가 사라지거나 등 뒤로 넘어감 (탈출 불가능한 악몽 연출)
      if (dist < 1.38) {
        g.vanished = true;
        g.figure.root.visible = false;
        this.visualBrightness = 0.04;
        this.visualDistort = 0.65;
        this.sound.playVhsStatic(0.45);
        this.sound.playDeathRattle({
          x: playerPos.x,
          y: 1.6,
          z: playerPos.z + 0.8,
        });
        // 해당 구간의 첫 번째 조명을 꺼뜨려 어둠 속에 남겨둠
        if (seg.lights[0]) {
          seg.lights[0].dead = true;
        }
      } else if (g.behavior === 'watcher' && dist < 3.6) {
        // 가만히 서서 지켜보던 형체는 플레이어가 다가오면 형광등이 한번 깜빡이는 순간 흔적도 없이 사라짐
        g.vanished = true;
        g.figure.root.visible = false;
        this.visualBrightness = 0.12;
        this.visualDistort = 0.32;
        this.sound.playFootstep(true, {
          x: playerPos.x,
          y: 0.1,
          z: playerPos.z + 1.8,
        });
      }
    }
  }
}
