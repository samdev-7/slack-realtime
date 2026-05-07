// Patched: original implementation queried GitHub homepage-specific DOM
// (.js-globe-fallback-video, .js-globe-fallback-image) that doesn't exist
// outside github.com/globe. Replacing with a no-op so the FPS-emergency path
// and webglcontextlost handler don't crash the page on a stripped host.
//
// The original source is available in webgl-globe.bundle.min.js (the upstream
// compiled artifact) if you need to reference the github.com behavior.

export function showFallback() {
  // eslint-disable-next-line no-console
  console.warn('[webgl-globe] showFallback() called — no-op in this host');
  document.dispatchEvent(new CustomEvent('globeFallbackImage', { detail: {} }));
}
