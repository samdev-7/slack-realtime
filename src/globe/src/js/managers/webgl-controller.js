/* eslint-disable camelcase */
import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  CircleBufferGeometry,
  Clock,
  Color,
  CylinderBufferGeometry,
  DirectionalLight,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereBufferGeometry,
  SpotLight,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget
} from 'three/build/three.module';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import {
  BASE_HEIGHT,
  CAMERA_FOV,
  CAMERA_NEAR,
  CAMERA_Z,
  COLORS,
  DATA_CONTAINER,
  EVENTS,
  GLOBE_CONTAINER,
  GLOBE_RADIUS,
  MAP_ALPHA_THRESHOLD,
  MAX_CAMERA_DISTANCE,
  POPUP_TYPES,
  RAYCAST_TRIGGER,
  RENDER_QUALITY,
  ROTATION_OFFSET,
  VISIBLE_DATA_COUNT,
  VISIBLE_INCREMENT_SPEED,
  WORLD_DOT_ROWS
} from '../core/constants';
import EventManager from './event-manager';
import { AppProps } from '../core/app-props';
import { takeScreenshot, getMouseIntersection, polarToCartesian, DEG2RAD, disposeNode } from '../utils/three-utils';
import Globe from '../entities/globe';
import Controls from '../io/controls';
import OpenPrEntity from '../entities/open-pr-entity';
import MergedPrEntity from '../entities/merged-pr-entity';
import { showFallback } from '../managers/fallback';
import DataInfo from '../ui/data-info';
import haloVert from '../../glsl/halo.vert';
import haloFrag from '../../glsl/halo.frag';

export default class WebGLController {
  constructor(domContainer) {
    this.handleResize = this.handleResize.bind(this);
    this.handleScroll = this.handleScroll.bind(this);
    this.handlePause = this.handlePause.bind(this);
    this.handleResume = this.handleResume.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleFreeze = this.handleFreeze.bind(this);
    this.handleUnfreeze = this.handleUnfreeze.bind(this);
    this.setDragging = this.setDragging.bind(this);
    this.update = this.update.bind(this);
    this.hasLoaded = false;
    this.frozen = false;

    this.initBase(domContainer || document.body);
    this.initScene();
    this.resize();
    this.addListeners();

    EventManager.on(EVENTS.PAUSE, this.handlePause);
    EventManager.on(EVENTS.RESUME, this.handleResume);
  }

  initBase(domContainer) {
    const { width, height, x, y } = AppProps.parentNode.getBoundingClientRect();

    this.parentNodeRect = { width, height, x, y};
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(CAMERA_FOV, width / height, CAMERA_NEAR, MAX_CAMERA_DISTANCE);
    this.renderer = new WebGLRenderer({
      powerPreference: 'high-performance',
      alpha: true,
      preserveDrawingBuffer: false
    });
    this.then = Date.now() / 1000;  // time in seconds
    this.fpsWarnings = 0; // Accumulated warnings if we fail to maintain fps goal
    this.fpsWarningThreshold = 50; // If we fail to maintain the correct speed in 50 frames in a row, lower the quality
    this.fpsTarget = 60;
    this.fpsEmergencyThreshold = 12;
    this.fpsTargetSensitivity = 0.875; // Allow this margin of error, i.e. 60 * 0.875 -> 52,5
    this.fpsStorage = [];
    this.worldDotRows = WORLD_DOT_ROWS;
    this.worldDotSize = 0.095;
    // Hoisted out of buildWorldGeometry so callers (e.g. the Car Thing
    // kiosk path in entry.js) can scale longitudinal dot density in step
    // with worldDotSize/worldDotRows to preserve the dot-to-gap ratio.
    this.dotResolutionX = 2;
    // Frame-rate cap for low-power kiosks. 0 = off (rAF runs at panel
    // refresh, default behavior). When non-zero, update() short-circuits
    // until at least this many ms have elapsed since the last rendered
    // frame, halving (at 33ms / 30fps) the per-frame CPU cost on devices
    // that can't sustain 60fps anyway.
    this.minFrameMs = 0;
    this.lastFrameTime = 0;
    this.renderQuality = 4;
    this.renderer.setPixelRatio(AppProps.pixelRatio || 1);
    this.renderer.setSize(width, height);
    domContainer.appendChild(this.renderer.domElement);

    this.renderer.domElement.classList.add('webgl-canvas');
    this.renderer.domElement.classList.add('js-globe-canvas');

    const ambientLight = new AmbientLight(0xffffff, 0.8);
    this.scene.add(ambientLight);

    this.parentContainer = new Group();
    this.parentContainer.name = 'parentContainer';
    let rotationOffset = ROTATION_OFFSET;
    const date = new Date();
    const timeZoneOffset = date.getTimezoneOffset() || 0;
    const timeZoneMaxOffset = 60*12;
    rotationOffset.y = ROTATION_OFFSET.y + Math.PI * (timeZoneOffset / timeZoneMaxOffset);
    this.parentContainer.rotation.copy(rotationOffset);
    this.scene.add(this.parentContainer);

    this.haloContainer = new Group();
    this.haloContainer.name = 'haloContainer';
    this.scene.add(this.haloContainer);

    this.container = new Group();
    this.container.name = 'container';
    this.parentContainer.add(this.container);

    this.camera.position.set(0, 0, CAMERA_Z);
    this.scene.add(this.camera);
    this.clock = new Clock();
    this.mouse = new Vector3(0, 0, 0.5);
    this.mouseScreenPos = new Vector2(-9999, -9999);
    this.raycaster = new Raycaster();
    this.raycaster.far = MAX_CAMERA_DISTANCE;
    this.paused = false;
    this.canvasOffset = {x: 0, y: 0};
    this.updateCanvasOffset();
    this.highlightMaterial = new MeshBasicMaterial({
      opacity: 1,
      transparent: false,
      color: COLORS.WHITE
    });

    this.startUpdating();
  }

