/* eslint-disable camelcase */
import {
  MeshBasicMaterial,
  Mesh,
  InstancedMesh,
  Group,
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
  InstancedBufferAttribute,
  AdditiveBlending,
  Vector3,
  CylinderBufferGeometry,
  Color,
  BoxBufferGeometry,
  RingBufferGeometry,
} from 'three/build/three.module';

import spikeVert from '../../glsl/spike.vert';
import spikeFrag from '../../glsl/spike.frag';
import particleVert from '../../glsl/particle.vert';
import particleFrag from '../../glsl/particle.frag';
import { clamp, hasValidCoordinates, map } from '../utils/utils';
import { polarToCartesian, vectorZero, cleanBufferAttributeArray, disposeHierarchy, disposeNode } from '../utils/three-utils';
import { AppProps } from '../core/app-props';

export default class OpenPrEntity {
  constructor(props) {
    this.props = props;
    this.init();
  }

  init() {
    const {
      maxAmount = 1000,
      data = [],
      radius = 1,
      camera,
      maxIndexDistance,
      visibleIndex,
      colors: { openPrColor, openPrParticleColor },
    } = this.props;

    const { pixelRatio, spikeRadius = 0.06 } = AppProps;

    this.mesh = new Group();

    const spikeIntersectMaterial = new MeshBasicMaterial({ color: 0x00ff00, visible: false });
    const spikeIntersectGeometry = new BoxBufferGeometry(0.75, 1, 0.75);
    spikeIntersectGeometry.translate(0, 0.5, 0);
    spikeIntersectGeometry.rotateX(-Math.PI / 2);
    const spikeIntersects = new InstancedMesh(spikeIntersectGeometry, spikeIntersectMaterial, maxAmount);
    this.mesh.add(spikeIntersects);

    const spikeMaterial = new MeshBasicMaterial({
      color: openPrColor,
      transparent: true,
      opacity: 0.4,
      alphaTest: 0.05,
      blending: AdditiveBlending,
    });

    spikeMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.cameraPosition = { value: camera.position };
      shader.uniforms.radius = { value: radius };
      shader.uniforms.visibleIndex = { value: visibleIndex };
      shader.uniforms.maxIndexDistance = { value: maxIndexDistance };
      shader.uniforms.highlightIndex = { value: -9999 };
      shader.vertexShader = spikeVert;
      shader.fragmentShader = spikeFrag;

      this.spikeUniforms = shader.uniforms;
    };

    const spikeIndices = [];
    const particleIndices = [];
    for (let i = 0; i < maxAmount; i++) {
      spikeIndices.push(i);
      particleIndices.push(i);
    }

    const spikeGeometry = new CylinderBufferGeometry(spikeRadius * pixelRatio, spikeRadius * pixelRatio, 1, 6, 1, false);
    spikeGeometry.setAttribute('index', new InstancedBufferAttribute(new Float32Array(spikeIndices), 1));
    spikeGeometry.translate(0, 0.5, 0);
    spikeGeometry.rotateX(-Math.PI / 2);
    const spikes = new InstancedMesh(spikeGeometry, spikeMaterial, maxAmount);
    this.mesh.add(spikes);

    const particleGeometry = new BufferGeometry();
    const particlePositions = [];
    const particleColors = [];
    const baseColor = new Color(openPrParticleColor);
    const dummy = new Group();
    const densities = this.getDensities();
    const { densityValues, minDensity, maxDensity } = densities;

    let dIndex = 0;
    for (let i = 0; i < maxAmount; i++) {
      const item = data[i];
      const { gop } = item;
      // Casting longitude and latitude to numbers
      const geo_user_opened = { lon: +gop.lon, lat: +gop.lat };

      if (!hasValidCoordinates(geo_user_opened)) {
        continue;
      }

      // spikes
      polarToCartesian(geo_user_opened.lat, geo_user_opened.lon, radius, dummy.position);

      const density = densityValues[dIndex++];
      dummy.scale.z = map(density, minDensity, maxDensity, radius * 0.05, radius * 0.2);

      dummy.lookAt(vectorZero);
      dummy.updateMatrix();
      spikes.setMatrixAt(i, dummy.matrix);
      spikeIntersects.setMatrixAt(i, dummy.matrix);

      // top of spike
      polarToCartesian(geo_user_opened.lat, geo_user_opened.lon, radius + dummy.scale.z + 0.25, dummy.position);
      particlePositions.push(dummy.position.x, dummy.position.y, dummy.position.z);
      particleColors.push(baseColor.r, baseColor.g, baseColor.b);
    }

