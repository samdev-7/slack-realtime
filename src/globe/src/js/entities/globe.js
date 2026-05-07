import { Mesh, SphereBufferGeometry, Group, FrontSide, Vector3, Color, MeshStandardMaterial, MeshBasicMaterial } from 'three/build/three.module';
import vert from '../../glsl/globe-standard.vert';
import frag from '../../glsl/globe-standard.frag';

export default class Globe {
  constructor(props) {
    this.props = props;
    this.init();
  }

  init() {
    const {
      radius,
      detail = 50,
      renderer,
      shadowPoint,
      highlightPoint,
      highlightColor,
      frontHighlightColor = 0x36427d,
      waterColor = 0x0d1533,
      landColorFront = 0xffffff,
      shadowDist,
      highlightDist,
      frontPoint,
    } = this.props;

    const geometry = new SphereBufferGeometry(radius, detail, detail);

    // Kiosk path uses MeshBasicMaterial (no PBR pipeline) but injects a
    // CHEAP per-vertex version of the original custom shader's two
    // dominant visual effects:
    //   1. A "shadow" near a fixed world-space point — the original
    //      `mix(*0.01, full, smoothstep(0, shadowDist, distToShadowPoint))`
    //      that pushes the lower-right of the globe nearly black.
    //   2. A directional brightness from a world-space sun aligned with
    //      the original DirectionalLight (-50, 30, 10) — light comes
    //      from upper-left, lit-side gets ~1.5× boost.
    // Both are computed in the vertex shader (sphere has ~600 vertices,
    // negligible vs per-fragment PBR) and passed to the fragment via a
    // single varying. The full original chain (PBR + 3 lights + custom
    // highlights + dithering) runs at thousands of fragments per frame —
    // this version costs effectively zero on the same hardware.
    const materialFill = this.props.kiosk
      ? new MeshBasicMaterial({ color: waterColor })
      : new MeshStandardMaterial({
          color: waterColor,
          metalness: 0,
          roughness: 0.9,
        });

    this.uniforms = [];

    if (this.props.kiosk) {
      materialFill.onBeforeCompile = (shader) => {
        shader.uniforms.uSun = { value: new Vector3(-50, 30, 10).normalize() };
        shader.uniforms.uShadowPoint = { value: new Vector3().copy(shadowPoint) };
        shader.uniforms.uShadowDist = { value: shadowDist };
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform vec3 uSun;\nuniform vec3 uShadowPoint;\nuniform float uShadowDist;\nvarying float vLambert;'
          )
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
             // World-space vertex position. For a sphere centered at the
             // origin, normalize(worldPos) doubles as the surface normal.
             vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
             float ndotl = max(0.0, dot(normalize(worldPos), uSun));
             float boost = 0.6 + 1.0 * ndotl;
             float distToShadow = distance(worldPos, uShadowPoint);
             float shadowMul = mix(0.05, 1.0, smoothstep(0.0, uShadowDist, distToShadow));
             vLambert = boost * shadowMul;`
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vLambert;')
          .replace(
            'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
            'gl_FragColor = vec4( outgoingLight * vLambert, diffuseColor.a );'
          );
      };
    } else {
      materialFill.onBeforeCompile = (shader) => {
        shader.uniforms.shadowDist = { value: shadowDist };
        shader.uniforms.highlightDist = { value: highlightDist };
        shader.uniforms.shadowPoint = { value: new Vector3().copy(shadowPoint) };
        shader.uniforms.highlightPoint = { value: new Vector3().copy(highlightPoint) };
        shader.uniforms.frontPoint = { value: new Vector3().copy(frontPoint) };
        shader.uniforms.highlightColor = { value: new Color(highlightColor) };
        shader.uniforms.frontHighlightColor = { value: new Color(frontHighlightColor) };
        shader.vertexShader = vert;
        shader.fragmentShader = frag;
        this.uniforms.push(shader.uniforms);
      };

      materialFill.defines = {
        USE_HIGHLIGHT: 1,
        USE_HIGHLIGHT_ALT: 1,
        USE_FRONT_HIGHLIGHT: 1,
        DITHERING: 1,
      };
    }

    this.mesh = new Group();
    const meshFill = new Mesh(geometry, materialFill);
    meshFill.renderOrder = 1;
    this.mesh.add(meshFill);
    this.meshFill = meshFill;
    this.materials = [materialFill];
  }

  setShadowPoint(point) {
    if (this.uniforms) {
      this.uniforms.forEach((u) => {
        u.shadowPoint.value.copy(point);
      });
    }
  }

  setHighlightPoint(point) {
    if (this.uniforms) {
      this.uniforms.forEach((u) => {
        u.highlightPoint.value.copy(point);
      });
    }
  }

  setFrontPoint(point) {
    if (this.uniforms) {
      this.uniforms.forEach((u) => {
        u.frontPoint.value.copy(point);
      });
    }
  }

  setShadowDist(value) {
    if (this.uniforms) {
      this.uniforms.forEach((u) => {
        u.shadowDist.value = value;
      });
    }
  }

  setHighlightDist(value) {
    if (this.uniforms) {
      this.uniforms.forEach((u) => {
        u.highlightDist.value = value;
      });
    }
  }

  dispose() {
    this.mesh = null;
    this.materials = null;
    this.uniforms = null;
    this.meshFill = null;
  }
}
