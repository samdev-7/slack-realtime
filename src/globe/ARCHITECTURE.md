# Globe preview — spawning, timing & camera scheduling

This document covers how the local preview wires user button clicks through to:

1. The actual spawn of an arc / spike on the globe.
2. The animation lifetime of those primitives.
3. The camera director that pans the globe around each spawn.

All of the runtime code mentioned here lives under [`src/js/`](src/js/). The
upstream code (extracted from `@github/webgl-globe`'s sourcemap) is mostly
unchanged; the demo-specific logic is in [`src/js/entry.js`](src/js/entry.js)
and small additions to the entity classes.

---

## Public API

After bootstrap finishes, `window.globe` exposes:

```ts
window.globe = {
  app:         WebGLHeader,           // upstream app instance
  controller:  WebGLController,       // owns the scene/render loop
  merged:      MergedPrEntity,        // pink arcs
  open:        OpenPrEntity,          // light-blue spikes + tip dots
  director:    CameraDirector,        // rotation orchestrator
  AppProps,                           // upstream config singleton
  spawnRandomArc():   { gop, gm } | null,
  spawnRandomSpike(): { lat, lon },
};
```

`spawnRandomArc()` and `spawnRandomSpike()` are what the two on-screen
buttons call. They each:

1. Pick a random target lat/lon (uniform on the sphere).
2. Hand that to `director.schedule(...)` along with a `spawnCallback`.
3. The director runs the camera timeline and fires the spawn callback at
   the **0.3 s mark** (during the pre-pan, _before_ the camera has fully
   settled — see "Spawn timing offset" below).

Buttons → camera-aware spawns is wired in [`index.html`](index.html); the
script tag at the bottom binds clicks to `window.globe.spawnRandomArc()` /
`spawnRandomSpike()`.

---

## Arc spawn

`window.globe.spawnRandomArc()` ⇒ `MergedPrEntity.spawnArc(gop, gm)`
([`src/js/entities/merged-pr-entity.js`](src/js/entities/merged-pr-entity.js)).

`spawnArc(gop, gm)` is itself a thin wrapper around `addArc`, which:

- Validates lat/lon and rejects too-short arcs (great-circle dist `≤ 1.5`
  globe units).
- Builds a `CubicBezierCurve3` between the two points with one of three
  altitude scalars depending on great-circle distance (the same formula
  upstream uses to space short/medium/long arcs in different orbits).
- Builds a `TubeBufferGeometry` (visible) + a fat hit-detection one
  (invisible).
- Records a `landings` entry: a position + lookAt for the **source** dot
  (we ping at `gop`, not `gm` — see lifecycle below).
- Pushes the new entry index onto `lineMeshes` / `lineHitMeshes` /
  `landings`, and (in `spawnArc`) immediately `isAnimating.push(...)` so
  the next `update()` starts drawing the arc.

### Arc lifecycle (per-frame in `MergedPrEntity.update`)

The arc draws a sliding `[start, count]` window on its tube geometry's
draw range:

| Phase | Condition | Visual |
|---|---|---|
| GROW | `count < max` | Tube draws from `0..count`; line extends from gop. |
| HOLD | `max ≤ count < max·PAUSE_LENGTH_FACTOR + MIN_PAUSE` | Line fully drawn, holding. |
| SHRINK | `count ≥ threshold && start < max` | Trailing edge advances; arc fades from gop side. |
| END | `start ≥ max` | Removed from `isAnimating`. |

Constants (in `MergedPrEntity.init`):

- `lineAnimationSpeed = 600` units/sec (`count` and `start` advance at this rate).
- `PAUSE_LENGTH_FACTOR = 2`
- `MIN_PAUSE = 3000` ms
- Total lifetime ≈ `(3·max + 3000) / 600` seconds. With `max` (geometry
  index count) varying ~360–3000 across short/long arcs, that's **~7 s for
  short arcs to ~21 s for long ones**.

### Source ping ring + dot

The "ping" at the arc's source comes from the `landings` array. For each
animated arc, two extra meshes ride along:

- `dot`: a `CircleBufferGeometry(0.35, 8)` filled disc.
- `dotFade`: a `RingBufferGeometry(1.55, 1.8, 16)` ring that grows + fades.

Timing in `update()`:

1. `count < pauseEndThreshold` (= `max·2 + 3000`): grow `dot` toward scale
   1, fade `dotFade` from opacity 1 to 0. Dot stays full while the arc holds.
2. `count ≥ pauseEndThreshold`: mark `pingFading = true`, push to
   `animatingLandingsOut`. Dot now scales down each frame and disposes
   when scale < 0.01.
3. Pinging at the arc's **source** (gop) instead of destination is a
   one-line change from upstream — see the comment near `landingPos`
   in `addArc()`.

---

## Spike spawn

`window.globe.spawnRandomSpike()` ⇒ `OpenPrEntity.spawnSpike(lat, lon)`
([`src/js/entities/open-pr-entity.js`](src/js/entities/open-pr-entity.js)).

OpenPrEntity ships with two pre-built `InstancedMesh`es (`spikes`,
`spikeIntersects`) and a `Points` cloud (`particles`) — one slot per data
point in `data.json`. We don't render any of those data slots: the demo
zeroes every instance matrix and every particle position right after
upstream init runs (`init()` tail). Github's data-driven cycle never
appears.

`spawnSpike(lat, lon)` instead **repurposes** existing slots:

1. Pick the next round-robin slot in `[_spawnSlotMin, _spawnSlotMax]`.
   This window is `visibleIndex ± 0.75·maxIndexDistance`, which keeps the
   particle shader's `vAlpha` near 1 (so the white tip dot shows).
2. Push an entry to `_spawnedSpikes` with timing + a freshly-created
   ring mesh (same `RingBufferGeometry(1.55, 1.8, 16)` shape merged-pr-
   entity uses for its arc-source dotFade), color-matched to the spike.

`_tickSpawnedSpikes()` runs every frame from `update()` and drives the
animation by writing `setMatrixAt(slot, ...)` and `position.setXYZ(slot, ...)`
on the corresponding particle vertex.

### Spike lifecycle

For each entry in `_spawnedSpikes`:

| Phase | t range | Spike scale.z | Particle | Ring |
|---|---|---|---|---|
| GROW | 0 → 2600 ms | ease-in-out 0 → 1 | follows tip | scale 0 → 1.5, opacity 1 → 0 (over GROW) |
| HOLD | 2600 → 10400 ms | 1 | at full-height tip | (already gone) |
| SHRINK | 10400 → 13000 ms | ease-in-out 1 → 0 | shrinking with tip | — |
| END | ≥ 13 000 ms | 0 (slot zeroed) | (0,0,0) | — |

Timings live as `GROW=2600 / HOLD=7800 / SHRINK=2600` in the spawn entry
(can be overridden via `spawnSpike(lat, lon, { grow, hold, shrink })`),
and they're picked to match the **middle** of the arc-lifetime range:
arcs run ~7–21 s, so spikes target ~13 s with the same 1:3:1 grow/hold/
shrink ratio that arcs naturally produce.

### Spike geometry & height

- `spikeRadius = 0.06` (upstream `AppProps`).
- Spike height: `radius · 0.14` = **70 % of upstream's max** (their max
  was `radius · 0.2`). Override via `spawnSpike(..., { height })`.
