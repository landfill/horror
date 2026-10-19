import * as THREE from 'three';
import { Tex, rand } from './Textures';

export type GhostPose = 'standing' | 'peeking' | 'crouched' | 'crawling' | 'suspended';

/**
 * 장난스러운 눈알·이빨 지오메트리를 완전히 배제하고,
 * 동양 공포(회로·링·주온) 특유의 '실루엣, 젖은 머리카락 장막, 기괴하게 꺾인 목,
 * 얼굴 자리에 패인 칠흑 같은 어둠'만으로 불쾌한 공포감을 만드는 형체 생성기.
 */
export class GhostFigure {
  public readonly root = new THREE.Group();
  public readonly pose: GhostPose;

  private headGroup = new THREE.Group();
  private torsoGroup = new THREE.Group();
  private leftArm = new THREE.Group();
  private rightArm = new THREE.Group();
  private hairStrands: THREE.Mesh[] = [];
  private baseNeckRoll = 0;
  private baseNeckPitch = 0.38;
  private phase = Math.random() * Math.PI * 2;

  constructor(pose: GhostPose = 'standing') {
    this.pose = pose;
    this.buildMesh();
    this.applyPoseConfig(pose);
  }

  private buildMesh(): void {
    const dressMat = new THREE.MeshLambertMaterial({
      map: Tex.dress(),
      color: 0xd8d8d2,
      side: THREE.DoubleSide,
    });

    const darkInnerMat = new THREE.MeshBasicMaterial({
      color: 0x020202,
      side: THREE.DoubleSide,
    });

    const paleSkinMat = new THREE.MeshLambertMaterial({
      map: Tex.skin(),
      color: 0x8e908c,
    });

    const hairMat = new THREE.MeshLambertMaterial({
      map: Tex.hair(),
      color: 0x050505,
      transparent: true,
      alphaTest: 0.18,
      side: THREE.DoubleSide,
    });

    const solidHairMat = new THREE.MeshBasicMaterial({
      color: 0x030303,
      side: THREE.DoubleSide,
    });

    // 1. 치마/소복 하체 (불규칙한 주름과 비대칭 처짐이 있는 젖은 천)
    const skirtGeo = new THREE.CylinderGeometry(0.14, 0.34, 1.38, 18, 12, true);
    const sPos = skirtGeo.attributes.position;
    for (let i = 0; i < sPos.count; i++) {
      const vx = sPos.getX(i);
      const vy = sPos.getY(i);
      const vz = sPos.getZ(i);
      const angle = Math.atan2(vz, vx);
      const t = (vy + 0.69) / 1.38; // 0(바닥) ~ 1(허리)
      const fold =
        Math.sin(angle * 7) * 0.025 * (1 - t * 0.5) +
        Math.cos(angle * 13) * 0.012;
      const sway = Math.sin(t * Math.PI) * 0.015;
      sPos.setX(i, vx * (1 + fold) + sway);
      sPos.setZ(i, vz * (1 + fold));
      if (t < 0.08) {
        // 해진 밑단
        sPos.setY(i, vy + Math.sin(angle * 11) * 0.025);
      }
    }
    skirtGeo.computeVertexNormals();

    const skirt = new THREE.Mesh(skirtGeo, dressMat);
    skirt.position.y = 0.69;
    this.torsoGroup.add(skirt);

    // 치마 안쪽 칠흑 같은 어둠 코어 (틈새로 속이 비어 보이지 않게)
    const innerCore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.27, 1.32, 10),
      darkInnerMat
    );
    innerCore.position.y = 0.67;
    this.torsoGroup.add(innerCore);

    // 2. 비정상적으로 마르고 굽은 상체 (저고리)
    const chestGeo = new THREE.CylinderGeometry(0.15, 0.13, 0.48, 14, 4);
    const cPos = chestGeo.attributes.position;
    for (let i = 0; i < cPos.count; i++) {
      const vy = cPos.getY(i);
      // 등이 앞으로 굽은 실루엣
      cPos.setZ(i, cPos.getZ(i) + (vy + 0.24) * 0.12);
    }
    chestGeo.computeVertexNormals();
    const chest = new THREE.Mesh(chestGeo, dressMat);
    chest.position.y = 1.52;
    this.torsoGroup.add(chest);

    // 3. 비대칭적으로 축 늘어진 긴 팔과 가늘고 긴 손가락 실루엣
    const buildArm = (isLeft: boolean): THREE.Group => {
      const armGroup = new THREE.Group();
      const side = isLeft ? -1 : 1;

      // 소매 자락
      const sleeveGeo = new THREE.CylinderGeometry(0.055, 0.11, 0.54, 10, 4, true);
      const sleeve = new THREE.Mesh(sleeveGeo, dressMat);
      sleeve.position.y = -0.26;
      sleeve.rotation.z = side * 0.05;
      armGroup.add(sleeve);

      // 창백하고 앙상한 아래팔
      const forearm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.028, 0.02, 0.34, 8),
        paleSkinMat
      );
      forearm.position.y = -0.58;
      armGroup.add(forearm);

      // 기형적으로 긴 손가락 그림자
      const handGroup = new THREE.Group();
      handGroup.position.y = -0.75;
      for (let f = 0; f < 4; f++) {
        const finger = new THREE.Mesh(
          new THREE.CylinderGeometry(0.006, 0.002, 0.11 + (f % 2) * 0.02, 5),
          paleSkinMat
        );
        finger.position.set((f - 1.5) * 0.013, -0.05, 0.01);
        finger.rotation.x = 0.22 + f * 0.06;
        handGroup.add(finger);
      }
      armGroup.add(handGroup);

      armGroup.position.set(side * 0.19, 1.68 + (isLeft ? 0.03 : -0.035), 0.04);
      armGroup.rotation.z = side * 0.06;
      armGroup.rotation.x = isLeft ? 0.08 : 0.16;
      return armGroup;
    };

    this.leftArm = buildArm(true);
    this.rightArm = buildArm(false);
    this.torsoGroup.add(this.leftArm, this.rightArm);

    // 4. 가늘고 긴 목 + 얼굴이 어둠에 잠긴 머리
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.042, 0.05, 0.18, 8),
      paleSkinMat
    );
    neck.position.set(0, 1.78, 0.05);
    neck.rotation.x = 0.25;
    this.torsoGroup.add(neck);

    this.headGroup.position.set(0, 1.86, 0.08);

    // 두개골 기본 형태 (과장된 눈알/이빨 없음 — 푹 꺼진 안와 그림자만 존재)
    const skullGeo = new THREE.SphereGeometry(0.115, 16, 14);
    const kPos = skullGeo.attributes.position;
    for (let i = 0; i < kPos.count; i++) {
      let x = kPos.getX(i);
      let y = kPos.getY(i);
      let z = kPos.getZ(i);
      // 턱을 갸름하고 길게
      if (y < 0) {
        x *= 0.78 + (y + 0.12) * 0.8;
        y *= 1.28;
      }
      // 얼굴 정면(z > 0.05) 안와 부위를 안쪽으로 움푹 파서 그림자가 지게 함
      if (z > 0.04 && y > -0.02 && y < 0.045 && Math.abs(x) > 0.018 && Math.abs(x) < 0.068) {
        z -= 0.045;
      }
      kPos.setXYZ(i, x, y, z);
    }
    skullGeo.computeVertexNormals();
    const skull = new THREE.Mesh(skullGeo, paleSkinMat);
    this.headGroup.add(skull);

    // 얼굴 상반부를 완전히 삼키는 칠흑의 그림자 코어 (만화 같은 표정 원천 차단)
    const faceShadow = new THREE.Mesh(
      new THREE.SphereGeometry(0.113, 12, 10),
      darkInnerMat
    );
    faceShadow.position.set(0, 0.015, 0.012);
    faceShadow.scale.set(0.96, 0.85, 0.98);
    this.headGroup.add(faceShadow);

    // 정수리와 뒤통수를 감싸는 젖은 검은 머리카락 덩어리
    const scalpCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.122, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.68),
      solidHairMat
    );
    scalpCap.rotation.x = -0.15;
    this.headGroup.add(scalpCap);

    // 얼굴 앞과 어깨 아래로 길게 흘러내리는 젖은 머리카락 장막 (36겹)
    const strandCount = 36;
    for (let i = 0; i < strandCount; i++) {
      const angle = (i / strandCount) * Math.PI * 2;
      // 앞쪽(얼굴 가림)에 더 촘촘하게 배치
      const isFront = Math.sin(angle) > -0.2;
      const len = isFront ? rand(0.55, 0.95) : rand(0.45, 0.82);
      const width = rand(0.045, 0.085);

      const strandGeo = new THREE.PlaneGeometry(width, len, 1, 6);
      const stPos = strandGeo.attributes.position;
      for (let j = 0; j < stPos.count; j++) {
        const sy = stPos.getY(j);
        const normY = (len / 2 - sy) / len; // 0(위) ~ 1(아래)
        stPos.setZ(j, Math.sin(normY * Math.PI) * 0.025 + normY * 0.02);
        stPos.setY(j, sy - len / 2);
      }
      strandGeo.computeVertexNormals();

      const strand = new THREE.Mesh(strandGeo, hairMat);
      const r = 0.112;
      strand.position.set(Math.cos(angle) * r, 0.04, Math.sin(angle) * r);
      strand.rotation.y = -angle + Math.PI / 2;
      strand.rotation.x = isFront ? rand(0.04, 0.14) : rand(-0.08, 0.05);
      this.headGroup.add(strand);
      this.hairStrands.push(strand);
    }

    this.torsoGroup.add(this.headGroup);
    this.root.add(this.torsoGroup);
  }

  private applyPoseConfig(pose: GhostPose): void {
    switch (pose) {
      case 'standing': {
        // 고개가 부러진 듯 옆이나 아래로 깊이 꺾인 채 미동도 없이 서 있는 자세
        this.baseNeckPitch = 0.42;
        this.baseNeckRoll = (Math.random() > 0.5 ? 1 : -1) * 0.52;
        this.headGroup.rotation.set(this.baseNeckPitch, 0, this.baseNeckRoll);
        break;
      }
      case 'peeking': {
        // 문틈이나 코너 너머로 상체와 목만 기괴하게 꺾어 내민 자세
        this.torsoGroup.rotation.z = -0.38;
        this.baseNeckPitch = 0.25;
        this.baseNeckRoll = -0.68;
        this.headGroup.rotation.set(this.baseNeckPitch, 0.2, this.baseNeckRoll);
        break;
      }
      case 'crouched': {
        // 벽장 속이나 천장 구석에 웅크리고 박혀 있는 자세
        this.torsoGroup.scale.set(0.95, 0.56, 1.08);
        this.torsoGroup.position.y = -0.15;
        this.baseNeckPitch = 0.55;
        this.baseNeckRoll = 0.45;
        this.leftArm.rotation.x = -0.8;
        this.rightArm.rotation.x = -0.75;
        this.headGroup.rotation.set(this.baseNeckPitch, 0, this.baseNeckRoll);
        break;
      }
      case 'crawling': {
        // 바닥에 납작 엎드려 머리카락을 끌며 기어오는 자세 (링/주온)
        this.torsoGroup.rotation.x = Math.PI * 0.44;
        this.torsoGroup.position.y = 0.22;
        this.torsoGroup.position.z = -0.65;
        this.baseNeckPitch = -0.55;
        this.baseNeckRoll = 0.28;
        this.leftArm.rotation.x = -1.35;
        this.rightArm.rotation.x = -1.1;
        this.headGroup.rotation.set(this.baseNeckPitch, 0, this.baseNeckRoll);
        break;
      }
      case 'suspended': {
        // 허공에 매달린 채 발끝이 축 늘어진 자세 (404호)
        this.torsoGroup.position.y = 0.38;
        this.baseNeckPitch = 0.62;
        this.baseNeckRoll = -0.48;
        this.leftArm.rotation.x = 0.22;
        this.rightArm.rotation.x = 0.25;
        this.headGroup.rotation.set(this.baseNeckPitch, 0, this.baseNeckRoll);
        break;
      }
    }
  }

  /**
   * 매우 느리고 미세한 호흡/흔들림 업데이트.
   * 빠른 애니메이션 대신 '거의 정지해 있는데 아주 조금씩 자세가 어긋나는' 불쾌함을 만듭니다.
   */
  public update(dt: number, elapsed: number): void {
    const t = elapsed + this.phase;

    // 극도로 느린 상체 호흡/흔들림 (0.35Hz)
    const slowSway = Math.sin(t * 1.1) * 0.018;
    if (this.pose === 'suspended') {
      this.root.rotation.z = Math.sin(t * 0.85) * 0.045;
      this.root.rotation.x = Math.cos(t * 0.6) * 0.025;
    } else if (this.pose !== 'crawling') {
      this.torsoGroup.rotation.x = slowSway * 0.5;
    }

    // 간헐적인 미세 경련 (평소에는 거의 멈춰 있다가 가끔 목 각도가 툭 어긋남)
    const twitchGate = Math.sin(t * 2.7) * Math.sin(t * 7.3);
    const microTwitch = twitchGate > 0.94 ? (Math.random() - 0.5) * 0.14 : 0;

    this.headGroup.rotation.x = this.baseNeckPitch + Math.sin(t * 0.9) * 0.03 + microTwitch;
    this.headGroup.rotation.z = this.baseNeckRoll + Math.cos(t * 0.7) * 0.025 + microTwitch * 0.8;

    // 머리카락 장막의 아주 느린 흔들림
    for (let i = 0; i < this.hairStrands.length; i += 3) {
      this.hairStrands[i].rotation.z = Math.sin(t * 1.2 + i) * 0.02;
    }

    void dt;
  }
}
