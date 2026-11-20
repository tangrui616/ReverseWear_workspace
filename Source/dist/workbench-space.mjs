import * as THREE from './wallpapers/static/three-r187/three.module.js';

const TAU = Math.PI * 2;

export function mountWorkbenchSpace(container) {
  if (!container) throw new TypeError('A container is required for the workbench scene.');

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xe9edf0, 0.008);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 90);
  camera.position.set(0.2, 0.5, 10.8);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.6));
  renderer.setClearColor(0xe9edf0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.domElement.className = 'workbench-space-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.dataset.renderedFrames = '0';
  container.append(renderer.domElement);

  const hemisphereLight = new THREE.HemisphereLight(0xf3f8ff, 0x647184, 2.2);
  scene.add(hemisphereLight);
  const porcelainLight = new THREE.PointLight(0xd9f0ff, 58, 15, 2);
  porcelainLight.position.set(-2.7, 2.7, 3.5);
  scene.add(porcelainLight);
  const goldLight = new THREE.PointLight(0xffdfad, 34, 17, 2);
  goldLight.position.set(3.2, -1.8, 2.5);
  scene.add(goldLight);
  const blueRim = new THREE.PointLight(0x80c6e8, 30, 13, 2);
  blueRim.position.set(1.5, 1, -2.5);
  scene.add(blueRim);

  const orrery = new THREE.Group();
  orrery.position.set(1.35, 0.02, 0);
  scene.add(orrery);

  const ouroborosCurve = new THREE.Curve();
  const biteGap = 0.035;
  ouroborosCurve.getPoint = t => {
    const angle = biteGap + (Math.PI * 2 - biteGap * 2) * t;
    return new THREE.Vector3(2.55 * Math.sin(angle), 1.3 * Math.sin(angle * 2), 0.27 * Math.cos(angle));
  };
  const segments = 220;
  const sides = 16;
  const frames = ouroborosCurve.computeFrenetFrames(segments, false);
  const positions = [];
  const uv = [];
  const faces = [];
  for (let i = 0; i <= segments; i++) {
    const along = i / segments;
    const center = ouroborosCurve.getPointAt(along);
    const tail = THREE.MathUtils.smoothstep(along, 0, .075);
    const radius = .245 * tail + .012;
    for (let j = 0; j <= sides; j++) {
      const around = j / sides * Math.PI * 2;
      const normal = frames.normals[i].clone().multiplyScalar(Math.cos(around));
      const binormal = frames.binormals[i].clone().multiplyScalar(Math.sin(around));
      positions.push(center.x + radius * (normal.x + binormal.x), center.y + radius * (normal.y + binormal.y), center.z + radius * (normal.z + binormal.z));
      uv.push(along, j / sides);
      if (i < segments && j < sides) {
        const a = i * (sides + 1) + j;
        const b = a + sides + 1;
        faces.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const scaleGeometry = new THREE.BufferGeometry();
  scaleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  scaleGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  scaleGeometry.setIndex(faces);
  scaleGeometry.computeVertexNormals();
  const bodyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uPearl: { value: new THREE.Color(0x8ba8bd) },
      uIvory: { value: new THREE.Color(0xe8f3f4) },
      uGold: { value: new THREE.Color(0xd2a45d) },
      uAccent: { value: new THREE.Color(0x6398ba) },
      uDark: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: `varying vec3 vNormal; varying vec3 vView; varying vec2 vUv; void main(){ vUv=uv; vec4 mv=modelViewMatrix*vec4(position,1.0); vNormal=normalize(normalMatrix*normal); vView=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `
uniform vec3 uPearl, uIvory, uGold, uAccent;
uniform float uDark, uTime;
varying vec3 vNormal, vView;
varying vec2 vUv;
void main() {
  vec3 n = normalize(vNormal);
  float facing = abs(dot(n, normalize(vView)));
  float key = max(dot(n, normalize(vec3(-.48,.72,.82))), 0.0);
  float rim = max(dot(n, normalize(vec3(.72,.08,.68))), 0.0);
  float fresnel = pow(1.0 - facing, 2.7);
  vec2 grid = vUv * vec2(102.0, 10.0);
  vec2 scaleA = fract(grid) - .5;
  vec2 scaleB = fract(grid + .5) - .5;
  vec2 scale = dot(scaleA, scaleA) < dot(scaleB, scaleB) ? scaleA : scaleB;
  float relief = max(0.0, 1.0 - 2.0 * length(scale));
  float border = 1.0 - smoothstep(.025, .13, relief);
  float crown = smoothstep(.18, .88, relief);
  vec3 shadow = mix(vec3(.035,.072,.115), vec3(.018,.034,.071), uDark);
  vec3 metal = mix(vec3(.135,.245,.34), vec3(.095,.19,.33), uDark);
  metal = mix(metal, uAccent, .28);
  vec3 color = mix(shadow, metal, .46 + crown * .39);
  color = mix(color, uPearl, smoothstep(.32,.96,key) * (.50 + crown*.21));
  color += uIvory * (pow(key,11.0)*.60 + pow(rim,18.0)*.25);
  color *= 1.0 - border * .18;
  color += mix(vec3(.13,.21,.29), uAccent * .8, uDark) * fresnel;
  float glint = pow(max(0.0, cos(vUv.x * 12.56637 - uTime * .74)), 18.0);
  color += glint * (.16 + border*.14) * uGold;
  gl_FragColor = vec4(color, 1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`,
  });
  const serpent = new THREE.Mesh(scaleGeometry, bodyMaterial);
  serpent.frustumCulled = false;
  orrery.add(serpent);
  const startOfTail = ouroborosCurve.getPointAt(0);
  const headPoint = ouroborosCurve.getPointAt(1);
  const biteDirection = startOfTail.clone().sub(headPoint).normalize();
  const head = new THREE.Group();
  head.position.copy(headPoint);
  head.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), biteDirection);
  orrery.add(head);
  const ivoryCeramic = new THREE.MeshPhysicalMaterial({ color: 0xe6d5b2, metalness: .35, roughness: .22, clearcoat: 1, clearcoatRoughness: .12 });
  const warmBrass = new THREE.MeshPhysicalMaterial({ color: 0xb88c50, metalness: .82, roughness: .23, clearcoat: 1 });
  const midnight = new THREE.MeshPhysicalMaterial({ color: 0x1b3146, metalness: .4, roughness: .2, clearcoat: 1 });
  const blueGem = new THREE.MeshPhysicalMaterial({ color: 0x7cc5d2, metalness: .24, roughness: .12, clearcoat: 1, emissive: 0x15566c, emissiveIntensity: .7 });
  const skull = new THREE.Mesh(new THREE.SphereGeometry(.255, 36, 24), ivoryCeramic);
  skull.scale.set(1.32, .82, .86);
  head.add(skull);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(.19, 28, 20), ivoryCeramic);
  muzzle.scale.set(1.22, .68, .72);
  muzzle.position.set(.22, -.025, 0);
  head.add(muzzle);
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(.135, 24, 16), warmBrass);
  jaw.scale.set(1.25, .45, .7);
  jaw.position.set(.28, -.12, 0);
  head.add(jaw);
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(.096, .018, 8, 32), midnight);
  mouth.rotation.y = Math.PI / 2;
  mouth.scale.set(.86, 1.13, 1);
  mouth.position.set(.36, -.055, 0);
  head.add(mouth);
  for (const side of [-1, 1]) {
    const socket = new THREE.Mesh(new THREE.SphereGeometry(.063, 20, 14), warmBrass);
    socket.position.set(.09, .105, side * .14);
    head.add(socket);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(.04, 20, 14), blueGem);
    eye.position.set(.105, .116, side * .177);
    head.add(eye);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(.011, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfffaeb }));
    glint.position.set(.114, .128, side * .205);
    head.add(glint);
  }
  const tailTangent = ouroborosCurve.getTangentAt(0).normalize();
  const tailTip = new THREE.Mesh(new THREE.ConeGeometry(.062, .2, 24), ivoryCeramic);
  tailTip.position.copy(startOfTail).addScaledVector(tailTangent, .055);
  tailTip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tailTangent.clone().negate());
  orrery.add(tailTip);

  const cyan = new THREE.MeshPhysicalMaterial({ color: 0xd8e6e2, metalness: 0.48, roughness: 0.24, clearcoat: 1, emissive: 0x345764, emissiveIntensity: 0.16 });
  const pale = new THREE.MeshPhysicalMaterial({ color: 0xf0e3c9, metalness: 0.44, roughness: 0.24, clearcoat: 1 });
  const brass = new THREE.MeshPhysicalMaterial({ color: 0xb98a4d, metalness: 0.8, roughness: 0.26, emissive: 0x39210b, emissiveIntensity: 0.16 });
  const inner = head;
  const rings = [];
  for (const [radius, tube, color, tilt] of [[3.08, 0.012, pale, 0.3], [3.25, 0.008, cyan, -0.57], [3.39, 0.005, brass, 0.85]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 180), color);
    ring.rotation.set(tilt, 0, 0.28);
    ring.scale.y = 0.56;
    orrery.add(ring);
    rings.push(ring);
  }

  const orbit = new THREE.Group();
  orbit.rotation.set(0.52, 0.3, -0.28);
  orrery.add(orbit);
  const orbitLine = new THREE.Mesh(new THREE.TorusGeometry(3.36, 0.005, 6, 240), new THREE.MeshBasicMaterial({ color: 0x7799a1, transparent: true, opacity: 0.38 }));
  orbitLine.scale.y = 0.56;
  orbit.add(orbitLine);
  const satellite = new THREE.Mesh(new THREE.SphereGeometry(0.085, 24, 16), brass);
  satellite.position.set(3.36, 0, 0);
  orbit.add(satellite);
  const satHalo = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.005, 6, 48), pale);
  satHalo.position.copy(satellite.position);
  orbit.add(satHalo);

  const nodes = new THREE.Group();
  orrery.add(nodes);
  const nodeMaterial = new THREE.MeshStandardMaterial({ color: 0xb8d4d3, emissive: 0x426c72, emissiveIntensity: 0.7, metalness: 0.48, roughness: 0.24 });
  for (let i = 0; i < 12; i++) {
    const angle = TAU * i / 12;
    const radius = i % 3 === 0 ? 2.06 : 1.98;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(i % 3 === 0 ? 0.035 : 0.018, 10, 8), i % 3 === 0 ? brass : nodeMaterial);
    dot.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, Math.sin(angle * 2) * 0.07);
    nodes.add(dot);
  }
  const tickPoints = [];
  for (let i = 0; i < 96; i++) {
    const angle = TAU * i / 96;
    const radius = 2.09;
    const length = i % 8 === 0 ? 0.14 : i % 4 === 0 ? 0.075 : 0.035;
    tickPoints.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0));
    tickPoints.push(new THREE.Vector3(Math.cos(angle) * (radius + length), Math.sin(angle) * (radius + length), 0));
  }
  const tickGeometry = new THREE.BufferGeometry().setFromPoints(tickPoints);
  const tickMaterial = new THREE.LineBasicMaterial({ color: 0x8bddec, transparent: true, opacity: 0.42 });
  const ticks = new THREE.LineSegments(tickGeometry, tickMaterial);
  ticks.rotation.set(0.52, 0.3, -0.28);
  ticks.scale.set(1.48, 0.86, 1);
  orrery.add(ticks);

  const starCount = 700;
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const x = (Math.random() - 0.5) * 24;
    const y = (Math.random() - 0.5) * 15;
    const z = -2 - Math.random() * 18;
    starPositions.set([x, y, z], i * 3);
    const warm = Math.random() > 0.91;
    starColors.set(warm ? [0.95, 0.66, 0.38] : [0.35, 0.75, 0.92], i * 3);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 0.025, vertexColors: true, transparent: true, opacity: 0.82, sizeAttenuation: true }));
  scene.add(stars);

  const dustGeometry = new THREE.BufferGeometry();
  const dustPositions = new Float32Array(100 * 3);
  for (let i = 0; i < 100; i++) dustPositions.set([(Math.random() - 0.5) * 7, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5], i * 3);
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: 0xd5ae72, size: 0.035, transparent: true, opacity: 0.56 }));
  orrery.add(dust);

  const appearance = {
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    palette: document.documentElement.dataset.palette || 'mist',
  };
  const paletteAccents = {
    mist: 0x76a6c3,
    ocean: 0x54a9d5,
    sage: 0x75a889,
    plum: 0xa68ac4,
    sand: 0xc49b65,
  };
  function applyAppearance() {
    const dark = appearance.theme === 'dark';
    const accent = paletteAccents[appearance.palette] || paletteAccents.mist;
    const accentColor = new THREE.Color(accent);
    bodyMaterial.uniforms.uAccent.value.copy(accentColor);
    bodyMaterial.uniforms.uDark.value = dark ? 1 : 0;
    bodyMaterial.uniforms.uPearl.value.set(dark ? 0x9fcce5 : 0x9bb2c2);
    bodyMaterial.uniforms.uIvory.value.set(dark ? 0xd3edff : 0xe9f4f3);
    bodyMaterial.uniforms.uGold.value.set(dark ? 0xe5b974 : 0xcaa36c);
    scene.background = null;
    scene.fog.color.set(dark ? 0x101923 : 0xe9edf0);
    hemisphereLight.color.set(dark ? 0xb7d9ff : 0xf3f8ff);
    hemisphereLight.groundColor.set(dark ? 0x182638 : 0x647184);
    hemisphereLight.intensity = dark ? 1.45 : 2.2;
    porcelainLight.color.set(dark ? 0x8bcaff : 0xd9f0ff);
    porcelainLight.intensity = dark ? 74 : 58;
    goldLight.intensity = dark ? 42 : 34;
    blueRim.color.copy(accentColor);
    blueRim.intensity = dark ? 42 : 30;
    ivoryCeramic.color.set(dark ? 0xa9c7dc : 0xdce5e9);
    ivoryCeramic.emissive.set(dark ? 0x142b42 : 0x000000);
    warmBrass.color.set(dark ? 0xdaad69 : 0xb88c50);
    midnight.color.set(dark ? 0x07111e : 0x1b3146);
    blueGem.color.copy(accentColor).lerp(new THREE.Color(dark ? 0xbde9ff : 0xa6dbe7), 0.48);
    blueGem.emissive.copy(accentColor).multiplyScalar(dark ? 0.38 : 0.2);
    cyan.color.copy(accentColor).lerp(new THREE.Color(dark ? 0x98c8e6 : 0xd8e6e2), 0.72);
    cyan.emissive.copy(accentColor).multiplyScalar(dark ? 0.14 : 0.08);
    pale.color.set(dark ? 0x91adbf : 0xe1e7e3);
    brass.color.set(dark ? 0xd3a75f : 0xb98a4d);
    nodeMaterial.color.copy(accentColor).lerp(new THREE.Color(dark ? 0x9bccec : 0xb8d4d3), 0.5);
    nodeMaterial.emissive.copy(accentColor).multiplyScalar(dark ? 0.45 : 0.24);
    tickMaterial.color.copy(accentColor);
    orbitLine.material.color.copy(accentColor);
    stars.material.opacity = dark ? 0.94 : 0.52;
    dust.material.color.copy(accentColor).lerp(new THREE.Color(0xe1b978), 0.38);
    dust.material.opacity = dark ? 0.74 : 0.42;
  }
  const appearanceObserver = new MutationObserver(() => {
    appearance.theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    appearance.palette = document.documentElement.dataset.palette || 'mist';
    applyAppearance();
    scheduleFrame();
  });
  appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
  const onAppearanceChange = (event) => {
    if (event.detail?.theme) appearance.theme = event.detail.theme;
    if (event.detail?.palette) appearance.palette = event.detail.palette;
    applyAppearance();
    scheduleFrame();
  };
  document.addEventListener('stilltime:appearance', onAppearanceChange);
  applyAppearance();

  let width = 1;
  let height = 1;
  let frame = 0;
  let disposed = false;
  let dragging = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let pointerX = 0;
  let pointerY = 0;
  let targetX = 0;
  let targetY = 0;
  let zoom = 10.8;
  let lastTime = 0;
  const startedAt = performance.now();

  function resize() {
    const rect = container.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    orrery.position.x = width < 700 ? 0.95 : width < 900 ? 1.25 : 1.65;
    orrery.scale.setScalar(width < 700 ? 1.02 : 1.25);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    scheduleFrame();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  function pointerMove(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerX = ((event.clientX - rect.left) / width - 0.5) * 2;
    pointerY = ((event.clientY - rect.top) / height - 0.5) * 2;
    if (dragging) {
      targetY += (event.clientX - lastPointerX) * 0.004;
      targetX += (event.clientY - lastPointerY) * 0.004;
    }
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    if (reducedMotion) scheduleFrame();
  }
  function pointerDown(event) {
    if (event.button !== 0) return;
    dragging = true;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
    if (reducedMotion) scheduleFrame();
  }
  function pointerUp() { dragging = false; if (reducedMotion) scheduleFrame(); }
  function wheel(event) { event.preventDefault(); zoom = THREE.MathUtils.clamp(zoom + event.deltaY * 0.004, 7.7, 14); if (reducedMotion) scheduleFrame(); }
  renderer.domElement.addEventListener('pointermove', pointerMove);
  renderer.domElement.addEventListener('pointerdown', pointerDown);
  renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('pointercancel', pointerUp);
  renderer.domElement.addEventListener('wheel', wheel, { passive: false });

  function scheduleFrame() {
    if (disposed || frame) return;
    frame = requestAnimationFrame(animate);
  }

  function animate(time) {
    if (disposed) return;
    frame = 0;
    if (document.hidden) return;
    if (!reducedMotion && time - lastTime < 30) {
      scheduleFrame();
      return;
    }
    lastTime = time;
    const elapsed = (time - startedAt) / 1000;
    if (!reducedMotion) {
      orrery.rotation.y += 0.0018;
      orrery.rotation.z += 0.0007;
      inner.rotation.y = Math.sin(elapsed * 0.12) * 0.025;
      inner.rotation.x = Math.cos(elapsed * 0.1) * 0.02;
      bodyMaterial.uniforms.uTime.value = elapsed;
      orbit.rotation.y = 0.3 + elapsed * 0.09;
      rings[0].rotation.y = Math.sin(elapsed * 0.19) * 0.18;
      rings[1].rotation.x = -0.57 + Math.cos(elapsed * 0.13) * 0.12;
      stars.rotation.z = elapsed * 0.0015;
      dust.rotation.y = elapsed * 0.025;
    }
    const hoverX = dragging ? 0 : pointerY * 0.09;
    const hoverY = dragging ? 0 : pointerX * 0.12;
    const blend = reducedMotion ? 1 : 0.035;
    orrery.rotation.x += (targetX + hoverX - orrery.rotation.x) * blend;
    orrery.rotation.y += (targetY + hoverY - orrery.rotation.y) * blend;
    if (reducedMotion) camera.position.z = zoom;
    else camera.position.z += (zoom - camera.position.z) * 0.06;
    renderer.render(scene, camera);
    renderer.domElement.dataset.renderedFrames = String(Number(renderer.domElement.dataset.renderedFrames) + 1);
    renderer.domElement.dataset.yaw = orrery.rotation.y.toFixed(3);
    renderer.domElement.dataset.zoom = camera.position.z.toFixed(2);
    if (!reducedMotion) scheduleFrame();
  }
  scheduleFrame();
  const onVisibilityChange = () => { if (!document.hidden) scheduleFrame(); };
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      appearanceObserver.disconnect();
      document.removeEventListener('stilltime:appearance', onAppearanceChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerUp);
      renderer.domElement.removeEventListener('wheel', wheel);
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
  };
}