- The cylinder + particle use upstream's exact materials (`spike.frag` /
  `particle.frag`) — we just write per-frame matrices into the InstancedMesh.

---

## Camera director

`CameraDirector` ([`src/js/entry.js`](src/js/entry.js)) orchestrates globe
rotation around button-driven spawns. The director only ever rotates
around the globe's local Y axis — **the axis tilt itself never changes**.

### How it hooks in

The constructor patches the controller's `render()`:

```js
this.controller.render = () => { this._tick(); origRender(); };
```

`_tick` runs **before** `renderer.render` so any rotation update we make
hits `updateMatrixWorld` on the same frame. (Hooking after render would
draw with stale matrices and the visual would lag the Euler by 1 frame.)

### Why we touch the quaternion, not `rotation.y`

`Euler.setFromRotationMatrix` (the call upstream `rotateAroundWorldAxisY`
makes after applying its increment) extracts Euler-XYZ via
`y = asin(m13)`, clamped to ±π/2. Once the accumulated auto-rotation
exceeds π/2, the Euler "twists" — `rotation.x = π, rotation.y = θ − π,
rotation.z = -π` and similar — and writing only `.y` leaves the bogus
X/Z components in place. The resulting quaternion is a different
rotation; the globe flickers between the intended direction and its
mirror.

`_setRotationY(θ)` sidesteps this by calling
`Quaternion.setFromAxisAngle(Y_AXIS, θ)` directly, then resetting the
Euler to a clean `(0, θ, 0)` so the next `setFromRotationMatrix` reads
back the same value.