  initScene() {
    const {
      isMobile,
      globeRadius = GLOBE_RADIUS,
      assets: {
        textures: { globeDiffuse, globeAlpha },
      },
    } = AppProps;

    this.radius = globeRadius;

    this.light0 = new SpotLight(COLORS.LIGHT_BLUE, 12, 120, 0.3, 0, 1.1);
    this.light1 = new DirectionalLight(0xA9BFFF, 3);
    this.light3 = new SpotLight(COLORS.PINK, 5, 75, 0.5, 0, 1.25);

    this.light0.target = this.parentContainer;
    this.light1.target = this.parentContainer;
    this.light3.target = this.parentContainer;
    this.scene.add(this.light0, this.light1, this.light3);

    this.positionContainer();

    this.shadowPoint = new Vector3()
      .copy(this.parentContainer.position)
      .add(new Vector3(this.radius * 0.7, -this.radius * 0.3, this.radius));

    this.highlightPoint = new Vector3()
      .copy(this.parentContainer.position)
      .add(new Vector3(-this.radius * 1.5, -this.radius * 1.5, 0));

    this.frontPoint = new Vector3().copy(this.parentContainer.position).add(new Vector3(0, 0, this.radius));

    // Drop sphere tessellation in kiosk mode. The water/land sphere is
    // mostly hidden behind the world-dot pattern; on the Car Thing's
    // software CPU rasterizer the per-vertex transform cost of 55² ≈ 3k
    // quads is more wasteful than the visual difference 24² ≈ 600 quads
    // produces (which is none — the silhouette stays smooth because the
    // dots cover any faceting).
    const globeDetail = AppProps.kiosk ? 24 : 55;
    const globe = new Globe({
      radius: this.radius,
      detail: globeDetail,
      renderer: this.renderer,
      shadowPoint: this.shadowPoint,
      shadowDist: this.radius * 1.5,
      highlightPoint: this.highlightPoint,
      highlightColor: 0x517966,
      highlightDist: 5,
      frontPoint: this.frontPoint,
      frontHighlightColor: 0x27367d,
      waterColor: 0x171634,
      landColorFront: COLORS.WHITE,
      landColorBack: COLORS.WHITE
    });

    this.container.add(globe.mesh);
    this.globe = globe;

    // 45² ≈ 2k quads on the halo is overkill — the rim shading is purely
    // fragment-shader work, the underlying mesh just needs to look round.
    const haloSegments = AppProps.kiosk ? 24 : 45;
    const haloGeometry = new SphereBufferGeometry(GLOBE_RADIUS, haloSegments, haloSegments);
    const haloMaterialBlue = new ShaderMaterial({
      uniforms: {
        "c":   { type: "f", value: 0.7 },
        "p":   { type: "f", value: 15.0 },
        glowColor: { type: "c", value: new Color(COLORS.HALO_BLUE) },
        viewVector: { type: "v3", value: new Vector3(0, 0, CAMERA_Z) }
      },
      vertexShader: haloVert,
      fragmentShader: haloFrag,
      side: BackSide,
      blending: AdditiveBlending,
      transparent: true,
      dithering: true,
    });

    const haloUpperLeft = new Mesh(haloGeometry, haloMaterialBlue);
    haloUpperLeft.scale.multiplyScalar(1.15);
    haloUpperLeft.rotateX(Math.PI*0.03);
    haloUpperLeft.rotateY(Math.PI*0.03);
    haloUpperLeft.renderOrder = 3;
    this.haloContainer.add(haloUpperLeft);

    this.dragging = false;
    this.rotationSpeed = 0.05;
    this.raycastIndex = 0;
    this.raycastTrigger = RAYCAST_TRIGGER;
    this.raycastTargets = [];
    this.intersectTests = [];

    this.controls = new Controls({
      object: this.container,
      objectContainer: this.parentContainer,
      domElement: this.renderer.domElement,
      setDraggingCallback: this.setDragging,
      rotateSpeed: isMobile ? 1.5 : 3,
      autoRotationSpeed: this.rotationSpeed,
      easing: 0.12,
      maxRotationX: 0.5,
      camera: this.camera,
    });
  }

