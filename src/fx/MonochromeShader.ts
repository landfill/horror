/**
 * 화면 전체를 흑백으로 만드는 후처리 셰이더.
 * - 완전한 그레이스케일 (색 정보 제거)
 * - 감마 공간에서 고대비 처리 → 어둠은 더 검게, 형광등은 더 희게
 * - 필름 그레인, 비네팅
 * - 스캔라인과 가로 찢김은 평소에는 없고, 이벤트 순간(uDistort)에만 나타남
 *   (항상 켜져 있으면 '필터를 씌운 게임'처럼 보이고 금방 무뎌짐)
 */
export const MonochromeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.035 },
    uContrast: { value: 1.12 },
    uBrightness: { value: 1.0 },
    uVignette: { value: 0.42 },
    uDistort: { value: 0.0 },
    uTear: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uGrain;
    uniform float uContrast;
    uniform float uBrightness;
    uniform float uVignette;
    uniform float uDistort;
    uniform float uTear;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;

      // 이벤트 순간에만 가로 찢김 + 화면 일그러짐
      float fx = clamp(uDistort * 4.0, 0.0, 1.0);
      float band = floor(uv.y * 160.0);
      float tear = step(0.985, hash(vec2(band, floor(uTime * 20.0)))) * uTear * fx;
      float wob = (hash(vec2(floor(uv.y * 70.0), floor(uTime * 30.0))) - 0.5) * uDistort;
      uv.x += tear * 0.012 + wob * 0.05;

      vec3 c = texture2D(tDiffuse, uv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));

      // 감마 공간에서 대비 조정
      l = pow(max(l, 0.0), 1.0 / 2.2);
      // 기준점을 낮춰 어두운 영역이 통째로 검게 뭉개지지 않게 함
      l = (l - 0.28) * uContrast + 0.28;
      l *= uBrightness;

      // 비네팅
      vec2 d = vUv - 0.5;
      float vig = 1.0 - dot(d, d) * uVignette * 2.4;
      l *= clamp(vig, 0.0, 1.0);

      // 필름 그레인
      float g = hash(vUv * vec2(913.0, 677.0) + fract(uTime * 13.0) * 91.0) - 0.5;
      l += g * uGrain;

      // 스캔라인 (이벤트 순간에만)
      l *= 1.0 - fx * 0.08 * step(1.0, mod(gl_FragCoord.y, 2.0));

      l = clamp(l, 0.0, 1.0);
      // OutputPass가 다시 sRGB로 인코딩하므로 선형으로 되돌림
      l = pow(l, 2.2);
      gl_FragColor = vec4(vec3(l), 1.0);
    }
  `,
};
