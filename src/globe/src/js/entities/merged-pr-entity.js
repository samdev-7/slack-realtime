/* eslint-disable camelcase */
import {
  AdditiveBlending,
  CircleBufferGeometry,
  CubicBezierCurve3,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingBufferGeometry,
  TubeBufferGeometry,
  Vector3
} from 'three/build/three.module';

import { polarToCartesian, latLonMidPoint, disposeHierarchy, disposeNode } from '../utils/three-utils';
import { hasValidCoordinates, map } from '../utils/utils';
import { AppProps } from '../core/app-props';

export default class MergedPrEntity {
  constructor(props) {
    this.props = props;
    this.init();
  }

  init() {
    const { data, radius = 1, camera, maxAmount = data.length, maxIndexDistance, visibleIndex, colors } = this.props;

    const { parentNode, lineWidth, pixelRatio } = AppProps;

    this.mesh = new Group();
    this.isAnimating = [];
    this.animatingLandingsOut = [];
    this.landings = [];
    this.lineMeshes = [];
    this.lineHitMeshes = [];
    this.highlightedMesh;
    this.colors = colors;
    this.landingGeo = new CircleBufferGeometry(0.35, 8);

    this.TUBE_RADIUS_SEGMENTS = 3;
    this.HIT_DETAIL_FRACTION = 4; // Higher value -> lower accuracy of hit/hover area
    this.DATA_INCREMENT_SPEED = 1.5; // How fast new lines are added
    // Arc HOLD duration in count-units = max*(FACTOR-1) + MIN_PAUSE.
    // Doubling both terms (2→3 and 3000→6000) doubles the held-on-globe
    // time without changing the draw or despawn animation speed (which
    // are governed by lineAnimationSpeed).
    this.PAUSE_LENGTH_FACTOR = 3;
    this.MIN_PAUSE = 6000;
    const TUBE_RADIUS = 0.08;
    const TUBE_HIT_RADIUS = 0.6;
    const MIN_LINE_DETAIL = 20;

    this.visibleIndex = 0;
    this.lineAnimationSpeed = 600;

    const ctrl1 = new Vector3();
    const ctrl2 = new Vector3();

    this.tubeMaterial = new MeshBasicMaterial({
      blending: AdditiveBlending,
      opacity: 0.95,
      transparent: true,
      color: this.colors.mergedPrColor
    });

    this.highlightMaterial = new MeshBasicMaterial({
      opacity: 1,
      transparent: false,
      color: this.colors.mergedPrColorHighlight
    });

    this.hiddenMaterial = new MeshBasicMaterial({ visible: false });


    // Stash arc-building constants so addArc() (called post-init for dynamic
    // user-spawned arcs) can use them too.
    this._radius = radius;
    this._tubeRadius = TUBE_RADIUS;
    this._tubeHitRadius = TUBE_HIT_RADIUS;
    this._minLineDetail = MIN_LINE_DETAIL;

    for (let i = 0; i < maxAmount; i++) {
      const { gop, gm } = data[i];
      this.addArc(gop, gm, i);
    }

    // Cycle bound: visibleIndex wraps within the seed data only. spawnArc()
    // appends entries past this index for one-shot playback — excluding them
    // from the cycle keeps live events from accumulating in the replay loop.
    this._cycleLength = this.lineMeshes.length;
    this._oneShotIndices = new Set();

    const { width, height } = parentNode.getBoundingClientRect();
  }

