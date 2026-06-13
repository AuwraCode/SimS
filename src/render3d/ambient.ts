import * as THREE from "three";

interface FlightPath {
  start: THREE.Vector3;
  end: THREE.Vector3;
  lengthM: number;
  phase: number;
  group: THREE.Group;
}

/**
 * Ambient sky traffic — decoration only. Planes fly fixed great-line loops
 * as a periodic function of sim time (like the signal cycles, they encode
 * nothing about demand; they just make the sandbox feel inhabited).
 */
export class SkyTraffic {
  readonly group = new THREE.Group();
  private readonly flights: FlightPath[] = [];

  constructor(
    bounds: { x0: number; y0: number; x1: number; y1: number },
    count: number,
    private readonly altitudeM: number,
    private readonly speedMs: number,
  ) {
    const cx = (bounds.x0 + bounds.x1) / 2;
    const cz = (bounds.y0 + bounds.y1) / 2;
    const span = Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0) + 2600;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI + 0.35;
      const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const alt = this.altitudeM + i * 60;
      const start = new THREE.Vector3(cx, alt, cz).addScaledVector(dir, -span / 2);
      const end = new THREE.Vector3(cx, alt, cz).addScaledVector(dir, span / 2);

      const plane = new THREE.Group();
      const fuselage = new THREE.Mesh(
        new THREE.CapsuleGeometry(2.2, 26, 4, 8),
        new THREE.MeshLambertMaterial({ color: 0xe8edf4 }),
      );
      fuselage.rotation.z = Math.PI / 2;
      const wings = new THREE.Mesh(
        new THREE.BoxGeometry(6, 0.7, 30),
        new THREE.MeshLambertMaterial({ color: 0xc3cbd8 }),
      );
      const tail = new THREE.Mesh(
        new THREE.BoxGeometry(4, 8, 0.7),
        new THREE.MeshLambertMaterial({ color: 0xc3cbd8 }),
      );
      tail.position.set(-12, 3, 0);
      plane.add(fuselage);
      plane.add(wings);
      plane.add(tail);
      plane.rotation.y = Math.atan2(-dir.z, dir.x);
      this.group.add(plane);

      this.flights.push({
        start,
        end,
        lengthM: span,
        phase: (i * span) / count,
        group: plane,
      });
    }
  }

  update(simT: number): void {
    for (const f of this.flights) {
      const u = ((simT * this.speedMs + f.phase) % f.lengthM) / f.lengthM;
      f.group.position.lerpVectors(f.start, f.end, u);
    }
  }
}

interface ShipPath {
  start: THREE.Vector3;
  end: THREE.Vector3;
  lengthM: number;
  phase: number;
  group: THREE.Group;
}

/**
 * Cargo ships gliding the river east↔west — the waterborne twin of the
 * planes. Same periodic-loop decoration: their motion is a function of sim
 * time alone and couples to nothing.
 */
export class RiverShips {
  readonly group = new THREE.Group();
  private readonly ships: ShipPath[] = [];
  private readonly containerCols = [0xc4503f, 0x3f7fc4, 0x4fae7a, 0xd6b23f, 0x8a6fc4];

  constructor(
    bounds: { x0: number; y0: number; x1: number; y1: number },
    river: { y0: number; y1: number },
    count: number,
    private readonly speedMs: number,
  ) {
    const span = bounds.x1 - bounds.x0 + 1800;
    const cx = (bounds.x0 + bounds.x1) / 2;
    const cz = (river.y0 + river.y1) / 2;
    const laneStep = (river.y1 - river.y0) * 0.26;
    for (let i = 0; i < count; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      const z = cz + (i - (count - 1) / 2) * laneStep;
      const start = new THREE.Vector3(cx - (dir * span) / 2, 1, z);
      const end = new THREE.Vector3(cx + (dir * span) / 2, 1, z);
      const ship = this.buildShip(i);
      ship.rotation.y = dir === 1 ? 0 : Math.PI;
      this.group.add(ship);
      this.ships.push({ start, end, lengthM: span, phase: (i * span) / count, group: ship });
    }
  }

  private buildShip(i: number): THREE.Group {
    const ship = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(48, 5, 11),
      new THREE.MeshLambertMaterial({ color: 0x2c3641 }),
    );
    hull.position.y = 2.5;
    ship.add(hull);
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(40, 1, 10),
      new THREE.MeshLambertMaterial({ color: 0x3c4753 }),
    );
    deck.position.y = 5.4;
    ship.add(deck);
    // Container stacks.
    for (let c = 0; c < 9; c++) {
      const col = this.containerCols[(i + c) % this.containerCols.length];
      const tiers = 1 + ((i + c) % 2);
      for (let tier = 0; tier < tiers; tier++) {
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(3.6, 2.4, 8.6),
          new THREE.MeshLambertMaterial({ color: col }),
        );
        box.position.set(-17 + c * 4, 7 + tier * 2.5, 0);
        ship.add(box);
      }
    }
    // Bridge house + funnel at the stern.
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(6, 7, 9),
      new THREE.MeshLambertMaterial({ color: 0xe6e9ee }),
    );
    bridge.position.set(20, 9, 0);
    ship.add(bridge);
    const funnel = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 1.6, 5, 10),
      new THREE.MeshLambertMaterial({ color: 0xb24632 }),
    );
    funnel.position.set(22, 14, 0);
    ship.add(funnel);
    return ship;
  }

  update(simT: number): void {
    for (const f of this.ships) {
      const u = ((simT * this.speedMs + f.phase) % f.lengthM) / f.lengthM;
      f.group.position.lerpVectors(f.start, f.end, u);
    }
  }
}
