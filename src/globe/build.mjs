// Local preview build for the @github/webgl-globe source under ./src.
// Uses esbuild to bundle our entry.js (which imports the original source
// alongside three.js + event-emitter from npm).
//
// Usage:  node src/globe/build.mjs           (one-shot)
//         node src/globe/build.mjs --watch   (rebuild on change)

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// .scss imports in the original source point to assets we don't need here
// (GitHub.com page styling). Treat them as empty modules.
const ignoreScss = {
  name: 'ignore-scss',
  setup(b) {
    b.onResolve({ filter: /\.scss$/ }, (args) => ({ path: args.path, namespace: 'ignore-scss' }));
    b.onLoad({ filter: /.*/, namespace: 'ignore-scss' }, () => ({ contents: '', loader: 'js' }));
  },
};

// Original source uses `three/build/three.module` (no extension); esbuild's
// strict resolver doesn't add `.js` for non-extension-less three subpaths.
const fixThreeExtension = {
  name: 'fix-three-ext',
  setup(b) {
    b.onResolve({ filter: /^three\/build\/three\.module$/ }, () => ({
      path: resolve(here, '../../node_modules/three/build/three.module.js'),
    }));
  },
};

const opts = {
  entryPoints: [resolve(here, 'src/js/entry.js')],
  outfile: resolve(here, 'dist/globe.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
  // Shader files are pre-baked as `export default "..."` strings, so just
  // load them as JS modules.
  loader: { '.vert': 'js', '.frag': 'js' },
  plugins: [ignoreScss, fixThreeExtension],
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('[build] watching…');
} else {
  await esbuild.build(opts);
}