  initDataObjects(data) {
    const colors = {
      openPrColor: COLORS.LIGHT_BLUE,
      openPrParticleColor: 0x5da5f9,
      mergedPrColor: COLORS.PINK,
      mergedPrColorHighlight: COLORS.WHITE
    };

    const {
      isMobile,
      assets: {
        textures: { worldMap },
      },
    } = AppProps;

    this.buildWorldGeometry();
    this.addArcticCodeVault();

    this.maxAmount = data.length;
    this.maxIndexDistance = VISIBLE_DATA_COUNT;
    this.indexIncrementSpeed = VISIBLE_INCREMENT_SPEED; // this controls the speed at which the data increments
    this.visibleIndex = VISIBLE_DATA_COUNT; // this is the index for the middle of the visible data range

    this.openPrEntity = new OpenPrEntity({
      data,
      maxAmount: this.maxAmount,
      radius: this.radius,
      camera: this.camera,
      maxIndexDistance: this.maxIndexDistance,
      indexIncrementSpeed: this.indexIncrementSpeed,
      visibleIndex: this.visibleIndex,
      colors,
    });

    this.mergedPrEntity = new MergedPrEntity({
      data,
      maxAmount: this.maxAmount,
      radius: this.radius,
      camera: this.camera,
      maxIndexDistance: this.maxIndexDistance,
      visibleIndex: this.visibleIndex,
      colors,
      mouse: this.mouse,
    });

    const { width, height } = AppProps.parentNode.getBoundingClientRect();
    const containerScale = 1 * (BASE_HEIGHT / height);
    this.containerScale = containerScale;

    this.dataInfo = new DataInfo({
      parentSelector: DATA_CONTAINER,
      domElement: this.renderer.domElement,
      controls: this.controls,
    });
    this.dataItem = {};

    this.intersectTests.push(this.globe.meshFill);
    this.intersectTests.push(this.openPrEntity.spikeIntersects);
    this.intersectTests.push(...this.mergedPrEntity.lineHitMeshes);
    this.intersects = [];
  }

  monitorFps() {
    if (this.renderQuality == 1) return; // No reason to continue monitoring if we're at the lowest quality tier
    const now = Date.now() / 1000;  // time in seconds
    const elapsedTime = now - this.then;
    this.then = now;
    const fps = parseInt(1 / elapsedTime + 0.5);
    this.fpsStorage.push(fps);
    if (this.fpsStorage.length > 10) this.fpsStorage.shift();
    const fpsSum = this.fpsStorage.reduce((accumulator, currentValue) => accumulator + currentValue);
    const fpsAverage = fpsSum / this.fpsStorage.length;
    if (fpsAverage < this.fpsTarget * this.fpsTargetSensitivity && this.fpsStorage.length > 9) {
      this.fpsWarnings++;
      if (this.fpsWarnings > this.fpsWarningThreshold) {
        this.renderQuality = Math.max(this.renderQuality - 1, 1);
        this.fpsWarnings = 0;
        this.updateRenderQuality();
        this.fpsStorage = [];
      }
    } else if (this.fpsStorage.length > 9 && fpsAverage < this.fpsEmergencyThreshold) {
      this.renderQuality = 1;
      this.initPerformanceEmergency();
    } else {
      this.fpsWarnings = 0;
    }
  }

  updateRenderQuality() {
    if (this.renderQuality == RENDER_QUALITY.REGULAR) this.initRegularQuality();
    else if (this.renderQuality == RENDER_QUALITY.MEDIUM) this.initMediumQuality();
    else if (this.renderQuality == RENDER_QUALITY.LOW) this.initLowQuality();
    else if (this.renderQuality == RENDER_QUALITY.LOWEST) this.initLowestQuality();
  }

  initRegularQuality() {
    this.renderer.setPixelRatio(AppProps.pixelRatio || 1);
    this.indexIncrementSpeed = VISIBLE_INCREMENT_SPEED;
    this.raycastTrigger = RAYCAST_TRIGGER;
  }

  initMediumQuality() {
    this.renderer.setPixelRatio(Math.min(AppProps.pixelRatio, 1.85));
    this.indexIncrementSpeed = VISIBLE_INCREMENT_SPEED - 2;
    this.raycastTrigger = RAYCAST_TRIGGER + 2;
  }

  initLowQuality() {
    this.renderer.setPixelRatio(Math.min(AppProps.pixelRatio, 1.5));
    this.indexIncrementSpeed = VISIBLE_INCREMENT_SPEED / 3 * 2;
    this.raycastTrigger = RAYCAST_TRIGGER + 4;
    this.worldDotRows = WORLD_DOT_ROWS - 20;
    this.worldDotSize = 0.1;
    this.resetWorldMap();
    this.buildWorldGeometry();
  }

  // Render the halo's ShaderMaterial output to a texture once, then
  // replace the rotating-shader sphere with a flat camera-facing Sprite
  // that just samples that texture. Saves running the halo's per-vertex +
  // per-fragment program every frame. Safe in kiosk mode because:
  //   - haloContainer is added to `scene` directly (not to parentContainer),
  //     so globe rotation never moves it,
  //   - the camera is fixed (no CameraDirector pans during steady-state),
  //   - and the halo material's only uniform is `viewVector`, which is
  //     also fixed.
  // The Sprite is sized to fill the camera's frustum at z=0 so its
  // texture-space mapping matches the screen the original halo rendered to.
  bakeHaloToSprite() {
    if (!this.haloContainer) return;

    const { width, height } = AppProps.parentNode.getBoundingClientRect();
    const dpr = this.renderer.getPixelRatio();
    const target = new WebGLRenderTarget(Math.floor(width * dpr), Math.floor(height * dpr));

    // Hide everything except the halo subtree, render, then restore.
    const wasVisible = new Map();
    this.scene.traverse((obj) => {
      if (obj === this.scene) return;
      let p = obj;
      let isHalo = false;
      while (p && p !== this.scene) {
        if (p === this.haloContainer) { isHalo = true; break; }
        p = p.parent;
      }
      if (!isHalo) {
        wasVisible.set(obj, obj.visible);
        obj.visible = false;
      }
    });

    const prevClearColor = this.renderer.getClearColor(new Color());
    const prevClearAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(prevClearColor, prevClearAlpha);

    wasVisible.forEach((vis, obj) => { obj.visible = vis; });

    // Camera-facing quad sized to the frustum at z=0. With camera at
    // (0,0,CAMERA_Z) looking at origin and FOV=this.camera.fov, the
    // visible vertical extent at z=0 is 2 * CAMERA_Z * tan(fov/2).
    const fovRad = this.camera.fov * Math.PI / 180;
    const vh = 2 * this.camera.position.z * Math.tan(fovRad / 2);
    const vw = vh * this.camera.aspect;

    const sprite = new Sprite(new SpriteMaterial({
      map: target.texture,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }));
    sprite.scale.set(vw, vh, 1);
    sprite.renderOrder = 0;
    this.scene.add(sprite);

    this.haloContainer.visible = false;
    this.bakedHaloSprite = sprite;
    this.bakedHaloTarget = target;
  }