    // NOTE: position and index attributes are intentionally NOT cleaned
    // via onUpload(cleanBufferAttributeArray) — spawnSpike updates the
    // particle positions (the white dots) and overwrites per-instance
    // index values to bypass the shader's data-cycle dimming, both of
    // which require the CPU-side arrays to remain mutable.
    particleGeometry.setAttribute(
      'position',
      new Float32BufferAttribute(particlePositions, 3)
    );

    particleGeometry.setAttribute('color', new Float32BufferAttribute(particleColors, 3).onUpload(cleanBufferAttributeArray));

    particleGeometry.setAttribute('index', new Float32BufferAttribute(particleIndices, 1));

    const particleMaterial = new PointsMaterial({
      alphaTest: 0.05,
      // 2× the white tip-dot size in kiosk mode so spike caps stay legible
      // at 800×480 — the default 0.8 is barely a pixel after projection.
      size: AppProps.kiosk ? 1.6 : 0.8,
      depthWrite: false,
    });

    particleMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.cameraPosition = { value: camera.position };
      shader.uniforms.radius = { value: radius };
      shader.uniforms.visibleIndex = { value: visibleIndex };
      shader.uniforms.maxIndexDistance = { value: maxIndexDistance };

      shader.vertexShader = particleVert;
      shader.fragmentShader = particleFrag;

