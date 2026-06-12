import * as THREE from "three";
import type { NetEdge, Network } from "../sim/types";

/** Sim plane (x, y) maps to three.js ground plane (x, z); +y is up. */

export interface EdgeFrame {
  ax: number;
  az: number;
  dx: number;
  dz: number;
  /** Unit perpendicular pointing right of travel (driving side). */
  px: number;
  pz: number;
  len: number;
}

export function edgeFrames(net: Network): EdgeFrame[] {
  return net.edges.map((e) => {
    const a = net.nodes[e.from];
    const b = net.nodes[e.to];
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const len = Math.hypot(dx, dz);
    return { ax: a.x, az: a.y, dx: dx / len, dz: dz / len, px: -dz / len, pz: dx / len, len };
  });
}

/** Position along an edge with a rightward offset, written into `out`. */
export function pointOnEdge(
  f: EdgeFrame,
  posM: number,
  offM: number,
  out: THREE.Vector3,
  y: number,
): void {
  out.set(f.ax + f.dx * posM + f.px * offM, y, f.az + f.dz * posM + f.pz * offM);
}

/** Speed → color ramp (red stopped → green free), precomputed. */
export function makeRamp3(steps = 49): THREE.Color[] {
  const ramp: THREE.Color[] = [];
  for (let i = 0; i < steps; i++) {
    const r = i / (steps - 1);
    ramp.push(new THREE.Color().setHSL((125 / 360) * r, 0.82, 0.52));
  }
  return ramp;
}

export function rampAt(ramp: THREE.Color[], ratio: number): THREE.Color {
  const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return ramp[Math.round(r * (ramp.length - 1))];
}

/** Total paved half-width of a street (both directions of `edge`'s street). */
export function streetHalfWidth(edge: NetEdge): number {
  return edge.lanes * 3.0 + 1.0;
}

export function disposeGroup(group: THREE.Object3D): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry !== undefined) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) for (const m of mat) m.dispose();
    else if (mat !== undefined) mat.dispose();
  });
}
