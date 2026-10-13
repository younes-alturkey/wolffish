import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

// ── Simplex noise (GPU) ──────────────────────────────────────────────
const NOISE_GLSL = /* glsl */ `
  vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
  vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
  vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
  float snoise(vec3 v){
    const vec2 C=vec2(1./6.,1./3.);
    const vec4 D=vec4(0.,.5,1.,2.);
    vec3 i=floor(v+dot(v,C.yyy));
    vec3 x0=v-i+dot(i,C.xxx);
    vec3 g=step(x0.yzx,x0.xyz);
    vec3 l=1.-g;
    vec3 i1=min(g,l.zxy);
    vec3 i2=max(g,l.zxy);
    vec3 x1=x0-i1+C.xxx;
    vec3 x2=x0-i2+C.yyy;
    vec3 x3=x0-D.yyy;
    i=mod289(i);
    vec4 p=permute(permute(permute(
      i.z+vec4(0.,i1.z,i2.z,1.))
      +i.y+vec4(0.,i1.y,i2.y,1.))
      +i.x+vec4(0.,i1.x,i2.x,1.));
    float n_=.142857142857;
    vec3 ns=n_*D.wyz-D.xzx;
    vec4 j=p-49.*floor(p*ns.z*ns.z);
    vec4 x_=floor(j*ns.z);
    vec4 y_=floor(j-7.*x_);
    vec4 x=x_*ns.x+ns.yyyy;
    vec4 y=y_*ns.x+ns.yyyy;
    vec4 h=1.-abs(x)-abs(y);
    vec4 b0=vec4(x.xy,y.xy);
    vec4 b1=vec4(x.zw,y.zw);
    vec4 s0=floor(b0)*2.+1.;
    vec4 s1=floor(b1)*2.+1.;
    vec4 sh=-step(h,vec4(0.));
    vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
    vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
    vec3 p0=vec3(a0.xy,h.x);
    vec3 p1=vec3(a0.zw,h.y);
    vec3 p2=vec3(a1.xy,h.z);
    vec3 p3=vec3(a1.zw,h.w);
    vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
    vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
    m=m*m;
    return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }
`

// Shared wave field — the ocean displaces with it and the splash rings ride it,
// so both must call the exact same function with raw uTime.
const WAVE_GLSL = /* glsl */ `
  float waveH(vec2 p, float tt){
    float t = tt * 0.32;
    float h = snoise(vec3(p.x * 0.035, p.y * 0.052, t * 0.35)) * 2.35;
    h += snoise(vec3(p.x * 0.085 + 4.7, p.y * 0.072 + 2.1, t * 0.55)) * 1.05;
    h += snoise(vec3(p.x * 0.22 + 1.3, p.y * 0.19 + 9.4, t * 0.90)) * 0.35;
    return h;
  }
`

