import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { earthTextureUrl } from "./assets.js";

const EARTH_RADIUS = 1;
const INITIAL_VIEW = { latitude: 64.4, longitude: -16.8 };

function geographicVector(latitude, longitude, radius = EARTH_RADIUS) {
  const lat = THREE.MathUtils.degToRad(latitude);
  const lon = THREE.MathUtils.degToRad(longitude);
  return new THREE.Vector3(
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * Math.cos(lat) * Math.sin(lon),
  );
}

function pointCoordinates(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates ?? [];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(1);
  return [];
}

function addStarfield(scene) {
  const positions = [];
  let seed = 746291;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = 0; index < 1100; index += 1) {
    const longitude = random() * Math.PI * 2;
    const vertical = random() * 2 - 1;
    const radius = 12 + random() * 7;
    const horizontal = Math.sqrt(1 - vertical * vertical);
    positions.push(
      radius * horizontal * Math.cos(longitude),
      radius * vertical,
      radius * horizontal * Math.sin(longitude),
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xc3e1ef,
    size: 0.022,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material);
  scene.add(stars);
  return stars;
}

function createGraticule() {
  const graticule = new THREE.Group();
  const material = new THREE.LineBasicMaterial({
    color: 0x8ddbd0,
    transparent: true,
    opacity: 0.19,
    depthWrite: false,
  });
  const addLine = (coordinates) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(
      coordinates.map(([latitude, longitude]) =>
        geographicVector(latitude, longitude, 1.003),
      ),
    );
    graticule.add(new THREE.Line(geometry, material));
  };

  for (let longitude = -180; longitude < 180; longitude += 30) {
    const coordinates = [];
    for (let latitude = -84; latitude <= 84; latitude += 2) {
      coordinates.push([latitude, longitude]);
    }
    addLine(coordinates);
  }
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const coordinates = [];
    for (let longitude = -180; longitude <= 180; longitude += 3) {
      coordinates.push([latitude, longitude]);
    }
    addLine(coordinates);
  }
  return { graticule, material };
}

