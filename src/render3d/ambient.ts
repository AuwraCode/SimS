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
