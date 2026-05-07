// Custom entry point for the local preview build.
// Wraps the upstream @github/webgl-globe code with:
//   - error capture around init() (instead of just calling showFallback)
//   - a window.globe API exposing webglController and helpers:
//       spawnRandomArc(): build a new pink arc between two random lat/lon
//                         points, animated like the GitHub homepage streamers
//       setPaused(bool):  pause/resume the default cycle of arcs and spikes
//                         from data.json (user-spawned arcs still play)

import WebGLHeader from './core/webgl-header';
import { GLOBE_RADIUS, GLOBE_CONTAINER } from './core/constants';
import { AppProps } from './core/app-props';

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

// Pick a uniform-area-on-sphere random lat/lon. Naïve uniform-in-[-90,90]
// would clump samples toward the poles; we want plausible "city" placement
// so we bias slightly toward populated latitudes, but for a quick demo
// uniform-on-sphere is fine.
function randomLatLon() {
  const lat = Math.acos(2 * Math.random() - 1) * (180 / Math.PI) - 90;
  const lon = Math.random() * 360 - 180;
  return { lat, lon };
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

  // Permanently disable github's data-driven cycles. The demo only renders
  // user-button spawns: every arc/spike comes from spawnRandomArc /
  // spawnRandomSpike. The data still loads (so the entities have the right
  // InstancedMesh slot count etc.), but nothing from data.json animates on
  // its own.
  controller.indexIncrementSpeed = 0;
  if (merged) merged.DATA_INCREMENT_SPEED = 0;

  // Spawn one pink arc between two random lat/lon points. Returns metadata
  // about the spawned arc, or null if the entity rejected it (very short
  // arcs are skipped — see MergedPrEntity.addArc).
  function spawnRandomArc() {
    if (!merged) return null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const gop = randomLatLon();
      const gm = randomLatLon();
      const idx = merged.spawnArc(gop, gm);
      if (idx >= 0) return { index: idx, gop, gm };
    }
    return null;
  }

  // Spawn one open-PR style spike (light-blue cylinder beam) at a random
  // lat/lon. Mirrors spawnRandomArc → MergedPrEntity.spawnArc — delegates to
  // OpenPrEntity.spawnSpike which builds the mesh using the entity's own
  // geometry/material settings and ticks the animation from update().
  function spawnRandomSpike() {
    if (!open) return null;
    const { lat, lon } = randomLatLon();
    return open.spawnSpike(lat, lon);
  }

  window.globe = {
    app,
    controller,
    merged,
    open,
    AppProps,
    spawnRandomArc,
    spawnRandomSpike,
  };
  document.dispatchEvent(new CustomEvent('globeReady'));
  // eslint-disable-next-line no-console
  console.log('[globe] ready — try window.globe.spawnRandomArc() / .spawnRandomSpike()');
})();
