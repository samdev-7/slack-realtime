// Custom entry point for the local preview build.
// Wraps the upstream @github/webgl-globe code with:
//   - a window.globe API exposing webglController and spawn helpers
//   - a CameraDirector that orchestrates rotation around button-driven
//     spawns: pre-pan to the spawn target, hold/sweep, then ease back to
//     auto-spinning. Spike/arc animations themselves continue independently.

import { Vector3, Matrix4, Quaternion } from 'three/build/three.module';
import WebGLHeader from './core/webgl-header';
import { GLOBE_RADIUS, GLOBE_CONTAINER, WORLD_DOT_ROWS } from './core/constants';
import { AppProps } from './core/app-props';
import { polarToCartesian } from './utils/three-utils';

function ready() {
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve());
  });
}

function webGLSupported() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  return ctx instanceof WebGLRenderingContext;
}

function randomLatLon() {
  const lat = Math.acos(2 * Math.random() - 1) * (180 / Math.PI) - 90;
  const lon = Math.random() * 360 - 180;
  return { lat, lon };
}

function easeInOut(x) {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

// Great-circle midpoint between two lat/lon points (used to "center on the
// middle" for arcs whose endpoints are close enough to be on one visible
// side of the globe).
function latLonMidpoint(a, b) {
  const v1 = polarToCartesian(a.lat, a.lon, 1);
  const v2 = polarToCartesian(b.lat, b.lon, 1);
  const mid = new Vector3().addVectors(v1, v2).multiplyScalar(0.5).normalize();
  // Inverse of polarToCartesian:
  //   phi = (90 - lat) * π/180,  theta = (lon + 180) * π/180
  //   x = -sin(phi) cos(theta), y = cos(phi), z = sin(phi) sin(theta)
  const lat = 90 - (Math.acos(mid.y) * 180 / Math.PI);
  const lon = (Math.atan2(mid.z, -mid.x) * 180 / Math.PI) - 180;
  return { lat, lon: ((lon + 540) % 360) - 180 };
}

// Angle (radians) along the great circle between two lat/lon points.
function greatCircleAngle(a, b) {
  const v1 = polarToCartesian(a.lat, a.lon, 1);
  const v2 = polarToCartesian(b.lat, b.lon, 1);
  return Math.acos(Math.min(1, Math.max(-1, v1.dot(v2))));
}

// Of an array of lat/lon ends, pick the one closest to their mean direction.
// Used for fan-out arcs: aim the camera at the "median" end. For the demo's
// single-end arcs this just returns the lone end, but the helper is here so
// the camera path naturally extends to fan-out without changes.
function medianEnd(ends) {
  if (ends.length === 1) return ends[0];
  const mean = new Vector3();
  for (const e of ends) mean.add(polarToCartesian(e.lat, e.lon, 1));
  mean.normalize();
  let best = ends[0];
  let bestDot = -Infinity;
  for (const e of ends) {
    const v = polarToCartesian(e.lat, e.lon, 1);
    const d = v.dot(mean);
    if (d > bestDot) { bestDot = d; best = e; }
  }
  return best;
}

// World-Y unit axis, reused so we don't allocate per-frame in `_setRotationY`.
const Y_AXIS = new Vector3(0, 1, 0);

class CameraDirector {
  constructor(controller) {
    this.controller = controller;
    this.container = controller.container;
    this.parent = controller.parentContainer;
    this.controls = controller.controls;
    this.script = null;
    this._tmpQuat = new Quaternion();
    this._patchControllerHook();
  }

  // Set the container to a pure Y rotation, bypassing the Euler entirely.
  //
  // Why we can't use `container.rotation.y = θ`:
  //   The controls' auto-rotate uses rotateAroundWorldAxisY which left-
  //   multiplies a Y-rotation matrix and then calls
  //   Euler.setFromRotationMatrix(matrix). With Euler order XYZ that
  //   extraction is `y = asin(m13)`, which is clamped to ±π/2 — once the
  //   accumulated rotation exceeds that, the Euler "twists" and stuffs the
  //   overflow into rotation.x and rotation.z (e.g. π and -π for a half
  //   turn). Subsequent reads show e.g. rotation = (π, -0.74, -π).
  //   Writing only `.y` then leaves the bogus X/Z in place; the resulting
  //   quaternion is a different rotation, and the visible globe flickers
  //   between the intended direction and its mirror as the Euler
  //   alternates between equivalent representations.
  //
  // Quaternion.setFromAxisAngle gives us a pure Y rotation regardless of
  // what state the Euler was in.
  _setRotationY(theta) {
    this._tmpQuat.setFromAxisAngle(Y_AXIS, theta);
    this.container.quaternion.copy(this._tmpQuat);
    // Keep the Euler in sync so any code reading `rotation.y` (including
    // controls' next rotateAroundWorldAxisY which reads object.matrix and
    // resyncs Euler) sees a clean state.
    this.container.rotation.set(0, theta, 0);
  }

  // Hook before render(): controls.update runs inside handleUpdate and gets
  // overwritten by our tick, then render() rebuilds matrices via
  // updateMatrixWorld using the freshly-set rotation. If we hooked AFTER
  // render(), the Euler change wouldn't reach the matrix the renderer drew
  // with — visually the globe would freeze (matrix lags rotation by 1
  // frame, so rotation.y can advance while the painted matrix never does).
  _patchControllerHook() {
    const origRender = this.controller.render.bind(this.controller);
    this.controller.render = () => {
      this._tick();
      origRender();
    };
  }

  // Find container.rotation.y such that (lat, lon) ends up at world +Z
  // (front of camera). The simple atan2(x,z) approach DOESN'T work here:
  // parentContainer has an X-axis tilt (ROTATION_OFFSET.x ≈ 17°), so the
  // local point's y component leaks into world x. We have to solve the
  // full equation:
  //
  //   q = R_y(θ) · p          (rotate point in container's frame)
  //   world.x = M[0]·q        (apply parent's rotation; first row of matrix)
  //
  // Setting world.x = 0 gives  A·cos(θ) + B·sin(θ) = D, where
  //   A = m00·p.x + m02·p.z
  //   B = m00·p.z − m02·p.x
  //   D = −m01·p.y
  //
  // which has two solutions θ = φ ± acos(D/R) (R = √(A²+B²)). Pick the one
  // that puts the point at world +Z (front of camera) instead of −Z (back).
  _targetYForLatLon(lat, lon) {
    const M = new Matrix4().makeRotationFromEuler(this.parent.rotation);
    const e = M.elements;
    // three.js stores matrices column-major, so m[row][col] = e[col*4 + row].
    const m00 = e[0], m01 = e[4], m02 = e[8];   // row 0 (world x)
    const m20 = e[2], m21 = e[6], m22 = e[10];  // row 2 (world z)
    const p = polarToCartesian(lat, lon, 1);
    const A = m00 * p.x + m02 * p.z;
    const B = m00 * p.z - m02 * p.x;
    const D = -m01 * p.y;
    const R = Math.sqrt(A * A + B * B);
    if (R < 1e-9) return 0;
    const ratio = Math.max(-1, Math.min(1, D / R));
    const phi = Math.atan2(B, A);
    const offset = Math.acos(ratio);
    let bestTheta = 0;
    let bestZ = -Infinity;
    for (const theta of [phi + offset, phi - offset]) {
      const c = Math.cos(theta), s = Math.sin(theta);
      const qx = p.x * c + p.z * s;
      const qz = -p.x * s + p.z * c;
      // world.z = M[2] · q
      const worldZ = m20 * qx + m21 * p.y + m22 * qz;
      if (worldZ > bestZ) { bestZ = worldZ; bestTheta = theta; }
    }
    return bestTheta;
  }

  // World-space Z of (lat, lon) on the unit sphere when container is rotated
  // by `theta` around its local Y. Positive Z = camera-facing side. Used to
  // tell whether a point would be visible at a given globe rotation.
  _worldZAtY(lat, lon, theta) {
    const e = new Matrix4().makeRotationFromEuler(this.parent.rotation).elements;
    const m20 = e[2], m21 = e[6], m22 = e[10];
    const p = polarToCartesian(lat, lon, 1);
    const c = Math.cos(theta), s = Math.sin(theta);
    const qx = p.x * c + p.z * s;
    const qz = -p.x * s + p.z * c;
    return m20 * qx + m21 * p.y + m22 * qz;
  }

  // For (lat, lon) at parent's current tilt, compute the range of container
  // Y rotations θ at which the point is visible (worldZ ≥ threshold). The
  // formula:
  //
  //   worldZ(θ) = R·cos(θ − φ) + C
  //
  // — so the point is visible iff cos(θ − φ) ≥ (threshold − C)/R, which
  // gives a window centered at φ with half-width α = acos((threshold − C)/R).
  // Used to answer "is there ANY Y rotation that shows both endpoints?"
  // by intersecting two such windows on the θ circle.
  // threshold = 0.35 (out of 1.0) — a point is "on the visible face" only if
  // it's well clear of the silhouette edge. Smaller = both endpoints can be
  // grazing the rim and still count; larger = stricter, edge points are
  // treated as cross-side and the camera pans instead of holding.
  _visibilityWindow(lat, lon, threshold = 0.35) {
    const e = new Matrix4().makeRotationFromEuler(this.parent.rotation).elements;
    const m20 = e[2], m21 = e[6], m22 = e[10];
    const p = polarToCartesian(lat, lon, 1);
    const A = m20 * p.x + m22 * p.z;
    const B = m20 * p.z - m22 * p.x;
    const C = m21 * p.y;
    const R = Math.sqrt(A * A + B * B);
    if (R < 1e-9) {
      // Point on container Y axis (lat = ±90 in container frame). Visibility
      // doesn't depend on θ — it's just C vs threshold.
      const ok = C >= threshold;
      return { phi: 0, alpha: ok ? Math.PI : 0, always: ok, never: !ok };
    }
    const k = (threshold - C) / R;
    const phi = Math.atan2(B, A);
    if (k >= 1) return { phi, alpha: 0, never: true };
    if (k <= -1) return { phi, alpha: Math.PI, always: true };
    return { phi, alpha: Math.acos(k) };
  }

  // Shortest signed circular delta in (-π, π] from a to b.
  _circDelta(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Find a target Y rotation along the SHORTEST path from `fromY` (so we
  // don't spin the long way around) — three.js doesn't normalize rotations
  // automatically, so we adjust toY to the nearest equivalent angle.
  _shortestPath(fromY, toY) {
    let dy = (toY - fromY) % (Math.PI * 2);
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    return fromY + dy;
  }

  // Schedule a camera script around a spawn. Replaces any in-flight script
  // (interrupting the camera animation only — the spike/arc spawned earlier
  // continues its own animation independently).
  //
  // opts:
  //   spawnCallback: () => void   fired at the 0.3s mark (during the pre-pan)
  //   start: { lat, lon }         the spike location, or arc's gop
  //   ends: [{ lat, lon }]        zero entries for spike, ≥1 for arc
  schedule(opts) {
    // Read fromY from the QUATERNION (the only authoritative source — the
    // Euler may be in a "twisted" representation thanks to controls'
    // rotateAroundWorldAxisY accumulating past π/2). Container is always a
    // pure Y rotation, so the quaternion has the form (0, sin(θ/2), 0, cos(θ/2))
    // and we recover θ as 2*atan2(q.y, q.w).
    const q = this.container.quaternion;
    const fromY = 2 * Math.atan2(q.y, q.w);
    const timeline = [];

    if (!opts.ends || opts.ends.length === 0) {
      // Spike: pan to start over 0.5s, hold 3s.
      const sy = this._shortestPath(fromY, this._targetYForLatLon(opts.start.lat, opts.start.lon));
      timeline.push({ start: 0,    end: 500,  fromY,    toY: sy });
      timeline.push({ start: 500,  end: 3500, fromY: sy, toY: sy });
    } else {
      const end = medianEnd(opts.ends);
      // "Same side" question: does there EXIST any Y rotation θ at which
      // both endpoints are on the camera-facing hemisphere? Each endpoint
      // has a visibility window on the θ circle; we test whether the two
      // windows overlap. If they do, pick the center of the overlap as
      // the shot — it's the rotation that maximizes the smaller of the
      // two endpoints' worldZ (the "balanced" view of the arc, regardless
      // of latitude difference or near-180° longitude).
      const w1 = this._visibilityWindow(opts.start.lat, opts.start.lon);
      const w2 = this._visibilityWindow(end.lat, end.lon);
      let sameSide = false;
      let midY = fromY;
      if (!(w1.never || w2.never)) {
        // Circular distance between φ1 and φ2 must be < α1 + α2 for overlap.
        const d = this._circDelta(w1.phi, w2.phi);
        if (Math.abs(d) < w1.alpha + w2.alpha) {
          sameSide = true;
          // Center of overlap: clip both windows to their intersection on
          // the θ axis, take the midpoint. Then snap to shortest path.
          const lo = Math.max(w1.phi - w1.alpha, w2.phi - w2.alpha);
          const hi = Math.min(w1.phi + w1.alpha, w2.phi + w2.alpha);
          midY = this._shortestPath(fromY, (lo + hi) / 2);
        }
      }

      if (sameSide) {
        // Pan to the overlap center, hold 3s.
        timeline.push({ start: 0,    end: 500,  fromY,     toY: midY });
        timeline.push({ start: 500,  end: 3500, fromY: midY, toY: midY });
      } else {
        // Pan to start (0.5s) → hold start (0.5s) → pan to end (2s) →
        // hold end (0.5s).
        const sy = this._shortestPath(fromY, this._targetYForLatLon(opts.start.lat, opts.start.lon));
        const ey = this._shortestPath(sy,    this._targetYForLatLon(end.lat,        end.lon));
        timeline.push({ start: 0,    end: 500,  fromY,    toY: sy });
        timeline.push({ start: 500,  end: 1000, fromY: sy, toY: sy });
        timeline.push({ start: 1000, end: 3000, fromY: sy, toY: ey });
        timeline.push({ start: 3000, end: 3500, fromY: ey, toY: ey });
      }
    }

    this.script = {
      startTime: performance.now(),
      timeline,
      totalEnd: timeline[timeline.length - 1].end,
      spawnAt: 300,
      spawned: false,
      spawnCallback: opts.spawnCallback,
      returnDuration: 500,
    };

    // Suppress controls' auto-rotation while we own rotation.y.
    this.controls.autoRotationSpeedScalar = 0;
    this.controls.autoRotationSpeedScalarTarget = 0;

    console.log('[schedule] ' + JSON.stringify({
      start: opts.start,
      ends: opts.ends,
      fromY: +fromY.toFixed(3),
      timeline: timeline.map(s => ({ s: s.start, e: s.end, fY: +s.fromY.toFixed(3), tY: +s.toY.toFixed(3) })),
      pX: +this.parent.rotation.x.toFixed(3),
      pY: +this.parent.rotation.y.toFixed(3),
    }));
  }

  _tick() {
    if (!this.script) return;
    const t = performance.now() - this.script.startTime;
    if (this._debugFrames === undefined) this._debugFrames = 0;
    if (this._debugFrames < 25 || this._debugFrames % 30 === 0) {
      // eslint-disable-next-line no-console
      console.log('[tick] ' + JSON.stringify({
        t: Math.round(t),
        rotY_in: +this.container.rotation.y.toFixed(3),
        m_y: +Math.atan2(this.container.matrix.elements[8], this.container.matrix.elements[10]).toFixed(3),
        autoScalar: +this.controls.autoRotationSpeedScalar.toFixed(3),
      }));
    }
    this._debugFrames++;

    // 0.3s mark: the actual spike/arc spawn fires.
    if (!this.script.spawned && t >= this.script.spawnAt) {
      this.script.spawned = true;
      try { this.script.spawnCallback(); } catch (e) { console.error(e); }
    }

    if (t < this.script.totalEnd) {
      // Drive container.rotation.y from the active timeline segment.
      let seg = this.script.timeline[this.script.timeline.length - 1];
      for (const s of this.script.timeline) {
        if (t >= s.start && t < s.end) { seg = s; break; }
      }
      const segT = (t - seg.start) / (seg.end - seg.start);
      const eased = easeInOut(Math.max(0, Math.min(1, segT)));
      const newY = seg.fromY + (seg.toY - seg.fromY) * eased;
      const prevY = this.container.rotation.y;
      this._setRotationY(newY);
      this.controls.autoRotationSpeedScalar = 0;
      if (this._debugFrames < 25) {
        // eslint-disable-next-line no-console
        console.log('[set] ' + JSON.stringify({ t: Math.round(t), prevY: +prevY.toFixed(3), newY: +newY.toFixed(3), seg: seg.start + '-' + seg.end }));
      }
    } else if (t < this.script.totalEnd + this.script.returnDuration) {
      // Return phase: fade the auto-rotation scalar from 0 → 1 with the
      // same ease-in-out so the resume feels continuous with the hold.
      const rt = (t - this.script.totalEnd) / this.script.returnDuration;
      this.controls.autoRotationSpeedScalar = easeInOut(rt);
      this.controls.autoRotationSpeedScalarTarget = 1;
    } else {
      this.controls.autoRotationSpeedScalar = 1;
      this.controls.autoRotationSpeedScalarTarget = 1;
      this.script = null;
    }
  }
}

(async function bootstrap() {
  await ready();

  const globeContainer = document.querySelector(GLOBE_CONTAINER);
  if (!globeContainer) {
    console.error('[globe] no element matches', GLOBE_CONTAINER);
    return;
  }
  if (!webGLSupported()) {
    console.error('[globe] WebGL not supported');
    return;
  }

  const basePath = 'webgl-globe/';
  const imagePath = 'images/';
  const dataPath = `${basePath}data/`;

  // Parsed once and threaded through AppProps so construction-time choices
  // (sphere segment counts in the controller) and post-init runtime tweaks
  // (FOV, dot scale, halo uniforms further down) read the same flag.
  const isThing = new URLSearchParams(location.search).get('thing') === 'true';
  const isThingDebug = new URLSearchParams(location.search).get('thing-debug') === 'true';

  const app = new WebGLHeader({
    basePath,
    imagePath,
    dataPath,
    parentNode: globeContainer,
    globeRadius: GLOBE_RADIUS,
    lineWidth: 1.5,
    // 2× the spike radius in kiosk mode — at 800×480 the default 0.06
    // spikes were a couple of pixels wide and read as noise.
    spikeRadius: isThing ? 0.12 : 0.06,
    kiosk: isThing,
  });

  try {
    await app.init();
  } catch (err) {
    console.error('[globe] init failed:', err);
    return;
  }

  const controller = app.webglController;
  const merged = controller.mergedPrEntity;
  const open = controller.openPrEntity;

  // Permanently disable github's data-driven cycles.
  controller.indexIncrementSpeed = 0;
  if (merged) merged.DATA_INCREMENT_SPEED = 0;

  // Car Thing kiosk mode (`?thing=true`). The Spotify Car Thing runs
  // Chromium at 800×480 with software-only WebGL (Mali GPU isn't wired
  // up under X11), so every fragment is rasterized on a Cortex-A53 CPU.
  // Tune for "30fps, looks right at 800×480" rather than for visual
  // fidelity:
  //   1. Widen camera FOV 20° → 30°. tan(15°)/tan(10°) ≈ 1.52, so the
  //      whole scene shrinks to ~66% of its default size — the default
  //      framing is too tight for 480px tall, arc lofts (3-4× globe
  //      radius above the surface) run off the top.
  //   2. Apply the LOWEST quality preset for its non-dot side-effects
  //      (DPR=1 baseline, indexIncrementSpeed/3, raycastTrigger+6); we
  //      override the dot fields below.
  //   3. Sub-native render resolution. At pixelRatio = 0.6, the WebGL
  //      drawing buffer is 480×288 instead of the display's native
  //      800×480 — ~64% fewer fragments to shade per frame, which is
  //      where software WebGL spends almost all of its time. The browser
  //      upscales to fill the screen. The dots are big enough now that
  //      this doesn't read as blurry.
  //   4. Drop fps target to 30. Software WebGL on this CPU can't sustain
  //      60; leaving target=60 means the FPS-watcher's
  //      `fps < target * 0.875` check fires every frame. Pin
  //      fpsWarningThreshold = Infinity belt-and-suspenders so a stutter
  //      can't drop us below LOWEST into initPerformanceEmergency().
  //   5. Scale dots PROPORTIONALLY with K. Default look is
  //      size=0.095 / 200 rows / 2 dots-per-unit-X. To keep the pattern
  //      proportions identical (just zoomed), multiply size by K and
  //      divide BOTH the row count and longitudinal density by K. K=2
  //      gives ~2× larger dots and ~2× larger gaps — same dot-to-gap
  //      ratio as the default, just bigger to stay legible at this DPI
  //      and at 0.6× render scale.
  //   6. Freeze raycasting. The hover/popup pipeline isn't surfaced in
  //      the kiosk, and raycasting against thousands of arc + spike hit
  //      meshes per tick is pure waste here.
  if (isThing) {
    controller.camera.fov = 30;
    // Pull the near plane closer (170 → 150). With kiosk's containerScale
    // 1.77, the globe surface lands at world z ≈ 44.25 and spike tips
    // reach z ≈ 50.4 at the front-center — that's past the default near
    // plane (220 - 170 = 50), so the upper half of any centered spike
    // gets clipped while the ping ring at the surface is fine. Moving
    // the near plane to z = 70 (220 - 150) gives plenty of headroom.
    controller.camera.near = 150;
    controller.camera.updateProjectionMatrix();

    controller.renderQuality = 1;
    controller.updateRenderQuality();

    // Render at native 800×480. Sub-native (0.6) saved fragment work but
    // visibly blurred everything — the 30fps cap below + halo/globe
    // segment cuts (gated by AppProps.kiosk) cover the perf budget on
    // their own, so we don't need to also drop resolution.
    controller.renderer.setPixelRatio(1);

    controller.fpsTarget = 30;
    controller.fpsWarningThreshold = Infinity;

    const K = 2;
    controller.worldDotSize = 0.095 * K;
    controller.worldDotRows = Math.round(WORLD_DOT_ROWS / K);
    controller.dotResolutionX = 2 / K;
    controller.resetWorldMap();
    controller.buildWorldGeometry();

    controller.raycastTrigger = Infinity;

    // Drop input listeners. The Car Thing's touchscreen would otherwise
    // let people fling the globe around — fun, but undesirable for an
    // ambient kiosk. removeListeners() strips just the mouse/touch
    // handlers; auto-rotation (driven by Controls.update from the tick
    // loop) keeps running.
    if (controller.controls) controller.controls.removeListeners();

    // Cap the render loop at 30fps. requestAnimationFrame fires at the
    // panel refresh (60Hz on the Car Thing); without this cap we paint
    // every rAF, which is double the work the CPU can keep up with.
    // 1000/30 ≈ 33.34ms per frame.
    controller.minFrameMs = 1000 / 30;

    // Skip the entire interaction pipeline. The kiosk has no hover UI
    // (the popup is hidden via CSS in index.html), and handleUpdate()
    // bails early when dataInfo is null — the bail-out skips raycasting,
    // intersect tests, highlight resets, dragging checks, and the whole
    // openPrEntity/mergedPrEntity highlight pathway. With raycastTrigger
    // already at Infinity this just makes the savings explicit and
    // skips a couple of branches per frame on top of that.
    controller.dataInfo = null;

    // Widen the atmosphere halo. The halo is a thin rim on a 1.15× sphere
    // (see haloMaterialBlue in webgl-controller.js); its visible band is
    // controlled by `c` (rim threshold, default 0.7) and `p` (falloff
    // exponent, default 15). With FOV widened the globe is smaller in the
    // viewport, and at pixelRatio 0.6 the WebGL buffer is 480×288 — the
    // default rim is only a couple of fragments wide and gets washed out
    // by the upscale to 800×480. Pull `c` toward 1.0 to push the glow
    // further inward and lower `p` so the band stays soft, not a hard ring.
    // Default c=0.7/p=15 is tuned for the live web's 1470×745 viewport,
    // where the rim glow falloff covers ~30 pixels and reads as a clear
    // ring. On the Car Thing's 800×480 the same falloff covers ~15 pixels
    // and barely registers. Push c slightly higher and p lower to widen
    // the visible band — but stay well clear of c=0.95/p=4, which bled
    // the glow several globe-radii inward and made the body look small.
    controller.haloContainer.traverse((m) => {
      const u = m.material && m.material.uniforms;
      // Rim intensity at the silhouette = c^p. 0.88^7 ≈ 0.41 was a clear
      // ring; 0.92^6 ≈ 0.61 brightens the glow further while keeping the
      // band tight enough that it doesn't bleed across the body the way
      // c≥0.95 / p≤4 did.
      if (u && u.c && u.p) { u.c.value = 0.92; u.p.value = 6.0; }
    });

    // Halo bake disabled while debugging visual mismatch. With it enabled
    // the halo appears much thicker on the Car Thing than the live web
    // version, even at default c/p — suggests the bake itself is widening
    // the rim somehow (filter aliasing? double-blend?). Live render uses
    // the original ShaderMaterial sphere; only ~1ms/frame extra cost on
    // a 24-segment sphere, which is acceptable while we figure this out.
    // controller.bakeHaloToSprite();
  }

  // `?thing-debug=true` — pin a small FPS graph in the top-left corner.
  // Hooks renderer.render directly so it counts ACTUAL paints, not rAF
  // callbacks (the throttle in update() returns early without rendering
  // when minFrameMs hasn't elapsed, so rAF rate ≠ render rate). Buffer
  // is "timestamps within the last 1s", and its length at any instant
  // IS the current FPS. Sampled at 100ms into a rolling history.
  if (isThingDebug) {
    const cv = document.createElement('canvas');
    cv.width = 200;
    cv.height = 64;
    cv.style.cssText =
      'position:fixed;top:6px;left:6px;z-index:1000;pointer-events:none;' +
      'background:rgba(0,0,0,0.55);border:1px solid #444;';
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');

    const renderTimes = []; // performance.now() of each render in last 1s
    const fpsHistory = [];  // recent fps samples, drawn as the line
    const HIST_LEN = 100;
    const FPS_MAX = 60;

    const origRender = controller.renderer.render.bind(controller.renderer);
    controller.renderer.render = function (scene, camera) {
      origRender(scene, camera);
      const now = performance.now();
      renderTimes.push(now);
      while (renderTimes.length && now - renderTimes[0] > 1000) {
        renderTimes.shift();
      }
    };

    function draw() {
      const now = performance.now();
      while (renderTimes.length && now - renderTimes[0] > 1000) {
        renderTimes.shift();
      }
      const fps = renderTimes.length;
      fpsHistory.push(fps);
      if (fpsHistory.length > HIST_LEN) fpsHistory.shift();

      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, cv.width, cv.height);

      // Reference lines at 15/30/60 fps
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      [15, 30, 60].forEach((t) => {
        const y = cv.height - (t / FPS_MAX) * cv.height + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(cv.width, y);
      });
      ctx.stroke();

      // FPS line
      ctx.strokeStyle = fps >= 28 ? '#4f4' : fps >= 18 ? '#fc4' : '#f44';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      fpsHistory.forEach((v, i) => {
        const x = (i / (HIST_LEN - 1)) * cv.width;
        const y = cv.height - (Math.min(v, FPS_MAX) / FPS_MAX) * cv.height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Current fps text
      ctx.fillStyle = '#fff';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(`${fps} fps`, 6, 4);
    }
    setInterval(draw, 100);
  }

  const director = new CameraDirector(controller);

  // Spawn one pink arc — the camera director pans the globe first, then
  // fires the actual MergedPrEntity.spawnArc at the 0.3s mark.
  function spawnRandomArc() {
    if (!merged) return null;
    let gop, gm;
    for (let attempt = 0; attempt < 8; attempt++) {
      gop = randomLatLon();
      gm = randomLatLon();
      if (greatCircleAngle(gop, gm) > 0.06) break; // avoid degenerate short arcs
    }
    director.schedule({
      start: gop,
      ends: [gm],
      spawnCallback: () => merged.spawnArc(gop, gm),
    });
    return { gop, gm };
  }

  // Spawn one open-PR-style spike — director pans first, then fires the
  // actual OpenPrEntity.spawnSpike at the 0.3s mark.
  function spawnRandomSpike() {
    if (!open) return null;
    const { lat, lon } = randomLatLon();
    director.schedule({
      start: { lat, lon },
      ends: [],
      spawnCallback: () => open.spawnSpike(lat, lon),
    });
    return { lat, lon };
  }

  // Spawn arcs from a single source to one or more destinations. The director
  // pans to a fan-out-aware framing (medianEnd + visibility check) and the
  // arcs spawn together at the 0.3s mark.
  function spawnArcs(from, tos) {
    if (!merged || !tos.length) return null;
    director.schedule({
      start: from,
      ends: tos,
      spawnCallback: () => {
        for (const to of tos) merged.spawnArc(from, to);
      },
    });
    return { from, tos };
  }

  // Spawn a spike at a specific location with the camera director.
  function spawnSpike(at) {
    if (!open) return null;
    director.schedule({
      start: at,
      ends: [],
      spawnCallback: () => open.spawnSpike(at.lat, at.lon),
    });
    return at;
  }

  window.globe = {
    app,
    controller,
    merged,
    open,
    director,
    AppProps,
    spawnRandomArc,
    spawnRandomSpike,
    spawnArcs,
    spawnSpike,
  };
  document.dispatchEvent(new CustomEvent('globeReady'));
  // eslint-disable-next-line no-console
  console.log('[globe] ready — try window.globe.spawnRandomArc() / .spawnRandomSpike()');
})();
