// Custom entry point for the local preview build.
// Wraps the upstream @github/webgl-globe code with:
//   - a window.globe API exposing webglController and spawn helpers
//   - a CameraDirector that orchestrates rotation around button-driven
//     spawns: pre-pan to the spawn target, hold/sweep, then ease back to
//     auto-spinning. Spike/arc animations themselves continue independently.

import { Vector3, Matrix4, Quaternion } from 'three/build/three.module';
import WebGLHeader from './core/webgl-header';
import { GLOBE_RADIUS, GLOBE_CONTAINER } from './core/constants';
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

  const app = new WebGLHeader({
    basePath,
    imagePath,
    dataPath,
    parentNode: globeContainer,
    globeRadius: GLOBE_RADIUS,
    lineWidth: 1.5,
    spikeRadius: 0.06,
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