export default function OceanScene(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    const mobile = window.innerWidth < 768

    // ── Renderer + composer ────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA happens on the composer's render target
      powerPreference: 'high-performance'
    })
    const pixelRatio = Math.min(window.devicePixelRatio, mobile ? 1.5 : 2)
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(pixelRatio)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.9
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x04070f)

    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500)
    camera.position.set(0, 4.5, 18)
    camera.lookAt(0, -0.3, -9)

    // ── Shared uniforms (same objects across materials) ────────────────
    const uTime = { value: 0 }
    const uLightning = { value: 0 }
    const uWind = { value: new THREE.Vector2(2.0, 0.45) }
    const uPixelScale = {
      value: (2 * Math.tan(THREE.MathUtils.degToRad(27.5))) / (window.innerHeight * pixelRatio)
    }
    const uCamPos = { value: camera.position }
    const uMoonDir = {
      value: new THREE.Vector3(-0.4, 0.14, -0.9).normalize()
    }
    const uBoltDir = { value: new THREE.Vector3(-0.3, 0.4, -0.87).normalize() }
    const uHorizonCol = { value: new THREE.Color(0.03, 0.048, 0.085) }
    const uSkyMidCol = { value: new THREE.Color(0.01, 0.02, 0.048) }
    const uZenithCol = { value: new THREE.Color(0.004, 0.009, 0.026) }
    const uMoonCol = { value: new THREE.Color(1.0, 0.95, 0.86) }

    const skyUniforms = {
      uTime,
      uLightning,
      uCamPos,
      uMoonDir,
      uBoltDir,
      uHorizonCol,
      uSkyMidCol,
      uZenithCol,
      uMoonCol
    }

    // ── Sky dome ───────────────────────────────────────────────────────
    const skyGeo = new THREE.SphereGeometry(240, 48, 32)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { ...skyUniforms },
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        void main(){
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform float uTime;
        uniform float uLightning;
        uniform vec3 uCamPos;
        uniform vec3 uMoonDir;
        uniform vec3 uBoltDir;
        uniform vec3 uHorizonCol;
        uniform vec3 uSkyMidCol;
        uniform vec3 uZenithCol;
        uniform vec3 uMoonCol;
        varying vec3 vWorldPos;

        float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float fbm(vec3 p){
          float s = 0.0;
          float a = 0.55;
          for(int i = 0; i < 4; i++){
            s += a * snoise(p);
            p = p * 2.02 + vec3(11.3, 7.9, 5.1);
            a *= 0.55;
          }
          return s;
        }

        void main(){
          vec3 dir = normalize(vWorldPos - uCamPos);
          float ey = clamp(dir.y, 0.0, 1.0);
          vec3 col = mix(uHorizonCol, uSkyMidCol, smoothstep(0.0, 0.30, ey));
          col = mix(col, uZenithCol, smoothstep(0.25, 0.80, ey));

          // Storm cloud field, projected onto a virtual plane
          vec2 q = dir.xz / (max(dir.y, 0.03) + 0.15);
          q = q * 0.85 + uTime * vec2(0.012, 0.005);
          float d = fbm(vec3(q, uTime * 0.018));
          float cov = smoothstep(-0.08, 0.52, d) * smoothstep(0.02, 0.16, dir.y);

          // Moon: crisp disc + halo, dimmed but gleaming through cloud
          float m = clamp(dot(dir, uMoonDir), 0.0, 1.0);
          float disc = smoothstep(0.99958, 0.99988, m);
          float glow = pow(m, 900.0) * 1.5 + pow(m, 450.0) * 0.35
                     + pow(m, 120.0) * 0.06 + pow(m, 8.0) * 0.012;
          // The disc keeps a defined edge through cloud; the halo dims more
          col += uMoonCol * disc * 4.0 * mix(1.0, 0.5, cov);
          col += uMoonCol * glow * mix(1.0, 0.16, cov);

          // Faint stars in the cloud gaps (seam of atan kept behind camera)
          vec2 sph = vec2(atan(dir.x, -dir.z), asin(clamp(dir.y, -1.0, 1.0)));
          vec2 sg = sph * 60.0;
          vec2 cell = floor(sg);
          vec2 fpt = fract(sg) - 0.5;
          float rnd = hash21(cell);
          vec2 off = vec2(hash21(cell + 7.3), hash21(cell + 2.9)) - 0.5;
          float sd = length(fpt - off * 0.6);
          float star = smoothstep(0.09, 0.015, sd) * step(0.985, rnd);
          float tw = 0.55 + 0.45 * sin(uTime * (1.0 + 3.0 * rnd) + rnd * 40.0);
          col += vec3(0.75, 0.82, 1.0) * star * tw * 0.35
               * (1.0 - cov) * (1.0 - cov) * smoothstep(0.10, 0.40, dir.y);

          // Cloud body: moonlit on one side, silver rims, lightning inside
          float lit = 0.5 + 0.5 * dot(dir, uMoonDir);
          float edge = cov * (1.0 - cov) * 4.0;
          vec3 cCol = mix(vec3(0.008, 0.014, 0.028), vec3(0.030, 0.044, 0.075),
                          clamp(lit * 0.55 + edge * 0.45, 0.0, 1.0));
          cCol += uMoonCol * pow(m, 20.0) * 0.06;
          float bolt = pow(clamp(dot(dir, uBoltDir), 0.0, 1.0), 15.0);
          cCol += vec3(0.60, 0.68, 0.95) * uLightning * (bolt * 2.0 + 0.05);
          col = mix(col, cCol, cov * 0.92);

          // Global flash ambience, then blend into the horizon haze band
          col += vec3(0.05, 0.06, 0.10) * uLightning * (0.3 + bolt);
          col = mix(uHorizonCol, col, smoothstep(-0.02, 0.09, dir.y));

          // Dither against banding in the dark gradient
          col += (hash21(gl_FragCoord.xy) - 0.5) * 0.008;
          gl_FragColor = vec4(col, 1.0);
        }
      `
    })
    const sky = new THREE.Mesh(skyGeo, skyMat)
    scene.add(sky)

    // ── Ocean ──────────────────────────────────────────────────────────
    const oceanSeg = mobile ? 220 : 320
    const oceanGeo = new THREE.PlaneGeometry(300, 300, oceanSeg, oceanSeg)
    const oceanMat = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms,
        uDeepCol: { value: new THREE.Color(0.005, 0.014, 0.034) },
        uMidCol: { value: new THREE.Color(0.012, 0.03, 0.066) },
        uCrestCol: { value: new THREE.Color(0.024, 0.052, 0.1) }
      },
      vertexShader: /* glsl */ `
        ${NOISE_GLSL}
        ${WAVE_GLSL}
        uniform float uTime;
        varying vec3 vWorldPos;
        varying float vElev;
        void main(){
          vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
          float dfade = 1.0 - smoothstep(70.0, 140.0, length(wp.xz));
          float h = waveH(wp.xz, uTime) * dfade;
          wp.y += h;
          vElev = h;
          vWorldPos = wp;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        ${WAVE_GLSL}
        uniform float uTime;
        uniform float uLightning;
        uniform vec3 uCamPos;
        uniform vec3 uMoonDir;
        uniform vec3 uBoltDir;
        uniform vec3 uHorizonCol;
        uniform vec3 uSkyMidCol;
        uniform vec3 uZenithCol;
        uniform vec3 uMoonCol;
        uniform vec3 uDeepCol;
        uniform vec3 uMidCol;
        uniform vec3 uCrestCol;
        varying vec3 vWorldPos;
        varying float vElev;

        // Full-detail height: the 3 displacement octaves plus 2 ripple octaves.
        // Detail fades with distance (da) to stop far-field shimmer.
        float hgt(vec2 p, float da){
          float h = waveH(p, uTime);
          h += snoise(vec3(p * 0.55, uTime * 1.1)) * 0.15 * da;
          h += snoise(vec3(p * 1.45, uTime * 2.1)) * 0.055 * da;
          return h;
        }

        vec3 reflSky(vec3 R){
          float ey = clamp(R.y, 0.0, 1.0);
          vec3 c = mix(uHorizonCol, uSkyMidCol, smoothstep(0.0, 0.30, ey));
          c = mix(c, uZenithCol, smoothstep(0.25, 0.80, ey));
          float m = clamp(dot(R, uMoonDir), 0.0, 1.0);
          c += uMoonCol * (pow(m, 700.0) * 4.0 + pow(m, 48.0) * 0.14);
          c += vec3(0.55, 0.62, 0.85) * uLightning
             * (pow(clamp(dot(R, uBoltDir), 0.0, 1.0), 14.0) * 1.0 + 0.03);
          return c;
        }

        void main(){
          vec2 p = vWorldPos.xz;
          float distXZ = distance(p, uCamPos.xz);
          float da = 1.0 - smoothstep(15.0, 70.0, distXZ);

          // Per-pixel normal from finite differences of the full wave field
          float e = 0.13;
          float h0 = hgt(p, da);
          float hx = hgt(p + vec2(e, 0.0), da);
          float hz = hgt(p + vec2(0.0, e), da);
          vec3 N = normalize(vec3((h0 - hx) / e, 1.0, (h0 - hz) / e));

          vec3 V = normalize(uCamPos - vWorldPos);
          float NdV = clamp(dot(N, V), 0.001, 1.0);
          float F = 0.022 + 0.978 * pow(1.0 - NdV, 5.0);

          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 refl = reflSky(R);

          vec3 water = mix(uDeepCol, uMidCol, smoothstep(-2.4, 1.4, vElev));
          water = mix(water, uCrestCol, smoothstep(1.1, 2.9, vElev));

          // Backlit crests scatter moonlight through the water
          float sss = smoothstep(0.3, 2.6, vElev)
                    * pow(clamp(dot(V, normalize(vec3(-uMoonDir.x, 0.22, -uMoonDir.z))), 0.0, 1.0), 2.5);
          water += vec3(0.012, 0.07, 0.088) * sss * 1.2;

          vec3 col = mix(water, refl, F);

          // Moon glitter: tight sparkle from the detailed normals + soft lobe
          vec3 Hv = normalize(uMoonDir + V);
          float ns = clamp(dot(N, Hv), 0.0, 1.0);
          col += vec3(0.95, 0.97, 1.0) * pow(ns, 300.0) * 3.0;
          col += vec3(0.14, 0.18, 0.26) * pow(ns, 38.0) * 0.4;

          // Patchy foam on crests
          float fn = snoise(vec3(p * 0.72, uTime * 0.45)) * 0.5 + 0.5;
          float fn2 = snoise(vec3(p * 2.4 + 5.0, uTime * 0.7)) * 0.5 + 0.5;
          float foam = smoothstep(1.45, 2.60, vElev + (fn - 0.5) * 1.15)
                     * (0.35 + 0.65 * fn2) * (0.3 + 0.7 * da);
          col = mix(col, vec3(0.30, 0.36, 0.46), clamp(foam, 0.0, 1.0) * 0.8);

          // Lightning wash + hot reflection streak
          col += (vec3(0.035, 0.045, 0.07) + vec3(0.9) * pow(ns, 90.0)) * uLightning * 0.6;

          // Haze into the same horizon color the sky uses — seamless join
          col = mix(col, uHorizonCol, smoothstep(45.0, 132.0, distXZ));
          gl_FragColor = vec4(col, 1.0);
        }
      `
    })
    const ocean = new THREE.Mesh(oceanGeo, oceanMat)
    ocean.rotation.x = -Math.PI / 2
    ocean.position.y = -1
    scene.add(ocean)

    // ── Rain: GPU-instanced streak quads ───────────────────────────────
    // Each instance is a velocity-aligned billboard. Width is clamped to
    // ≥1 pixel with alpha compensation so thin drops stay crisp, never
    // shimmering squares.
    const RAIN_COUNT = mobile ? 1800 : 3200
    const rainQuad = new THREE.PlaneGeometry(1, 1)
    const rainGeo = new THREE.InstancedBufferGeometry()
    rainGeo.setIndex(rainQuad.getIndex())
    rainGeo.setAttribute('position', rainQuad.getAttribute('position'))
    rainGeo.setAttribute('uv', rainQuad.getAttribute('uv'))
    rainGeo.instanceCount = RAIN_COUNT

    const rainSeed = new Float32Array(RAIN_COUNT * 4)
    const rainCfg = new Float32Array(RAIN_COUNT * 4)
    for (let i = 0; i < RAIN_COUNT; i++) {
      const layer = Math.random() < 0.14 ? 1 : 0
      rainSeed[i * 4] = layer ? (Math.random() - 0.5) * 52 : (Math.random() - 0.5) * 96
      rainSeed[i * 4 + 1] = layer ? -18 + Math.random() * 40 : -55 + Math.random() * 79
      rainSeed[i * 4 + 2] = Math.random()
      rainSeed[i * 4 + 3] = Math.random()
      rainCfg[i * 4] = layer
      rainCfg[i * 4 + 1] = 0.75 + Math.random() * 0.5
      rainCfg[i * 4 + 2] = 0.75 + Math.random() * 0.55
      rainCfg[i * 4 + 3] = Math.random()
    }
    rainGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(rainSeed, 4))
    rainGeo.setAttribute('aCfg', new THREE.InstancedBufferAttribute(rainCfg, 4))

    const rainMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime, uWind, uPixelScale, uLightning },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed; // x, z, yFrac, rnd
        attribute vec4 aCfg;  // layer, lenScale, widthScale, speedRnd
        uniform float uTime;
        uniform vec2 uWind;
        uniform float uPixelScale;
        varying vec2 vUv;
        varying float vFade;
        const float SPAN = 42.0;
        void main(){
          float layer = aCfg.x;
          float speed = mix(19.0, 30.0, aCfg.w) * mix(1.0, 1.4, layer);
          float y = mod(aSeed.z * SPAN - uTime * speed, SPAN) - 2.0;
          float tau = (SPAN - 2.0 - y) / speed;
          vec3 head = vec3(aSeed.x, y, aSeed.y);
          head.xz += uWind * tau * 0.8;
          vec3 vel = vec3(uWind.x * 0.8, -speed, uWind.y * 0.8);
          float len = speed * 0.032 * aCfg.y * mix(1.0, 1.55, layer);
          vec3 tail = head - normalize(vel) * len;

          vec4 hV = viewMatrix * vec4(head, 1.0);
          vec4 tV = viewMatrix * vec4(tail, 1.0);
          vec4 c = mix(tV, hV, uv.y);

          // Screen-space direction of motion; quad extends perpendicular
          vec2 sdir = hV.xy - tV.xy;
          float sl = length(sdir);
          sdir = sl > 1e-4 ? sdir / sl : vec2(1.0, 0.0);

          float dist = max(-c.z, 0.5);
          float baseW = 0.021 * aCfg.z * mix(1.0, 2.4, layer);
          float minW = dist * uPixelScale * 1.5;
          float w = max(baseW, minW);
          float fade = baseW / w; // dimmer instead of thinner-than-a-pixel
          fade *= smoothstep(80.0, 34.0, dist) * smoothstep(1.0, 4.0, dist);
          fade *= mix(0.6, 1.0, layer);
          vFade = fade;

          c.xy += vec2(-sdir.y, sdir.x) * (uv.x - 0.5) * w;
          vUv = uv;
          gl_Position = projectionMatrix * c;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uLightning;
        varying vec2 vUv;
        varying float vFade;
        void main(){
          float dx = abs(vUv.x - 0.5) * 2.0;
          float lat = max(exp(-dx * dx * 5.0) - 0.02, 0.0);
          float taper = smoothstep(0.0, 0.32, vUv.y);
          float bright = mix(0.45, 1.0, vUv.y) + smoothstep(0.86, 1.0, vUv.y) * 0.5;
          vec3 col = mix(vec3(0.50, 0.64, 0.82), vec3(0.85, 0.92, 1.1), min(uLightning, 1.0));
          gl_FragColor = vec4(col * bright * 1.25, lat * taper * vFade);
        }
      `
    })
    const rain = new THREE.Mesh(rainGeo, rainMat)
    rain.frustumCulled = false
    scene.add(rain)

    // ── Splash rings where rain strikes the water ──────────────────────
    const RING_COUNT = mobile ? 240 : 420
    const ringQuad = new THREE.PlaneGeometry(1, 1)
    ringQuad.rotateX(-Math.PI / 2)
    const ringGeo = new THREE.InstancedBufferGeometry()
    ringGeo.setIndex(ringQuad.getIndex())
    ringGeo.setAttribute('position', ringQuad.getAttribute('position'))
    ringGeo.setAttribute('uv', ringQuad.getAttribute('uv'))
    ringGeo.instanceCount = RING_COUNT

    const ringSeed = new Float32Array(RING_COUNT * 4)
    for (let i = 0; i < RING_COUNT; i++) {
      ringSeed[i * 4] = (Math.random() - 0.5) * 44
      ringSeed[i * 4 + 1] = 18 - Math.pow(Math.random(), 1.8) * 40
      ringSeed[i * 4 + 2] = Math.random()
      ringSeed[i * 4 + 3] = Math.random()
    }
    ringGeo.setAttribute('aRing', new THREE.InstancedBufferAttribute(ringSeed, 4))

    const ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime, uCamPos, uLightning },
      vertexShader: /* glsl */ `
        ${NOISE_GLSL}
        ${WAVE_GLSL}
        attribute vec4 aRing; // x, z, phase, rnd
        uniform float uTime;
        uniform vec3 uCamPos;
        varying vec2 vUv;
        varying float vLife;
        varying float vFade;
        void main(){
          float rnd = aRing.w;
          float dur = mix(0.75, 1.25, fract(rnd * 7.31));
          float p = fract(uTime / dur + aRing.z);
          float ease = 1.0 - (1.0 - p) * (1.0 - p);
          float R = mix(0.04, 0.38, ease) * mix(0.75, 1.25, fract(rnd * 3.77));
          vec3 wp = vec3(aRing.x, 0.0, aRing.y);
          wp.xz += position.xz * (R * 2.2);
          // Sit on the actual wave surface (ocean mesh lives at y = -1)
          wp.y = waveH(wp.xz, uTime) - 1.0 + 0.06;
          vUv = (uv - 0.5) * 2.0;
          vLife = p;
          vFade = smoothstep(32.0, 9.0, distance(wp, uCamPos));
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uLightning;
        varying vec2 vUv;
        varying float vLife;
        varying float vFade;
        void main(){
          float r = length(vUv);
          float q = (r - 0.74) / 0.12;
          float band = exp(-q * q);
          float a = band * pow(1.0 - vLife, 1.6) * 0.3 * vFade;
          vec3 col = vec3(0.50, 0.66, 0.84) * (1.0 + uLightning * 1.2);
          gl_FragColor = vec4(col, a);
        }
      `
    })
    const rings = new THREE.Mesh(ringGeo, ringMat)
    rings.frustumCulled = false
    scene.add(rings)

    // ── Low mist over the water ────────────────────────────────────────
    const mistGeo = new THREE.PlaneGeometry(120, 120, 1, 1)
    const mistMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTime },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform float uTime;
        varying vec2 vUv;
        void main(){
          float n = snoise(vec3(vUv * 4.0 + uTime * 0.025, uTime * 0.012));
          n += snoise(vec3(vUv * 9.0 - uTime * 0.02, uTime * 0.02)) * 0.4;
          float edge = 1.0 - smoothstep(0.25, 0.5, length(vUv - 0.5));
          float alpha = max(0.0, n) * 0.10 * edge;
          gl_FragColor = vec4(0.04, 0.07, 0.13, alpha);
        }
      `
    })
    const mist = new THREE.Mesh(mistGeo, mistMat)
    mist.rotation.x = -Math.PI / 2
    mist.position.y = 1.0
    scene.add(mist)

    // ── Post-processing: MSAA target → bloom → ACES output ────────────
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const renderTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4
    })
    const composer = new EffectComposer(renderer, renderTarget)
    composer.setPixelRatio(pixelRatio)
    composer.setSize(window.innerWidth, window.innerHeight)
    const renderPass = new RenderPass(scene, camera)
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.28,
      0.4,
      1.0
    )
    const outputPass = new OutputPass()
    composer.addPass(renderPass)
    composer.addPass(bloomPass)
    composer.addPass(outputPass)

    // ── Animation loop ─────────────────────────────────────────────────
    const timer = new THREE.Timer()
    timer.connect(document)
    let time = 0
    let lightning = 0
    let burst = 0
    let flashTimer = 0
    let animId: number

    function animate(): void {
      animId = requestAnimationFrame(animate)
      timer.update()
      const dt = Math.min(timer.getDelta(), 0.05)
      time += dt
      uTime.value = time

      // Gusting wind drives rain slant
      uWind.value.set(
        2.0 + Math.sin(time * 0.23) * 1.0 + Math.sin(time * 0.57) * 0.5,
        0.45 + Math.sin(time * 0.31) * 0.3
      )

      // Lightning: multi-flash bursts with framerate-independent decay
      flashTimer -= dt
      if (burst > 0 && flashTimer <= 0) {
        lightning = 0.65 + Math.random() * 0.85
        flashTimer = 0.045 + Math.random() * 0.11
        burst--
      } else if (burst === 0 && Math.random() < dt * 0.13) {
        burst = 2 + Math.floor(Math.random() * 3)
        const az = (Math.random() - 0.5) * 2.2
        const el = 0.18 + Math.random() * 0.4
        uBoltDir.value
          .set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el))
          .normalize()
      }
      lightning *= Math.exp(-dt * 7.5)
      uLightning.value = lightning

      // Slow swell of the camera, like standing on a deck
      camera.position.x = Math.sin(time * 0.07) * 0.7
      camera.position.y = 4.5 + Math.sin(time * 0.11) * 0.3
      camera.lookAt(Math.sin(time * 0.05) * 0.4, -0.3 + Math.sin(time * 0.09) * 0.2, -9)

      composer.render()
    }

    animate()

    // ── Resize ─────────────────────────────────────────────────────────
    function onResize(): void {
      const w = window.innerWidth
      const h = window.innerHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      composer.setSize(w, h)
      uPixelScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(27.5))) / (h * pixelRatio)
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(animId)
      timer.dispose()
      bloomPass.dispose()
      outputPass.dispose()
      composer.dispose()
      ;[skyGeo, oceanGeo, rainGeo, rainQuad, ringGeo, ringQuad, mistGeo].forEach((g) => g.dispose())
      ;[skyMat, oceanMat, rainMat, ringMat, mistMat].forEach((m) => m.dispose())
      renderer.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div ref={containerRef} className="fixed inset-0 w-full h-full" style={{ zIndex: 0 }} />
}
