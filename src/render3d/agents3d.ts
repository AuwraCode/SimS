import * as THREE from "three";
import { hash2 } from "../sim/rng";
import type { Simulation } from "../sim/sim";
import type { Network } from "../sim/types";
import { type EdgeFrame, edgeFrames, makeRamp3, rampAt, streetHalfWidth } from "./util";

/**
 * Every moving person, instanced: cars colored by how fast they are actually
 * going relative to their street's limit (jams read as red rivers), and
 * pedestrians on the sidewalks in stable per-person clothing colors.
 */
export class AgentsView {
  readonly group = new THREE.Group();
  private readonly cars: THREE.InstancedMesh;
  private readonly walkers: THREE.InstancedMesh;
  private readonly frames: EdgeFrame[];
  private readonly ramp = makeRamp3();
  readonly dummy = new THREE.Object3D();
  private readonly walkerPalette = [0xc9d4e0, 0xe0b8a0, 0x9fc7b8, 0xd6c08a, 0xa9b8d8, 0xc79fb6];
  private readonly colorScratch = new THREE.Color();

  constructor(net: Network, carCap: number, walkerCap: number) {
    this.frames = edgeFrames(net);
    this.cars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(4.4, 1.5, 2.0),
      new THREE.MeshLambertMaterial(),
      carCap,
    );
    this.cars.frustumCulled = false;
    this.walkers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.5, 1.8, 0.5),
      new THREE.MeshLambertMaterial(),
      walkerCap,
    );
    this.walkers.frustumCulled = false;
    this.group.add(this.cars);
    this.group.add(this.walkers);
  }

  update(sim: Simulation): void {
    const { dummy } = this;
    let ci = 0;
    const engine = sim.engine;
    engine.forEachActive((slot, edge) => {
      const f = this.frames[edge.id];
      const lane = engine.laneOf[slot];
      const off = 1.7 + lane * 3.0;
      const posM = engine.pos[slot];
      dummy.position.set(f.ax + f.dx * posM + f.px * off, 0.85, f.az + f.dz * posM + f.pz * off);
      dummy.rotation.set(0, Math.atan2(-f.dz, f.dx), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this.cars.setMatrixAt(ci, dummy.matrix);
      this.cars.setColorAt(ci, rampAt(this.ramp, engine.vel[slot] / edge.vmax));
      ci++;
    });
    this.cars.count = ci;
    this.cars.instanceMatrix.needsUpdate = true;
    if (this.cars.instanceColor !== null) this.cars.instanceColor.needsUpdate = true;

    let wi = 0;
    const cap = (this.walkers.instanceMatrix.count as number) ?? 4096;
    sim.walk.forEach((agentId, edgeId, posM) => {
      if (wi >= cap) return;
      const f = this.frames[edgeId];
      const edge = sim.net.edges[edgeId];
      const off = streetHalfWidth(edge) + 1.4;
      dummy.position.set(f.ax + f.dx * posM + f.px * off, 0.95, f.az + f.dz * posM + f.pz * off);
      dummy.rotation.set(0, Math.atan2(-f.dz, f.dx), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this.walkers.setMatrixAt(wi, dummy.matrix);
      this.walkers.setColorAt(
        wi,
        this.colorScratch.set(
          this.walkerPalette[Math.floor(hash2(agentId, 77) * this.walkerPalette.length)],
        ),
      );
      wi++;
    });
    this.walkers.count = wi;
    this.walkers.instanceMatrix.needsUpdate = true;
    if (this.walkers.instanceColor !== null) this.walkers.instanceColor.needsUpdate = true;
  }

  /** World position of an agent currently on the road / sidewalk, or null. */
  entityPosition(sim: Simulation, agentId: number, out: THREE.Vector3): boolean {
    const slot = sim.engine.slotOfAgent[agentId] ?? -1;
    if (slot >= 0) {
      const edge = sim.net.edges[sim.engine.edgeOf[slot]];
      const f = this.frames[edge.id];
      const off = 1.7 + sim.engine.laneOf[slot] * 3.0;
      const posM = sim.engine.pos[slot];
      out.set(f.ax + f.dx * posM + f.px * off, 0.9, f.az + f.dz * posM + f.pz * off);
      return true;
    }
    let found = false;
    sim.walk.forEach((id, edgeId, posM) => {
      if (found || id !== agentId) return;
      const f = this.frames[edgeId];
      const off = streetHalfWidth(sim.net.edges[edgeId]) + 1.4;
      out.set(f.ax + f.dx * posM + f.px * off, 1.0, f.az + f.dz * posM + f.pz * off);
      found = true;
    });
    return found;
  }

  dispose(): void {
    this.cars.geometry.dispose();
    (this.cars.material as THREE.Material).dispose();
    this.walkers.geometry.dispose();
    (this.walkers.material as THREE.Material).dispose();
  }
}