  /**
   * Build an arc mesh + landing record between two lat/lon points and append
   * to lineMeshes/lineHitMeshes/landings. Returns the new array index, or -1
   * if coordinates were invalid or the great-circle distance was too short.
   *
   * Used by init() in a loop over the data array, and by spawnArc() for
   * runtime user-injected arcs.
   */
  addArc(gop, gm, dataIndex) {
    const radius = this._radius;
    const TUBE_RADIUS = this._tubeRadius;
    const TUBE_HIT_RADIUS = this._tubeHitRadius;
    const MIN_LINE_DETAIL = this._minLineDetail;

    const geo_user_opened = { lat: +gop.lat, lon: +gop.lon };
    const geo_user_merged = { lat: +gm.lat, lon: +gm.lon };

    if (!hasValidCoordinates(geo_user_opened) || !hasValidCoordinates(geo_user_merged)) {
      return -1;
    }

    const vec1 = polarToCartesian(geo_user_opened.lat, geo_user_opened.lon, radius);
    const vec2 = polarToCartesian(geo_user_merged.lat, geo_user_merged.lon, radius);
    const dist = vec1.distanceTo(vec2);

    if (dist <= 1.5) return -1;

    let scalar;
    if (dist > radius * 1.85) {
      scalar = map(dist, 0, radius * 2, 1, 3.25);
    } else if (dist > radius * 1.4) {
      scalar = map(dist, 0, radius * 2, 1, 2.3);
    } else {
      scalar = map(dist, 0, radius * 2, 1, 1.5);
    }

    const midPoint = latLonMidPoint(geo_user_opened.lat, geo_user_opened.lon, geo_user_merged.lat, geo_user_merged.lon);
    const vecMid = polarToCartesian(midPoint[0], midPoint[1], radius * scalar);

    const ctrl1 = new Vector3().copy(vecMid);
    const ctrl2 = new Vector3().copy(vecMid);

    const t1 = map(dist, 10, 30, 0.2, 0.15);
    const t2 = map(dist, 10, 30, 0.8, 0.85);
    scalar = map(dist, 0, radius * 2, 1, 1.7);

    const tempCurve = new CubicBezierCurve3(vec1, ctrl1, ctrl2, vec2);
    tempCurve.getPoint(t1, ctrl1);
    tempCurve.getPoint(t2, ctrl2);
    ctrl1.multiplyScalar(scalar);
    ctrl2.multiplyScalar(scalar);

    const curve = new CubicBezierCurve3(vec1, ctrl1, ctrl2, vec2);

    // Landing dot/ring pings at the SOURCE (gop) of the arc — the original
    // upstream pinged the destination, but we want a "departure" beacon.
    const idxForOffset = dataIndex ?? this.lineMeshes.length;
    const landingPos = polarToCartesian(geo_user_opened.lat, geo_user_opened.lon, radius + idxForOffset / 10000);
    const lookAt = polarToCartesian(geo_user_opened.lat, geo_user_opened.lon, radius + 5);
    this.landings.push({ pos: landingPos, lookAt: lookAt });

    const curveSegments = MIN_LINE_DETAIL + parseInt(curve.getLength());
    const geometry = new TubeBufferGeometry(curve, curveSegments, TUBE_RADIUS, this.TUBE_RADIUS_SEGMENTS, false);
    const hitGeometry = new TubeBufferGeometry(curve, parseInt(curveSegments / this.HIT_DETAIL_FRACTION), TUBE_HIT_RADIUS, this.TUBE_RADIUS_SEGMENTS, false);
    geometry.setDrawRange(0, 0);
    hitGeometry.setDrawRange(0, 0);
    const lineMesh = new Mesh(geometry, this.tubeMaterial);
    const lineHitMesh = new Mesh(hitGeometry, this.hiddenMaterial);
    lineHitMesh.name = 'lineMesh';
    lineMesh.userData = { dataIndex: idxForOffset };
    lineHitMesh.userData = { dataIndex: idxForOffset, lineMeshIndex: this.lineMeshes.length };
    this.lineMeshes.push(lineMesh);
    this.lineHitMeshes.push(lineHitMesh);
    return this.lineMeshes.length - 1;
  }

