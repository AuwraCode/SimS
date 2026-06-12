import * as THREE from "three";
import type { TransitLine, TransitSystem } from "../sim/transit";
import { tramPositions } from "../sim/transit";
import type { Network } from "../sim/types";
import { disposeGroup } from "./util";

/**
 * The tram line in 3D: track bed offset beside the streets, platforms at
 * stops, teal trams gliding on the closed-form timetable, and little crowds
 * that physically accumulate on platforms while they wait — morning platform
 * crowding is just queued agents, like everything else in this city.
 */
export class Transit3D {
  readonly group = new THREE.Group();
  private readonly trams: THREE.Mesh[] = [];
  private readonly crowd: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  /** Piecewise track geometry: world coords + cumulative distance. */
  private readonly pts: { x: number; z: number; d: number }[] = [];

  constructor(
    net: Network,
    private readonly line: TransitLine,
  ) {
    // Track polyline, offset to the side of the street.
    const OFFSET = 11; // m from street center — its own right-of-way
    for (let i = 0; i < line.pathNodes.length; i++) {
      const n = net.nodes[line.pathNodes[i]];
      const prev = net.nodes[line.pathNodes[Math.max(0, i - 1)]];
      const next = net.nodes[line.pathNodes[Math.min(line.pathNodes.length - 1, i + 1)]];
      const dx = next.x - prev.x;
      const dz = next.y - prev.y;
      const len = Math.hypot(dx, dz) || 1;
      this.pts.push({
        x: n.x + (-dz / len) * OFFSET,
        z: n.y + (dx / len) * OFFSET,
        d: line.cumDistM[i],
      });
    }

    // Track bed: one flat box per segment.
    const bedMat = new THREE.MeshLambertMaterial({ color: 0x262d33 });
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1];
      const b = this.pts[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const bed = new THREE.Mesh(new THREE.BoxGeometry(len + 4, 0.22, 7), bedMat);
      bed.position.set((a.x + b.x) / 2, 0.11, (a.z + b.z) / 2);
      bed.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      this.group.add(bed);
    }

    // Platforms at stops.
    const platMat = new THREE.MeshLambertMaterial({ color: 0x9aa3b2 });
    for (const j of line.stopPathIdx) {
      const p = this.pts[j];
      const plat = new THREE.Mesh(new THREE.BoxGeometry(14, 0.7, 3), platMat);
      plat.position.set(p.x, 0.35, p.z + 5.2);
      this.group.add(plat);
    }

    // Trams (enough meshes for every concurrently active run).
    const tramGeo = new THREE.BoxGeometry(19, 3.4, 2.7);
    const tramMat = new THREE.MeshLambertMaterial({ color: 0x2fb3a8 });
    const maxActive = Math.ceil((line.totalS / line.headwayS + 1) * 2) + 2;
    for (let i = 0; i < maxActive; i++) {
      const tram = new THREE.Mesh(tramGeo, tramMat);
      tram.visible = false;
      this.trams.push(tram);
      this.group.add(tram);
    }

    // Waiting crowds: little figures clustered on platforms.
    this.crowd = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.5, 1.8, 0.5),
      new THREE.MeshLambertMaterial({ color: 0xd8cfc0 }),
      512,
    );
    this.crowd.frustumCulled = false;
    this.group.add(this.crowd);
  }

  /** World position + heading at a distance along the track. */
  coordAt(posM: number): { x: number; z: number; angle: number } {
    const pts = this.pts;
    let i = 1;
    while (i < pts.length - 1 && pts[i].d < posM) i++;
    const a = pts[i - 1];
    const b = pts[i];
    const span = b.d - a.d || 1;
    const f = Math.min(1, Math.max(0, (posM - a.d) / span));
    return {
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      angle: -Math.atan2(b.z - a.z, b.x - a.x),
    };
  }

  update(transit: TransitSystem, t: number): void {
    const poses = tramPositions(this.line, t);
    for (let i = 0; i < this.trams.length; i++) {
      const tram = this.trams[i];
      if (i < poses.length) {
        const c = this.coordAt(poses[i].posM);
        tram.visible = true;
        tram.position.set(c.x + (poses[i].dir === 1 ? 1.8 : -1.8), 1.8, c.z);
        tram.rotation.y = c.angle;
      } else {
        tram.visible = false;
      }
    }

    // Platform crowds (capped per platform, deterministic little grid).
    let ci = 0;
    const waiting = transit.waitingAt();
    for (let s = 0; s < this.line.stopPathIdx.length; s++) {
      const node = this.line.stopNodes[s];
      const count = waiting.get(node) ?? 0;
      if (count === 0) continue;
      const p = this.pts[this.line.stopPathIdx[s]];
      const show = Math.min(count, 14);
      for (let k = 0; k < show && ci < 512; k++) {
        this.dummy.position.set(p.x - 6 + (k % 7) * 2, 1.25, p.z + 4.4 + Math.floor(k / 7) * 1.4);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.crowd.setMatrixAt(ci++, this.dummy.matrix);
      }
    }
    this.crowd.count = ci;
    this.crowd.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    disposeGroup(this.group);
  }
}
