import * as THREE from "three";
import type { Network } from "../sim/types";
import { disposeGroup } from "./util";

/**
 * Big civic landmarks that aren't ordinary blocks: the airport (apron, runway,
 * terminal, control tower with a turning radar, parked jets) and the river
 * port (quay, gantry cranes, container yard, a docked freighter). Both sit on
 * their land-use districts (`node.district`), which the building generator
 * skips. The only animation is a slowly turning radar — periodic decoration.
 */
interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
}

function districtBounds(net: Network, kind: string): Bounds | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const n of net.nodes) {
    if (n.district !== kind) continue;
    found = true;
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x);
    y1 = Math.max(y1, n.y);
  }
  if (!found) return null;
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

export class Landmarks3D {
  readonly group = new THREE.Group();
  private readonly radars: THREE.Object3D[] = [];

  constructor(net: Network) {
    const airport = districtBounds(net, "airport");
    if (airport !== null) this.buildAirport(airport);
    const port = districtBounds(net, "port");
    if (port !== null) this.buildPort(port);
  }

  private mat(color: number, emissive = 0x000000): THREE.MeshLambertMaterial {
    return new THREE.MeshLambertMaterial({ color, emissive });
  }

  private box(w: number, h: number, d: number, color: number, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(color));
    m.position.set(x, y, z);
    return m;
  }

  private buildAirport(b: Bounds): void {
    const w = b.x1 - b.x0 + 220;
    const d = b.y1 - b.y0 + 220;
    // Tarmac apron.
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(w, d), this.mat(0x3a3f47));
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(b.cx, 0.06, b.cy);
    this.group.add(apron);
    // Runway (east-west) with a dashed centreline.
    const runway = new THREE.Mesh(new THREE.PlaneGeometry(w - 40, 26), this.mat(0x23262c));
    runway.rotation.x = -Math.PI / 2;
    runway.position.set(b.cx, 0.1, b.cy + d / 2 - 50);
    this.group.add(runway);
    for (let i = 0; i < 9; i++) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.4), this.mat(0xe6e6e6, 0x555555));
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(b.cx - (w - 80) / 2 + i * ((w - 80) / 8), 0.14, b.cy + d / 2 - 50);
      this.group.add(dash);
    }
    // Terminal building with a glassy front.
    const terminal = this.box(w * 0.55, 12, 26, 0xcfd6df, b.cx, 6, b.cy - d / 2 + 40);
    this.group.add(terminal);
    this.group.add(this.box(w * 0.5, 7, 1, 0x6fb6e0, b.cx, 5, b.cy - d / 2 + 27.5));
    // Control tower + radar.
    const towerX = b.cx + w * 0.28;
    const towerZ = b.cy - d / 2 + 40;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3, 36, 10), this.mat(0xb9c0c9));
    shaft.position.set(towerX, 18, towerZ);
    this.group.add(shaft);
    this.group.add(this.box(8, 5, 8, 0x2b3038, towerX, 38, towerZ));
    const radar = this.box(7, 0.5, 2, 0xe2e6ec, towerX, 42, towerZ);
    this.radars.push(radar);
    this.group.add(radar);
    // Parked jets on the apron.
    for (let i = 0; i < 3; i++) {
      const jet = this.makeJet();
      jet.position.set(b.cx - w * 0.28 + i * 42, 0, b.cy + 8);
      jet.rotation.y = Math.PI / 2;
      this.group.add(jet);
    }
  }

  private makeJet(): THREE.Group {
    const jet = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.8, 18, 4, 8), this.mat(0xeef1f5));
    body.rotation.z = Math.PI / 2;
    body.position.y = 3;
    jet.add(body);
    const wings = this.box(4, 0.6, 22, 0xc3cbd8, 0, 3, 0);
    jet.add(wings);
    const tail = this.box(3, 5, 0.6, 0xc3cbd8, -9, 5.5, 0);
    jet.add(tail);
    return jet;
  }

  private buildPort(b: Bounds): void {
    const w = b.x1 - b.x0 + 180;
    const d = b.y1 - b.y0 + 160;
    // Concrete quay.
    const quay = new THREE.Mesh(new THREE.PlaneGeometry(w, d), this.mat(0x4a4f57));
    quay.rotation.x = -Math.PI / 2;
    quay.position.set(b.cx, 0.07, b.cy);
    this.group.add(quay);
    // Gantry cranes straddling the quay edge (toward the river = −z / north).
    for (let i = 0; i < 3; i++) {
      const cz = b.cy - d / 2 + 18;
      const cx = b.cx - w * 0.3 + i * (w * 0.3);
      const crane = new THREE.Group();
      for (const lx of [-7, 7]) {
        for (const lz of [-6, 6]) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 30, 6), this.mat(0xd8a23a));
          leg.position.set(lx, 15, lz);
          crane.add(leg);
        }
      }
      const boom = this.box(8, 1.6, 40, 0xe0ad44, 0, 30, -8);
      crane.add(boom);
      crane.add(this.box(5, 4, 5, 0xc4902f, 0, 27, 4));
      crane.position.set(cx, 0, cz);
      this.group.add(crane);
    }
    // Container yard.
    const cols = [0xc4503f, 0x3f7fc4, 0x4fae7a, 0xd6b23f, 0x8a6fc4];
    for (let i = 0; i < 24; i++) {
      const gx = i % 6;
      const gz = Math.floor(i / 6);
      const tiers = 1 + ((gx + gz) % 3);
      for (let t = 0; t < tiers; t++) {
        this.group.add(
          this.box(
            8,
            2.6,
            3.4,
            cols[(gx + gz + t) % cols.length],
            b.cx - 22 + gx * 9,
            1.4 + t * 2.7,
            b.cy + 14 + gz * 4.2,
          ),
        );
      }
    }
    // A docked freighter on the river side.
    const ship = new THREE.Group();
    ship.add(this.box(46, 5, 11, 0x2c3641, 0, 2.5, 0));
    for (let c = 0; c < 8; c++) {
      ship.add(this.box(3.6, 2.4, 8.6, cols[c % cols.length], -16 + c * 4.4, 7, 0));
    }
    ship.add(this.box(6, 7, 9, 0xe6e9ee, 19, 9, 0));
    ship.position.set(b.cx, 0, b.cy - d / 2 - 14);
    this.group.add(ship);
  }

  update(t: number): void {
    for (const r of this.radars) r.rotation.y = t * 0.6;
  }

  dispose(): void {
    disposeGroup(this.group);
  }
}