function renderGlobe(container, onLocationSelected) {
  const scene = new THREE.Scene();
  const stars = addStarfield(scene);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.copy(geographicVector(INITIAL_VIEW.latitude, INITIAL_VIEW.longitude, 3.3));
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.setAttribute("aria-label", "Interactive 3D Earth; drag to rotate, scroll to zoom, click a location to search it.");
  renderer.domElement.tabIndex = 0;
  container.append(renderer.domElement);

  const globe = new THREE.Group();
  globe.rotation.y = -Math.PI / 2;
  scene.add(globe);
  const loader = new THREE.TextureLoader();
  const earthTexture = loader.load(
    earthTextureUrl,
    () => {
      const state = document.querySelector("#globeLoadState");
      if (state) state.remove();
    },
    undefined,
    () => {
      const state = document.querySelector("#globeLoadState");
      if (state) state.textContent = "LOCAL EARTH TEXTURE FAILED TO LOAD";
    },
  );
  earthTexture.colorSpace = THREE.SRGBColorSpace;
  earthTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS, 96, 64),
    new THREE.MeshStandardMaterial({
      map: earthTexture,
      roughness: 1,
      metalness: 0,
    }),
  );
  earth.userData.isEarth = true;
  globe.add(earth);

  const { graticule, material: graticuleMaterial } = createGraticule();
  globe.add(graticule);

  scene.add(new THREE.AmbientLight(0xb7d7ff, 0.78));
  const sun = new THREE.DirectionalLight(0xffffff, 2.8);
  sun.position.set(-3, 2, 4);
  scene.add(sun);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.035, 96, 64),
    new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mvPosition.xyz);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float rim = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 3.0);
          gl_FragColor = vec4(0.20, 0.68, 1.0, rim * 0.48);
        }
      `,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    }),
  );
  globe.add(atmosphere);

  const schematicOrbit = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 240 }, (_, index) => {
        const angle = (index / 240) * Math.PI * 2;
        const orbitPoint = new THREE.Vector3(
          1.16 * Math.cos(angle),
          0.25 * Math.sin(angle),
          0,
        );
        orbitPoint.applyAxisAngle(new THREE.Vector3(0, 0, 1), -0.32);
        return orbitPoint;
      }),
    ),
    new THREE.LineDashedMaterial({
      color: 0x43d9ff,
      dashSize: 0.028,
      gapSize: 0.018,
      transparent: true,
      opacity: 0.48,
    }),
  );
  schematicOrbit.computeLineDistances();
  scene.add(schematicOrbit);

  const marker = new THREE.Group();
  const markerCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0xffa45c }),
  );
  marker.add(markerCore);
  const markerHalo = new THREE.Mesh(
    new THREE.SphereGeometry(0.043, 20, 14),
    new THREE.MeshBasicMaterial({
      color: 0xff9a45,
      transparent: true,
      opacity: 0.36,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  marker.add(markerHalo);
  globe.add(marker);

  let footprint = new THREE.Group();
  globe.add(footprint);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.enablePan = false;
  controls.minDistance = 1.65;
  controls.maxDistance = 5.2;
  controls.rotateSpeed = 0.55;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  function resize() {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function setStudyPoint(latitude, longitude) {
    marker.position.copy(geographicVector(latitude, longitude, 1.012));
  }

  function setFootprint(geometry) {
    globe.remove(footprint);
    footprint.traverse((child) => {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
      else child.material?.dispose();
    });
    footprint = new THREE.Group();

    for (const ring of pointCoordinates(geometry)) {
      if (!Array.isArray(ring) || ring.length < 4) continue;
      const points = ring.map(([longitude, latitude]) =>
        geographicVector(latitude, longitude, 1.008),
      );
      const geometryLine = new THREE.BufferGeometry().setFromPoints(points);
      footprint.add(
        new THREE.LineLoop(
          geometryLine,
          new THREE.LineBasicMaterial({
            color: 0x48d7ff,
            transparent: true,
            opacity: 0.83,
            depthWrite: false,
          }),
        ),
      );
    }

    globe.add(footprint);
  }

  function focus(latitude, longitude) {
    const direction = globe.localToWorld(geographicVector(latitude, longitude, 1)).normalize();
    camera.position.copy(direction.multiplyScalar(camera.position.length()));
    controls.target.set(0, 0, 0);
    controls.update();
    setStudyPoint(latitude, longitude);
  }

  function handleCanvasClick(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersection = raycaster.intersectObject(earth, false)[0];
    if (!intersection) return;

    const point = intersection.point.clone();
    globe.worldToLocal(point).normalize();
    const latitude = THREE.MathUtils.radToDeg(Math.asin(point.y));
    const longitude = THREE.MathUtils.radToDeg(Math.atan2(-point.z, point.x));
    onLocationSelected(latitude, longitude);
  }
  renderer.domElement.addEventListener("click", handleCanvasClick);

  let frame = 0;
  let animationId = 0;
  function animate() {
    animationId = requestAnimationFrame(animate);
    controls.update();
    frame += 0.004;
    markerHalo.scale.setScalar(1 + 0.07 * Math.sin(frame));
    renderer.render(scene, camera);
  }

  setStudyPoint(INITIAL_VIEW.latitude, INITIAL_VIEW.longitude);
  resize();
  animate();

  return {
    focus,
    setStudyPoint,
    setFootprint,
    setOrbitVisible(visible) {
      schematicOrbit.visible = visible;
    },
    reset() {
      focus(INITIAL_VIEW.latitude, INITIAL_VIEW.longitude);
      setFootprint(null);
    },
    dispose() {
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("click", handleCanvasClick);
      controls.dispose();
      renderer.dispose();
      earthTexture.dispose();
      stars.geometry.dispose();
      stars.material.dispose();
      graticule.traverse((child) => child.geometry?.dispose());
      graticuleMaterial.dispose();
      container.replaceChildren();
    },
  };
}

export function createGlobe(container, onLocationSelected) {
  try {
    return renderGlobe(container, onLocationSelected);
  } catch (error) {
    console.error("Could not initialize the 3D Earth.", error);
    const state = document.querySelector("#globeLoadState");
    if (state) state.textContent = "3D GLOBE UNAVAILABLE IN THIS BROWSER";
    return null;
  }
}