      this.particleUniforms = shader.uniforms;
    };

    const particles = new Points(particleGeometry, particleMaterial);
    this.mesh.add(particles);

    this.materials = [spikeMaterial, particleMaterial];
    this.spikes = spikes;
    this.spikeIntersects = spikeIntersects;
    this.particles = particles;

    this.spikes.renderOrder = 3;
    this.particles.renderOrder = 4;

    // Wipe out github's data-driven state. The InstancedMesh slots and the
    // particle BufferGeometry positions were just set up from data.json, but
    // the demo only ever shows user-button spawns — so zero everything. The
    // shader's vScale-discard then guarantees no data-spike artifacts even
    // as visibleIndex sits at its initial value.
    const zero = new Group();
    zero.scale.set(0, 0, 0);
    zero.updateMatrix();
    for (let i = 0; i < maxAmount; i++) {
      this.spikes.setMatrixAt(i, zero.matrix);
      this.spikeIntersects.setMatrixAt(i, zero.matrix);
    }
    this.spikes.instanceMatrix.needsUpdate = true;
    this.spikeIntersects.instanceMatrix.needsUpdate = true;
    const ppos = this.particles.geometry.getAttribute('position');
    for (let i = 0; i < ppos.count; i++) ppos.setXYZ(i, 0, 0, 0);
    ppos.needsUpdate = true;

    // Active spawn animations — same pattern as MergedPrEntity.isAnimating.
    // Each entry: { slot, lat, lon, height, t0, GROW, HOLD, SHRINK,
    //               ring, ringMat }. Ticked from update() each frame.
    this._spawnedSpikes = [];
    // Stay inside visibleIndex ± (maxIndexDistance * 0.75) so the particle
    // shader's smoothstep keeps vAlpha at full and the white tip dot shows.
    this._spawnSlot = visibleIndex;
    this._spawnSlotMin = clamp(visibleIndex - (maxIndexDistance * 0.75), 0, maxAmount - 1) | 0;
    this._spawnSlotMax = clamp(visibleIndex + (maxIndexDistance * 0.75), 0, maxAmount - 1) | 0;

    // Reused RingBufferGeometry for the spawn ping at the spike base — same
    // dimensions as the one MergedPrEntity uses for its dotFade
    // (fadingLandingMeshFromMesh on line ~325 of merged-pr-entity.js).
    this._pingRingGeom = new RingBufferGeometry(1.55, 1.8, 16);
    this._spikeColor = openPrColor;
  }

  // Queue a spike at (lat, lon) — picks a round-robin InstancedMesh slot,
  // then update() will animate matrix scale.z grow → hold → shrink → 0 each
  // frame (the same pattern MergedPrEntity uses for its arcs). Also spawns
  // a ping ring at the base, animated identically to the arc landing's
  // dotFade (grow + opacity-fade, then dispose).
  spawnSpike(lat, lon, opts = {}) {
    const { radius = 1 } = this.props;
    // 70% of github's max spike height (their max is radius * 0.2).
    const height = opts.height ?? radius * 0.14;
    const slot = this._spawnSlot;
    this._spawnSlot = this._spawnSlot >= this._spawnSlotMax
      ? this._spawnSlotMin
      : this._spawnSlot + 1;

    // Bypass the shader's data-cycle dimming: both spike.vert and
    // particle.vert scale geometry/alpha by smoothstep over
    // distance(index, visibleIndex). With indexIncrementSpeed=0 (set in
    // entry.js so we drive spawns ourselves), visibleIndex never moves,
    // and any slot more than ~maxIndexDistance from it renders nearly
    // invisible — the cylinder + tip vanish, leaving only the ping ring
    // (which is a separate Mesh with no shader-side index logic). Force
    // the slot's `index` attribute to equal visibleIndex so the shader's
    // distance evaluates to 0 and the scale stays at 1.
    const vIndex = this.spikeUniforms && this.spikeUniforms.visibleIndex
      ? this.spikeUniforms.visibleIndex.value
      : 0;
    const spikeIndexAttr = this.spikes.geometry.attributes.index;
    if (spikeIndexAttr.array) {
      spikeIndexAttr.array[slot] = vIndex;
      spikeIndexAttr.needsUpdate = true;
    }
    const partIndexAttr = this.particles.geometry.attributes.index;
    if (partIndexAttr.array) {
      partIndexAttr.array[slot] = vIndex;
      partIndexAttr.needsUpdate = true;
    }

    // Ping ring at the base, color-matched to the spike body. Oriented like
    // merged-pr-entity's landings so it sits flat against the globe surface
    // (lookAt a point further from origin → tangent plane).
    const ringMat = new MeshBasicMaterial({
      color: this._spikeColor,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
    });
    const ring = new Mesh(this._pingRingGeom, ringMat);
    const ringPos = polarToCartesian(lat, lon, radius);
    const ringLookAt = polarToCartesian(lat, lon, radius + 5);
    ring.position.set(ringPos.x, ringPos.y, ringPos.z);
    ring.lookAt(ringLookAt.x, ringLookAt.y, ringLookAt.z);
    ring.scale.set(0, 0, 1);
    ring.renderOrder = 5;
    this.mesh.add(ring);

    this._spawnedSpikes.push({
      slot, lat, lon, height,
      t0: performance.now(),
      // Match the middle of the arc-lifetime range. Arc total =
      // (3*max + 3000) / 600 sec, with `max` (geometry.index.count)
      // varying ~360-3000 across short/long arcs → ~7s..20s. Midpoint ~13s.
      // Proportions follow the typical arc (GROW:HOLD:SHRINK ≈ 1:3:1).
      GROW: opts.grow ?? 2600,
      // 2× the original 7800ms — gives spikes ~15s of full-size visibility
      // before the despawn animation kicks in.
      HOLD: opts.hold ?? 15600,
      SHRINK: opts.shrink ?? 2600,
      ring, ringMat,
    });
    return { lat, lon, slot };
  }

  _tickSpawnedSpikes() {
    if (this._spawnedSpikes.length === 0) return;
    const { radius = 1 } = this.props;
    const now = performance.now();
    const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
    const dummy = new Group();
    const ppos = this.particles.geometry.getAttribute('position');
    const tmpVec = new Vector3();
    let dirty = false;
    for (let i = this._spawnedSpikes.length - 1; i >= 0; i--) {
      const s = this._spawnedSpikes[i];
      const t = now - s.t0;
      const TOTAL = s.GROW + s.HOLD + s.SHRINK;
      let v;
      if (t < s.GROW) v = ease(t / s.GROW);
      else if (t < s.GROW + s.HOLD) v = 1;
      else if (t < TOTAL) v = 1 - ease((t - s.GROW - s.HOLD) / s.SHRINK);
      else v = 0;

      // Same matrix recipe init() uses for data spikes — only diff is the
      // animated scale.z and that we zero everything when v == 0.
      polarToCartesian(s.lat, s.lon, radius, dummy.position);
      dummy.scale.set(1, 1, v * s.height);
      dummy.lookAt(vectorZero);
      dummy.updateMatrix();
      this.spikes.setMatrixAt(s.slot, dummy.matrix);
      this.spikeIntersects.setMatrixAt(s.slot, dummy.matrix);

      // Particle (white tip) sits at the current top of the cylinder, same
      // formula as init() (radius + scale.z + 0.25).
      polarToCartesian(s.lat, s.lon, radius + v * s.height + 0.25, tmpVec);
      ppos.setXYZ(s.slot, v > 0 ? tmpVec.x : 0, v > 0 ? tmpVec.y : 0, v > 0 ? tmpVec.z : 0);

      // Ping ring: matches the cadence of merged-pr's dotFade —
      // grows scale 0 → ~1.5 and opacity 1 → 0 over the GROW window, then
      // disposes. Once gone, s.ring is null and we skip this branch.
      if (s.ring) {
        const ringT = Math.min(t / s.GROW, 1);
        const ringEase = ease(ringT);
        const ringScale = ringEase * 1.5;
        s.ring.scale.set(ringScale, ringScale, 1);
        s.ringMat.opacity = 1 - ringEase;
        if (ringT >= 1) {
          this.mesh.remove(s.ring);
          s.ringMat.dispose();
          s.ring = null;
          s.ringMat = null;
        }
      }

      dirty = true;
      if (t >= TOTAL) {
        // Reset to fully-zeroed slot so future round-robin reuse starts clean.
        const zeroDummy = new Group();
        zeroDummy.scale.set(0, 0, 0);
        zeroDummy.updateMatrix();
        this.spikes.setMatrixAt(s.slot, zeroDummy.matrix);
        this.spikeIntersects.setMatrixAt(s.slot, zeroDummy.matrix);
        ppos.setXYZ(s.slot, 0, 0, 0);
        if (s.ring) {
          this.mesh.remove(s.ring);
          s.ringMat?.dispose();
        }
        this._spawnedSpikes.splice(i, 1);
      }
    }
    if (dirty) {
      this.spikes.instanceMatrix.needsUpdate = true;
      this.spikeIntersects.instanceMatrix.needsUpdate = true;
      ppos.needsUpdate = true;
    }
  }

  getDensities() {
    const { data, maxAmount = 1000, radius } = this.props;
    const vec = new Vector3();

    // figure out densities
    const locations = [];
    const densities = [];
    for (let i = 0; i < maxAmount; i++) {
      const item = data[i];
      const { gop } = item;
      // Casting longitude and latitude to floats
      const geo_user_opened = { lon: +gop.lon, lat: +gop.lat };
      if (geo_user_opened && hasValidCoordinates(geo_user_opened)) {
        polarToCartesian(geo_user_opened.lat, geo_user_opened.lon, radius, vec);
        locations.push(new Vector3().copy(vec));
        densities.push(0);
      }
    }

    const minDist = 10;
    locations.forEach((l1, index1) => {
      locations.forEach((l2, index2) => {
        if (index1 !== index2 && l1.distanceTo(l2) <= minDist) {
          densities[index1]++;
        }
      });
    });

    let minDensity = 99999;
    let maxDensity = -1;
    densities.forEach((d) => {
      if (d < minDensity) minDensity = d;
      else if (d > maxDensity) maxDensity = d;
    });

    return { densityValues: densities, minDensity, maxDensity };
  }

  setHighlightIndex(index) {
    if (this.spikeUniforms && this.spikeUniforms.highlightIndex.value !== index) {
      this.spikeUniforms.highlightIndex.value = index;
    }
  }

  update(visibleIndex) {
    if (this.spikeUniforms && this.particleUniforms) {
      const { maxAmount, maxIndexDistance } = this.props;

      if (this.spikeUniforms) this.spikeUniforms.visibleIndex.value = visibleIndex;
      if (this.particleUniforms) this.particleUniforms.visibleIndex.value = visibleIndex;

      const start = clamp((visibleIndex - maxIndexDistance) | 0, 0, maxAmount);
      const count = (maxIndexDistance * 2) | 0;
      const finalCount = clamp(start + count, 0, maxAmount);

      this.spikes.count = finalCount;
      this.particles.geometry.setDrawRange(start, count);
    }
    this._tickSpawnedSpikes();
  }

  dispose() {
    if (this.mesh) disposeHierarchy(this.mesh, disposeNode);
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);

    this.props = null;
    this.mesh = null;
    this.spikeUniforms = null;
    this.particleUniforms = null;
    this.materials = null;
    this.spikes = null;
    this.particles = null;
  }
}