  /**
   * Build an arc between two lat/lon points and immediately animate it.
   * Returns the new lineMeshes index or -1 if rejected (invalid coords or
   * too-short great-circle distance).
   */
  spawnArc(gop, gm) {
    const idx = this.addArc(gop, gm);
    if (idx < 0) return -1;
    this._oneShotIndices.add(idx);
    this.isAnimating.push(this.animatedObjectForIndex(idx));
    return idx;
  }

  resetHighlight() {
    if (this.highlightedMesh == null) return;
    this.highlightedMesh.material = this.tubeMaterial;
    this.highlightedMesh = null;
  }

  setHighlightObject(object) {
    const index = parseInt(object.userData.lineMeshIndex);
    const lineMesh = this.lineMeshes[index];
    if (lineMesh == this.highlightedMesh) return;
    lineMesh.material = this.highlightMaterial;
    this.resetHighlight();
    this.highlightedMesh = lineMesh;
  }

  update(delta = 0.01, visibleIndex) {
    let newVisibleIndex = parseInt(this.visibleIndex + delta * this.DATA_INCREMENT_SPEED);
    if (newVisibleIndex >= this._cycleLength) {
      newVisibleIndex = 0;
      this.visibleIndex = 0;
    }
    if (newVisibleIndex > this.visibleIndex && this.lineMeshes[newVisibleIndex]) {
      this.isAnimating.push(this.animatedObjectForIndex(newVisibleIndex));
    }

    let continueAnimating = [];
    let continueAnimatingLandingOut = [];

    for (const animated of this.isAnimating) {
      const max = animated.line.geometry.index.count;
      const count = animated.line.geometry.drawRange.count + delta * this.lineAnimationSpeed;
      let start = animated.line.geometry.drawRange.start + delta * this.lineAnimationSpeed;

      // Ping at the source: dot/ring grows while the arc is drawing, holds
      // through the post-arrival pause, then starts fading at the same moment
      // the arc itself begins to fade (i.e. when the trailing `start` index
      // would normally start advancing).
      const pauseEndThreshold = max * this.PAUSE_LENGTH_FACTOR + this.MIN_PAUSE;
      if (count < pauseEndThreshold && !animated.pingFading) {
        this.animateLandingIn(animated);
      } else if (count >= pauseEndThreshold && !animated.pingFading) {
        animated.pingFading = true;
        this.animatingLandingsOut.push(animated);
      }

      if (count >= max * this.PAUSE_LENGTH_FACTOR + this.MIN_PAUSE && start < max) {
        // Pause animation of this line if it's being hovered
        if (animated.line == this.highlightedMesh) {
          continueAnimating.push(animated);
          continue;
        }
        start = this.TUBE_RADIUS_SEGMENTS * Math.ceil(start/this.TUBE_RADIUS_SEGMENTS);
        const startHit = this.TUBE_RADIUS_SEGMENTS * Math.ceil(start/this.HIT_DETAIL_FRACTION/this.TUBE_RADIUS_SEGMENTS);
        animated.line.geometry.setDrawRange(start, count);
        animated.lineHit.geometry.setDrawRange(startHit, count/this.HIT_DETAIL_FRACTION);
        continueAnimating.push(animated);
      } else if (start < max) {
        animated.line.geometry.setDrawRange(0, count);
        animated.lineHit.geometry.setDrawRange(0, count/this.HIT_DETAIL_FRACTION);
        continueAnimating.push(animated);
      } else {
        this.endAnimation(animated);
      }
    }

    for (let i = 0; i < this.animatingLandingsOut.length; i++) {
      if (this.animateLandingOut(this.animatingLandingsOut[i])) {
        continueAnimatingLandingOut.push(this.animatingLandingsOut[i]);
      }
    }

    this.isAnimating = continueAnimating;
    this.animatingLandingsOut = continueAnimatingLandingOut;
    this.visibleIndex = this.visibleIndex + delta * this.DATA_INCREMENT_SPEED;
  }