  initLowestQuality() {
    this.renderer.setPixelRatio(1);
    this.indexIncrementSpeed = VISIBLE_INCREMENT_SPEED / 3;
    this.raycastTrigger = RAYCAST_TRIGGER + 6;
    this.worldDotRows = WORLD_DOT_ROWS - 60;
    this.worldDotSize = 0.1;
    this.resetWorldMap();
    this.buildWorldGeometry();
  }

  initPerformanceEmergency() {
    this.dispose();
    showFallback();
  }

  buildWorldGeometry() {
    const { assets: { textures: { worldMap }, }, } = AppProps;
    const dummyDot = new Object3D();
    const imageData = this.getImageData(worldMap.image);
    const dotData = [];
    const dotResolutionX = this.dotResolutionX;
    const rows = this.worldDotRows;

    for (let lat = -90; lat <= 90; lat += 180/rows) {
      const segmentRadius = Math.cos(Math.abs(lat) * DEG2RAD) * GLOBE_RADIUS;
      const circumference = segmentRadius * Math.PI * 2;
      const dotsforRow = circumference * dotResolutionX;
      for (let x = 0; x < dotsforRow; x++) {
        const long = -180 + x*360/dotsforRow;
        if (!this.visibilityForCoordinate(long, lat, imageData)) continue;

        const pos = polarToCartesian(lat, long, this.radius);
        dummyDot.position.set(pos.x, pos.y, pos.z);
        const lookAt = polarToCartesian(lat, long, this.radius + 5);
        dummyDot.lookAt(lookAt.x, lookAt.y, lookAt.z);
        dummyDot.updateMatrix();
        dotData.push(dummyDot.matrix.clone());
      }
    }

    const geometry = new CircleBufferGeometry(this.worldDotSize, 5);
    // Software WebGL on the Car Thing's CPU spends most of its frame budget
    // in the fragment shader. The dots default to MeshStandardMaterial,
    // which runs full PBR (BRDF, lights[], envmap, normal/view dot products)
    // per fragment — with thousands of instanced dots that's the dominant
    // cost. MeshBasicMaterial just outputs the diffuse color, dropping the
    // entire lighting pipeline. Visual diff is negligible because
    // metalness=0 + roughness=0.9 already minimized specular variation,
    // and the kiosk scene uses a single AmbientLight (uniform multiplier
    // across all dots). The depth-fade onBeforeCompile hook below still
    // works because both materials emit `outgoingLight` for the alpha
    // tweak to splice into.
    const isKiosk = AppProps.kiosk;
    const DotMaterial = isKiosk ? MeshBasicMaterial : MeshStandardMaterial;
    const dotMaterial = new DotMaterial({ color: COLORS.LAND, transparent: true, alphaTest: 0.02 });
    dotMaterial.onBeforeCompile = (shader) => {
      // Existing depth-fade hook (alpha drops on the far hemisphere) plus,
      // in kiosk mode, a per-vertex Lambert that fakes the directional
      // shading we lost by dropping MeshStandardMaterial. Computing it in
      // the VERTEX shader is essential: the dots are children of the
      // rotating parentContainer, so we need the world-space normal at
      // render time to keep the bright side of the globe pinned to the
      // camera regardless of how the underlying geometry has rotated. A
      // build-time bake (which we tried first) bakes object-space
      // brightness — that rotates with the globe and ends up reversed
      // after ROTATION_OFFSET is applied. The vertex cost is tiny:
      // ~5–10 vertices per dot × a few thousand dots is negligible
      // compared to per-fragment PBR.
      if (isKiosk) {
        // Match the original PBR + custom shader's two-stage lighting:
        //   1. Brightness boost from a directional sun (matches the
        //      DirectionalLight at world position (-50, 30, 10) — light
        //      coming from upper-left, slightly forward). Range 0.8..3.8
        //      so lit-side dots clip toward white in the green/blue
        //      channels, matching the "almost white" lit look.
        //   2. Shadow dampening: mix to ~5% near a fixed world-space
        //      shadowPoint at front-right-bottom of the globe, smooth
        //      falloff to full at distance shadowDist. This is what
        //      pushes the lower-right of the globe toward black in the
        //      original — without it the lighting is symmetric around
        //      the camera and the globe loses its 3D feel.
        const r = this.radius;
        shader.uniforms.uSun = { value: new Vector3(-50, 30, 10).normalize() };
        shader.uniforms.uShadowPoint = { value: new Vector3(r * 0.7, -r * 0.3, r) };
        shader.uniforms.uShadowDist = { value: r * 1.5 };
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform vec3 uSun;\nuniform vec3 uShadowPoint;\nuniform float uShadowDist;\nvarying float vLambert;'
          )
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
             // Dot center in world space is (modelMatrix*instanceMatrix*origin).xyz.
             // For a sphere centered at the origin that also points outward along
             // the surface normal, so we don't need a separate normal attribute.
             vec3 dotCenterWorld = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
             float ndotl = max(0.0, dot(normalize(dotCenterWorld), uSun));
             float boost = 0.8 + 3.0 * ndotl;
             float distToShadow = distance(dotCenterWorld, uShadowPoint);
             float shadowMul = mix(0.05, 1.0, smoothstep(0.0, uShadowDist, distToShadow));
             vLambert = boost * shadowMul;`
          );
      }
      const fragHead = isKiosk
        ? '#include <common>\nvarying float vLambert;'
        : '#include <common>';
      const lambertMul = isKiosk ? ' * vLambert' : '';
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', fragHead)
        .replace(
          'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
          `gl_FragColor = vec4( outgoingLight${lambertMul}, diffuseColor.a );
           if (gl_FragCoord.z > 0.51) {
             gl_FragColor.a = 1.0 + ( 0.51 - gl_FragCoord.z ) * 17.0;
           }`
        );
    };
    const dotMesh = new InstancedMesh(geometry, dotMaterial, dotData.length);
    for (let i = 0; i < dotData.length; i++) dotMesh.setMatrixAt(i, dotData[i]);
    dotMesh.renderOrder = 3;
    this.worldMesh = dotMesh;
    this.container.add(dotMesh);
  }

  resetWorldMap() {
    this.container.remove(this.worldMesh);
    disposeNode(this.worldMesh);
    this.dotMesh = null;
  }

  addArcticCodeVault() {
    // Originally pinned at Svalbard (78.14, 15.26) for github's Arctic
    // Code Vault. Re-pinned to Hack Club HQ in Burlington, VT.
    const lat = 44.473958723783284;
    const long = -73.218213388791;
    const height = 1.5;
    const radius = 0.075;
    const geometry = new CylinderBufferGeometry(radius, radius, height, 8);
    this.vaultMaterial = new MeshBasicMaterial({
      blending: AdditiveBlending,
      opacity: 0.90,
      transparent: true,
      color: 0x4199FF
    });
    this.vaultIsHighlighted = false;

    const pos = polarToCartesian(lat, long, this.radius);
    const lookAt = polarToCartesian(lat, long, this.radius + 5);
    const { basePath, imagePath } = AppProps;
    const path = `${basePath}${imagePath}flag.obj`;
    const loader = new OBJLoader();

    loader.load(path, (obj) => {
      obj.position.set(pos.x, pos.y, pos.z);
      obj.lookAt(lookAt.x, lookAt.y, lookAt.z);
      obj.rotateX(90 * DEG2RAD);
      obj.scale.set(0.1, 0.1, 0.1);
      obj.renderOrder = 3;
      for (const mesh of obj.children) {
        mesh.material = this.vaultMaterial;
        mesh.name = 'arcticCodeVault';
        this.arcticCodeVaultMesh = mesh;
        this.intersectTests.push(this.arcticCodeVaultMesh);
      }
      this.container.add(obj);
    });
  }

  highlightArcticCodeVault() {
    if (this.vaultIsHighlighted) return;
    this.arcticCodeVaultMesh.material = this.highlightMaterial;
    this.vaultIsHighlighted = true;

    // Show aurora
    const aurora = document.querySelector('.js-globe-aurora');
    if (aurora === null) return;

    aurora.play();
    aurora.hidden = false;

    // If an animation is already running, just reverse it to fade in
    const elAnimations = aurora.getAnimations();
    for (const animation of elAnimations) {
      animation.reverse();
      return;
    }

    const keyframesIn = [
      { opacity: 0, },
      { opacity: 1 }
    ];
    const options = { fill: 'both', duration: 1600, easing: 'ease-in-out' };

    aurora.animate(keyframesIn, options);
  }

  resetArcticCodeVaultHighlight() {
    if (!this.vaultIsHighlighted) return;
    this.arcticCodeVaultMesh.material = this.vaultMaterial;
    this.vaultIsHighlighted = false;

    // Hide aurora
    const aurora = document.querySelector('.js-globe-aurora');
    if (aurora === null) return;
    const elAnimations = aurora.getAnimations();

    // If an animation is already running, just reverse it to fade out
    const animations = aurora.getAnimations();
    for (const animation of elAnimations) {
      animation.reverse();
      return;
    }

    const keyframesIn = [
      { opacity: 1, },
      { opacity: 0 }
    ];
    const options = { fill: 'both', duration: 1600, easing: 'ease-in' };

    aurora.animate(keyframesIn, options);
    aurora.pause();
  }

  visibilityForCoordinate(long, lat, imageData) {
    const dataSlots = 4;
    const dataRowCount = imageData.width * dataSlots;
    const x = parseInt((long + 180)/360 * imageData.width + 0.5);
    const y = imageData.height - parseInt((lat + 90)/180 * imageData.height - 0.5);
    const alphaDataSlot = parseInt(dataRowCount * (y - 1)  + x * dataSlots) + (dataSlots - 1);

    return imageData.data[alphaDataSlot] > MAP_ALPHA_THRESHOLD;
  }

  getImageData(image) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.canvas.width = image.width;
    ctx.canvas.height = image.height;
    ctx.drawImage(image, 0, 0, image.width, image.height);
    return ctx.getImageData(0, 0, image.width, image.height);
  }

  addListeners() {
    const eventOptions = {
      capture: false,
      passive: true
    }

    window.addEventListener('resize', this.handleResize, eventOptions);
    window.addEventListener('orientationchange', this.handleResize, eventOptions);
    window.addEventListener('scroll', this.handleScroll, eventOptions);

    const visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting && !this.paused) {
          this.paused = true;
          EventManager.emit(EVENTS.PAUSE);
        } else if (entry.isIntersecting && this.paused) {
          this.paused = false;
          EventManager.emit(EVENTS.RESUME);
        }
      }
    });
    visibilityObserver.observe(this.renderer.domElement);

    // this.handleClick = (e) => {
    //   if (this.dataItem === null || this.dataItem.url === null || this.shouldCancelClick(e)) return;
    //   window.open(this.dataItem.url, '_blank');
    // }
    // this.renderer.domElement.addEventListener('mouseup', this.handleClick, eventOptions);

    this.handleMouseDown = (e) => { this.resetInteractionIntention(e) }
    this.renderer.domElement.addEventListener('mousedown', this.handleMouseDown, eventOptions);

    this.handleTouchStart = (e) => {
      const event = e.changedTouches[0];
      this.handleMouseMove(event);
      this.resetInteractionIntention(event);
      e.preventDefault();
    }
    this.renderer.domElement.addEventListener('touchstart', this.handleTouchStart, {capture: false});

    this.handleTouchMove = (e) => {
      if (!this.shouldCancelClick(e.changedTouches[0])) return;
      this.mouse = {x: -9999, y: -9999};
      e.preventDefault();
    }
    this.renderer.domElement.addEventListener('touchmove', this.handleTouchMove, {capture: false});
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove, eventOptions);
    this.renderer.domElement.addEventListener('globeTriggerResize', this.handleResize, { passive: true });
    this.renderer.domElement.addEventListener('globeTriggerFreeze', this.handleFreeze, { passive: true });
    this.renderer.domElement.addEventListener('globeTriggerUnfreeze', this.handleUnfreeze, { passive: true });
  }

  removeListeners() {
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove);
    this.renderer.domElement.removeEventListener('mouseup', this.handleClick);
    this.renderer.domElement.removeEventListener('mousedown', this.handleMouseDown);
    this.renderer.domElement.removeEventListener('touchstart', this.handleTouchStart);
    this.renderer.domElement.removeEventListener('touchmove', this.handleTouchMove);
    this.renderer.domElement.removeEventListener('globeTriggerResize', this.handleResize);
    this.renderer.domElement.removeEventListener('globeTriggerFreeze', this.handleFreeze);
    this.renderer.domElement.removeEventListener('globeTriggerUnfreeze', this.handleUnfreeze);
  }

  updateCanvasOffset() {
    const dataParent = document.querySelector(DATA_CONTAINER).getBoundingClientRect();
    const globeContainer = document.querySelector(GLOBE_CONTAINER).getBoundingClientRect();
    this.canvasOffset = {
      x: globeContainer.x - dataParent.x,
      y: globeContainer.y - dataParent.y
    }
  }

  resetInteractionIntention(event) {
    this.mouseDownPos = {x: event.clientX, y: event.clientY}
  }

  shouldCancelClick(event) {
    // If dragging has been executed for more than N pixels in X or Y, it's probably a dragging motion, not a tap/click
    const diffX = Math.abs(event.clientX - this.mouseDownPos.x);
    const diffY = Math.abs(event.clientY - this.mouseDownPos.y);
    const diffThreshold = 2;
    return diffY > diffThreshold || diffX > diffThreshold
  }

  positionContainer() {
    const { isMobile } = AppProps;

    const { height } = this.parentNodeRect;
    const containerScale = 1 * (BASE_HEIGHT / height);
    this.containerScale = containerScale;

    if (!isMobile) {
      this.parentContainer.scale.set(containerScale, containerScale, containerScale);
      this.parentContainer.position.set(0, 0, 0);
      this.haloContainer.scale.set(containerScale, containerScale, containerScale);
    } else {
      this.parentContainer.position.set(0, 0, 0);
    }

    this.haloContainer.position.set(0, 0, -10);
    this.positionLights(containerScale);
  }

  positionLights(containerScale = 1) {
    if (this.light0) {
      this.light0.position.set(this.parentContainer.position.x - this.radius * 2.5, 80, -40).multiplyScalar(containerScale);

      this.light0.distance = 120 * containerScale;
    }

    if (this.light1) {
      this.light1.position
        .set(this.parentContainer.position.x - 50, this.parentContainer.position.y + 30, 10)
        .multiplyScalar(containerScale);
    }

    if (this.light2) {
      this.light2.position.set(this.parentContainer.position.x - 25, 0, 100).multiplyScalar(containerScale);
      this.light2.distance = 150 * containerScale;
    }

    if (this.light3) {
      this.light3.position
        .set(this.parentContainer.position.x + this.radius, this.radius, this.radius * 2)
        .multiplyScalar(containerScale);

      this.light3.distance = 75 * containerScale;
    }
  }

  handlePause() {
    this.stopUpdating();
    this.clock.stop();
  }

  handleResume() {
    if (!this.frozen) this.clock.start();
    this.startUpdating();
  }

  handleFreeze() {
    this.frozen = true;
    this.clock.stop();
  }

  handleUnfreeze() {
    this.frozen = false;
    this.clock.start();
  }

  resize() {
    const { width, height, x, y } = AppProps.parentNode.getBoundingClientRect();
    // Also store the windowY and windowX at this point, to calculate diff
    this.cachedParentNodeRect = {
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      y,
      x,
    };

    this.parentNodeRect = { width, height, x, y};
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height);

    this.positionContainer();

    const containerScale = 1 * (BASE_HEIGHT / height);
    const radius = this.radius * containerScale;

    this.shadowPoint.copy(this.parentContainer.position).add(new Vector3(radius * 0.7, -radius * 0.3, radius));
    this.globe.setShadowPoint(this.shadowPoint);

    this.highlightPoint.copy(this.parentContainer.position).add(new Vector3(-radius * 1.5, -radius * 1.5, 0));
    this.globe.setHighlightPoint(this.highlightPoint);

    this.frontPoint = new Vector3().copy(this.parentContainer.position).add(new Vector3(0, 0, radius));
    this.globe.setFrontPoint(this.frontPoint);

    this.globe.setShadowDist(radius * 1.5);
    this.globe.setHighlightDist(5 * containerScale);
    this.updateCanvasOffset();
  }

  handleResize() {
    clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => this.resize(), 150);
  }

  handleScroll() {
    // Update the cached parentNodeRect.y and parentNodeRect.x when scrolling
    this.parentNodeRect.y = this.cachedParentNodeRect.y + (this.cachedParentNodeRect.scrollY - window.scrollY);
    this.parentNodeRect.x = this.cachedParentNodeRect.x + (this.cachedParentNodeRect.scrollX - window.scrollX);
  }

  handleMouseMove(e) {
    const { width, height, x, y } = this.parentNodeRect;
    const mouseX = e.clientX - x;
    const mouseY = e.clientY - y;

    this.mouse.x = (mouseX / width) * 2 - 1;
    this.mouse.y = -(mouseY / height) * 2 + 1;

    this.mouseScreenPos.set(mouseX, mouseY);
  }

  startUpdating() {
    this.stopUpdating();
    this.update();
  }

  stopUpdating() {
    cancelAnimationFrame(this.rafID);
  }

  setDragging(value = true) {
    this.dragging = value;
  }

  setDataInfo(dataItem) {
    if (!this.dataInfo) return;
    if (this.dataItem == dataItem) return;
    this.dataItem = dataItem;

    const { uol, uml, l, type, body, header, nwo, pr, ma, oa } = dataItem;
    let time = ma || oa;
    if (time) {
      time = time.replace(' ', 'T');
      time = time.includes('Z') ? time : time.concat('-08:00');
      time = Date.parse(time)
    }
    if (nwo && pr) { this.dataItem.url = `https://github.com/${nwo}/pull/${pr}` }

    this.dataInfo.setInfo({
      user_opened_location: uol,
      user_merged_location: uml,
      language: l,
      name_with_owner: nwo,
      pr_id: pr,
      time,
      type,
      body,
      header,
      url: this.dataItem.url
    });
  }

  testForDataIntersection() {
    const { mouse, raycaster, camera } = this;

    this.intersects.length = 0;
    getMouseIntersection(mouse, camera, this.intersectTests, raycaster, this.intersects);

    // if the first hit is the globe, remove all results to avoid backside being used
    if (this.intersects.length && this.intersects[0].object === this.globe.meshFill) {
      this.intersects.length = 0;
    }
  }

  transitionIn() {
    return new Promise(() => {
      this.container.add(this.openPrEntity.mesh);
      this.container.add(this.mergedPrEntity.mesh);
    });
  }

  handleUpdate() {
    this.monitorFps();
    if (this.clock === null) return;
    const delta = this.clock.getDelta();
    if (this.controls) this.controls.update(delta);
    this.visibleIndex += delta * this.indexIncrementSpeed;

    if (this.visibleIndex >= this.maxAmount - VISIBLE_DATA_COUNT) this.visibleIndex = VISIBLE_DATA_COUNT;

    if (this.openPrEntity) this.openPrEntity.update(this.visibleIndex);
    if (this.mergedPrEntity) this.mergedPrEntity.update(delta, this.visibleIndex);

    if (!this.dataInfo) {
      this.render();
      return;
    }

    const { raycaster, camera, mouseScreenPos } = this;
    const frameValid = this.raycastIndex % this.raycastTrigger === 0;
    let found = false;
    let dataItem;

    if (frameValid) {
      this.testForDataIntersection();

      if (this.intersects.length) {
        const globeDistance = this.radius * this.containerScale;

        for (let i = 0; i < this.intersects.length && !found; i++) {
          const { instanceId, object } = this.intersects[i]; // vertex index

          if (object.name === 'lineMesh') {
            dataItem = this.setMergedPrEntityDataItem(object);
            found = true;
            break;
          } else if (object === this.openPrEntity.spikeIntersects && this.shouldShowOpenPrEntity(instanceId)) {
            dataItem = this.setOpenPrEntityDataItem(instanceId);
            found = true;
            break;
          } else if (object.name === 'arcticCodeVault') {
            dataItem = {
             header: 'Arctic Code Vault',
             body: 'Svalbard • Cold storage of the work of 3,466,573 open source developers. For safe keeping.\nLearn more →',
             type: POPUP_TYPES.CUSTOM,
             url: 'https://archiveprogram.github.com'
            }
            this.highlightArcticCodeVault();
            found = true;
            break;
          }
        }
      }

      if (found && dataItem) {
        this.setDataInfo(dataItem);
        this.dataInfo.show();
      } else {
        this.dataInfo.hide();
        this.openPrEntity.setHighlightIndex(-9999);
        this.mergedPrEntity.resetHighlight();
        this.resetArcticCodeVaultHighlight();
        this.dataItem = null;
        if (AppProps.isMobile) this.mouse = { x: -9999, y: -9999 } // Don't let taps persist on the canvas
      }
    }

    if (this.dragging) {
      this.dataInfo.hide();
      this.openPrEntity.setHighlightIndex(-9999);
      this.mergedPrEntity.resetHighlight();
      this.resetArcticCodeVaultHighlight();
    }

    if (this.dataInfo.isVisible) this.dataInfo.update(mouseScreenPos, this.canvasOffset);

    this.raycastIndex++;
    if (this.raycastIndex >= this.raycastTrigger) this.raycastIndex = 0;

    this.render();
  }

  update() {
    if (this.minFrameMs) {
      const now = performance.now();
      if (now - this.lastFrameTime < this.minFrameMs) {
        this.rafID = requestAnimationFrame(this.update);
        return;
      }
      this.lastFrameTime = now;
    }
    this.handleUpdate();
    if (!this.hasLoaded) this.sceneDidLoad();

    this.rafID = requestAnimationFrame(this.update);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  shouldShowMergedPrEntity(object, faceIndex) {
    const indexAttrib = object.geometry.attributes.index;
    const lineIndex = indexAttrib.array[faceIndex];

    return lineIndex >= this.visibleIndex - this.maxIndexDistance && lineIndex <= this.visibleIndex + this.maxIndexDistance;
  }

  sceneDidLoad() {
    this.hasLoaded = true;
    const placeholder = document.querySelector('.js-webgl-globe-loading');
    if (!placeholder) return;

    const keyframesIn = [
      { opacity: 0, transform: 'scale(0.8)' },
      { opacity: 1, transform: 'scale(1)' }
    ];
    const keyframesOut = [
      { opacity: 1, transform: 'scale(0.8)' },
      { opacity: 0, transform: 'scale(1)' }
    ];
    const options = { fill: 'both', duration: 600, easing: 'ease' };

    this.renderer.domElement.animate(keyframesIn, options);
    const placeHolderAnim = placeholder.animate(keyframesOut, options);
    placeHolderAnim.addEventListener('finish', () => {
      placeholder.remove();
    });
  }

  setMergedPrEntityDataItem(object) {
    this.mergedPrEntity.setHighlightObject(object);
    this.openPrEntity.setHighlightIndex(-9999);

    const dataItem = this.mergedPrEntity.props.data[parseInt(object.userData.dataIndex)];
    dataItem.type = POPUP_TYPES.PR_MERGED;

    return dataItem;
  }

  shouldShowOpenPrEntity(instanceId) {
    return instanceId >= this.visibleIndex - this.maxIndexDistance && instanceId <= this.visibleIndex + this.maxIndexDistance;
  }

  setOpenPrEntityDataItem(instanceId) {
    this.openPrEntity.setHighlightIndex(instanceId);
    this.mergedPrEntity.resetHighlight();

    const dataItem = this.openPrEntity.props.data[instanceId]
    dataItem.type = POPUP_TYPES.PR_OPENED;

    return dataItem;
  }

  dispose() {
    this.stopUpdating();
    this.removeListeners();
    EventManager.off(EVENTS.PAUSE, this.handlePause);
    EventManager.off(EVENTS.RESUME, this.handleResume);

    if (this.renderer && this.renderer.domElement && this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }

    if (this.controls) this.controls.dispose();
    if (this.globe) this.globe.dispose();
    if (this.openPrEntity) this.openPrEntity.dispose();
    if (this.mergedPrEntity) this.mergedPrEntity.dispose();
    if (this.dataInfo) this.dataInfo.dispose();

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.parentContainer = null;
    this.container = null;
    this.clock = null;
    this.mouse = null;
    this.mouseScreenPos = null;
    this.raycaster = null;
    this.paused = null;
    this.radius = null;
    this.light0 = null;
    this.light1 = null;
    this.light2 = null;
    this.light3 = null;
    this.shadowPoint = null;
    this.highlightPoint = null;
    this.frontPoint = null;
    this.globe = null;
    this.dragging = null;
    this.rotationSpeed = null;
    this.raycastIndex = null;
    this.raycastTrigger = null;
    this.raycastTargets = null;
    this.intersectTests = null;
    this.controls = null;
    this.maxAmount = null;
    this.maxIndexDistance = null;
    this.indexIncrementSpeed = null;
    this.visibleIndex = null;
    this.openPrEntity = null;
  }
}