### Computing the target rotation

`_targetYForLatLon(lat, lon)` solves, in closed form, for the θ that
puts the lat/lon point at world `+Z` (front of camera). The full
transform is

```
worldX = m00·(p.x cosθ + p.z sinθ) + m01·p.y + m02·(−p.x sinθ + p.z cosθ)
       = A cosθ + B sinθ + (m01·p.y)
       = R · cos(θ − φ) + (m01·p.y)
```

with `A = m00·p.x + m02·p.z`, `B = m00·p.z − m02·p.x`,
`R = √(A² + B²)`, `φ = atan2(B, A)`. Setting `worldX = 0` gives
`cos(θ − φ) = −m01·p.y / R`, which has two solutions `θ = φ ± acos(...)`.
We pick the one with positive `worldZ` (front of camera, not back).

### "Same side" check for arcs

Same closed-form approach for `worldZ`:

```
worldZ(θ) = R · cos(θ − φ) + (m21·p.y)
```

A point is visible iff `worldZ ≥ threshold` (= 0.35 — clear of the
silhouette edge by ≈ 20°). That's a closed interval on the θ circle:
`[φ − α, φ + α]` with `α = acos((threshold − C) / R)`. Two arcs same-
side ⇔ both windows non-empty AND
`|circular_delta(φ₁, φ₂)| < α₁ + α₂`. If overlap exists, target =
midpoint of the intersection. All closed-form, no iteration.

### Timeline shapes

Every spawn schedules a 4 s timeline through `director.schedule(opts)`:

#### Spike or arc with overlapping visibility windows

| t (ms) | Phase | Action |
|---|---|---|
| 0 → 500 | Pre-pan | Ease-in-out from current Y to target Y. Spawn fires at **t = 300 ms**. |
| 500 → 3500 | Hold | Stationary at target. |
| 3500 → 4000 | Return | `autoRotationSpeedScalar` eased 0 → 1 (controls take over again). |

#### Arc with non-overlapping windows (cross-side)

| t (ms) | Phase | Action |
|---|---|---|
| 0 → 500 | Pre-pan | Ease-in-out from current Y to **start** Y. Spawn fires at t = 300 ms. |
| 500 → 1000 | Hold start | Stationary at start. |
| 1000 → 3000 | Pan to end | Ease-in-out to **end** Y over 2 s. |
| 3000 → 3500 | Hold end | Stationary at end. |
| 3500 → 4000 | Return | Hand off to auto-rotate. |

### Spawn timing offset (the 0.3 s thing)

Spawns fire **before** the pre-pan finishes, on purpose. At t = 300 ms
the camera is ~76% of the way to its target (after ease-in-out). The
spike/arc starts growing in during that final ~200 ms, so by the time
the camera arrives the visual is already alive — feels less like
"camera arrives, then thing happens" and more like "thing emerges as
we settle on it".

### Interruption / fan-out

- A new `schedule()` call **kills the in-flight camera script** but
  leaves any already-spawned spike/arc animations alone (they live on
  their own queues in the entities). The new pre-pan starts from the
  current rotation, so transitions are continuous.
- `medianEnd(ends)` picks the end closest to the mean direction of all
  ends. Currently we always pass a single-element `ends` array, but the
  helper is in place for fan-out arcs (one start, multiple destinations)
  with no other code changes needed.

### Polar caveat

For points whose visibility never overlaps the camera-facing hemisphere
(near the South Pole given parent's ~17° X-tilt forward), no Y rotation
can put them at world centre. The director picks the closest possible
θ; the spike still spawns and animates, it just sits near the bottom
edge of the globe. This is a constraint of the "Y-axis only" rule, not
a bug.

---

## Where to tweak common things

| Want to change | Where |
|---|---|
| Spike lifetime (default 13 s) | `MergedPrEntity` — `GROW/HOLD/SHRINK` defaults in `spawnSpike`. |
| Arc tube speed | `lineAnimationSpeed` in `MergedPrEntity.init`. |
| Same-side strictness | `threshold` arg in `_visibilityWindow` (default 0.35). |
| Pre-pan duration / spawn offset | Timeline segments + `spawnAt` in `CameraDirector.schedule`. |
| Auto-rotate speed | `controller.rotationSpeed` in upstream `WebGLController.initBase`. |
| Disable github default cycle (already off) | `controller.indexIncrementSpeed = 0`, `merged.DATA_INCREMENT_SPEED = 0` in `entry.js`. |