  endAnimation(animated) {
    animated.line.geometry.setDrawRange(0, 0);
    animated.lineHit.geometry.setDrawRange(0, 0);
    this.mesh.remove(animated.line);
    this.mesh.remove(animated.lineHit);

    // One-shot (spawnArc) entries own a unique TubeBufferGeometry per arc
    // and are never replayed — release the GPU buffers and null the slot
    // so memory stays bounded across long uptimes. Materials are shared
    // (this.tubeMaterial / this.hiddenMaterial) so we don't dispose them.
    if (animated.oneShot) {
      animated.line.geometry.dispose();
      animated.lineHit.geometry.dispose();
      this.lineMeshes[animated.index] = null;
      this.lineHitMeshes[animated.index] = null;
      this.landings[animated.index] = null;
    }

    animated.line = null;
    animated.lineHit = null;

    // Only enqueue a landing-out animation if the ping wasn't already faded
    // out earlier (which is the case now that we trigger pingFading the
    // moment the arc finishes drawing). Pushing twice would crash because
    // animateLandingOut would run after the dot has already been disposed.
    if (!animated.pingFading) this.animatingLandingsOut.push(animated);
  }

  animateLandingIn(animated) {
    if (animated.dot.scale.x > 0.99) {
      if (animated.dotFade == null) return;
      animated.dotFade.material.opacity = 0;
      this.mesh.remove(animated.dotFade);
      disposeNode(animated.dotFade);
      animated.dotFade = null;
      return;
    }
    const scale = animated.dot.scale.x + (1 - animated.dot.scale.x) * 0.06;
    animated.dot.scale.set(scale, scale, 1);

    const scale2 = animated.dotFade.scale.x + (1 - animated.dotFade.scale.x) * 0.06;
    animated.dotFade.scale.set(scale2, scale2, 1);
    animated.dotFade.material.opacity = 1 - scale2;
  }

  animateLandingOut(animated) {
    if (animated.dot.scale.x < 0.01) {
      this.mesh.remove(animated.dot);
      animated.dot = null;
      disposeNode(animated.dot);

      if (animated.dotFade != null) {
        this.mesh.remove(animated.dotFade);
        disposeNode(animated.dotFade);
        animated.dotFade = null;
      }

      return false; // Return false if animation should end
    }

    const scale = animated.dot.scale.x - animated.dot.scale.x * 0.15;
    animated.dot.scale.set(scale, scale, 1);

    return true;
  }

  animatedObjectForIndex(index) {
    const line = this.lineMeshes[index];
    this.mesh.add(line);

    const lineHit = this.lineHitMeshes[index];
    this.mesh.add(lineHit);

    const landing = this.landingFromPositionData(this.landings[index]);
    this.mesh.add(landing);

    const dotFade = this.fadingLandingMeshFromMesh(landing);
    this.mesh.add(dotFade);

    return {
      line: line,
      lineHit: lineHit,
      dot: landing,
      dotFade: dotFade,
      index: index,
      oneShot: this._oneShotIndices.has(index)
    }
  }

  landingFromPositionData(data) {
    const landing = new Mesh(this.landingGeo, this.tubeMaterial);
    landing.position.set(data.pos.x, data.pos.y, data.pos.z);
    landing.lookAt(data.lookAt.x, data.lookAt.y, data.lookAt.z);
    landing.scale.set(0, 0, 1);

    return landing;
  }

  fadingLandingMeshFromMesh(mesh) {
    const newMesh = mesh.clone();
    newMesh.geometry = new RingBufferGeometry(1.55, 1.8, 16);
    newMesh.material = new MeshBasicMaterial({
      color: this.colors.mergedPrColor,
      blending: AdditiveBlending,
      transparent: true,
      opacity: 0,
      alphaTest: 0.02,
      visible: true
    });
    newMesh.scale.set(0, 0, 1);
    newMesh.renderOrder = 5;

    return newMesh;
  }

  dispose() {
    if (this.mesh) disposeHierarchy(this.mesh, disposeNode);
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);

    this.mesh = null;
  }
}
