import { Matrix4, Mesh, Raycaster, Vector3 } from 'three/build/three.module';

export const vectorZero = new Vector3();
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const { abs } = Math;

export function degreesToRadians(degrees) {
  return degrees * DEG2RAD;
}

export function radiansToDegrees(radians) {
  return radians * RAD2DEG;
}

export function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

export function rotateAroundWorldAxisY(object, radians, matrix) {
  const rotWorldMatrix = matrix || new Matrix4();
  rotWorldMatrix.identity();
  rotWorldMatrix.makeRotationY(radians);
  rotWorldMatrix.multiply(object.matrix);
  object.matrix.copy(rotWorldMatrix);
  object.rotation.setFromRotationMatrix(object.matrix);
}

export function disposeNode(node) {
  if (node instanceof Mesh) {
    if (node.geometry) {
      node.geometry.dispose();
    }

    if (node.material) {
      if (node.material.map) node.material.map.dispose();
      if (node.material.lightMap) node.material.lightMap.dispose();
      if (node.material.bumpMap) node.material.bumpMap.dispose();
      if (node.material.normalMap) node.material.normalMap.dispose();
      if (node.material.specularMap) node.material.specularMap.dispose();
      if (node.material.envMap) node.material.envMap.dispose();
      if (node.material.emissiveMap) node.material.emissiveMap.dispose();
      if (node.material.metalnessMap) node.material.metalnessMap.dispose();
      if (node.material.roughnessMap) node.material.roughnessMap.dispose();

      node.material.dispose(); // disposes any programs associated with the material
    }
  }
}

export function disposeHierarchy(node, callback) {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    disposeHierarchy(child, callback);

    if (typeof callback === 'function') {
      callback(child);
    }
  }
}

export function getMouseIntersection(mouse, camera, objects, raycaster, arrayTarget, recursive = false) {
  raycaster = raycaster || new Raycaster();

  raycaster.setFromCamera(mouse, camera);
  const intersections = raycaster.intersectObjects(objects, recursive, arrayTarget);
  return intersections.length > 0 ? intersections[0] : null;
}

export function latLonMidPoint(lat1, lon1, lat2, lon2) {
  lat1 = degreesToRadians(lat1);
  lon1 = degreesToRadians(lon1);
  lat2 = degreesToRadians(lat2);
  lon2 = degreesToRadians(lon2);

  const dLon = lon2 - lon1;
  const bX = Math.cos(lat2) * Math.cos(dLon);
  const bY = Math.cos(lat2) * Math.sin(dLon);
  const lat3 = Math.atan2(Math.sin(lat1) + Math.sin(lat2), Math.sqrt((Math.cos(lat1) + bX) * (Math.cos(lat1) + bX) + bY * bY));
  const lon3 = lon1 + Math.atan2(bY, Math.cos(lat1) + bX);

  return [radiansToDegrees(lat3), radiansToDegrees(lon3)];
}

/**
 * Convert [lat,lon] polar coordinates to [x,y,z] cartesian coordinates
 * @param {Number} lon
 * @param {Number} lat
 * @param {Number} radius
 * @return {Vector3}
 */
export function polarToCartesian(lat, lon, radius, out) {
  out = out || new Vector3();
  const phi = (90 - lat) * DEG2RAD;
  const theta = (lon + 180) * DEG2RAD;
  out.set(-(radius * Math.sin(phi) * Math.cos(theta)), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
  return out;
}

export function cleanBufferAttributeArray() {
  this.array = null;
}

export function takeScreenshot(renderer, scene, camera) {
  renderer.render(scene, camera);
  renderer.domElement.toBlob(
    function (blob) {
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = 'canvas.png';
      a.click();
    },
    'image/png',
    1.0
  );
}
