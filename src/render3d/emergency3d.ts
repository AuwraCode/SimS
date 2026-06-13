import * as THREE from "three";
import type { EmergencySystem, EVehicle } from "../sim/emergency";
import { disposeGroup } from "./util";

/**
 * Emergencies in 3D: flickering flames with rising smoke and an orange glow at
 * each active fire, and red/blue strobing fire engines and police cars en
 * route. Pure reads of the deterministic emergency state — the flicker and
 * strobe are periodic functions of sim time.
 */
const FIRE_POOL = 10;
const VEH_POOL = 28;

interface FireRig {
  group: THREE.Group;
  flames: THREE.Mesh[];
  smoke: THREE.Mesh[];
  light: THREE.PointLight;
  phase: number;
}

interface VehRig {
  group: THREE.Group;
  body: THREE.Mesh;
  bar: THREE.Mesh;
  barMat: THREE.MeshLambertMaterial;
}

export class Emergency3D {
  readonly group = new THREE.Group();
  private readonly fireRigs: FireRig[] = [];
  private readonly fireVehRigs: VehRig[] = [];
  private readonly policeVehRigs: VehRig[] = [];
  private readonly flameColors = [0xff8a2a, 0xff5a1f, 0xffd23f];

  constructor() {
    for (let i = 0; i < FIRE_POOL; i++) this.fireRigs.push(this.buildFireRig(i));
    for (let i = 0; i < VEH_POOL; i++) {
      this.fireVehRigs.push(this.buildVehRig(0xd23026));
      this.policeVehRigs.push(this.buildVehRig(0x1b2f6b));
    }
  }

  private buildFireRig(i: number): FireRig {
    const group = new THREE.Group();
    group.visible = false;
    const flames: THREE.Mesh[] = [];
    for (let k = 0; k < 3; k++) {
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(2.4 - k * 0.5, 7 - k * 1.2, 7),
        new THREE.MeshLambertMaterial({
          color: this.flameColors[k],
          emissive: this.flameColors[k],
        }),
      );
      flame.position.set((k - 1) * 1.6, 3.5, 0);
      flames.push(flame);
      group.add(flame);
    }
    const smoke: THREE.Mesh[] = [];
    const smokeMat = new THREE.MeshLambertMaterial({
      color: 0x2b2b2f,
      transparent: true,
      opacity: 0.55,
    });
    for (let k = 0; k < 5; k++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 8), smokeMat);
      smoke.push(puff);
      group.add(puff);
    }
    const light = new THREE.PointLight(0xff7a2a, 0, 140, 2);
    light.position.y = 6;
    group.add(light);
    this.group.add(group);
    return { group, flames, smoke, light, phase: i * 1.7 };
  }

  private buildVehRig(color: number): VehRig {
    const group = new THREE.Group();
    group.visible = false;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(6, 2.4, 2.6),
      new THREE.MeshLambertMaterial({ color }),
    );
    body.position.y = 1.4;
    group.add(body);
    const barMat = new THREE.MeshLambertMaterial({ color: 0x111111, emissive: 0x000000 });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.6, 2.2), barMat);
    bar.position.y = 2.9;
    group.add(bar);
    this.group.add(group);
    return { group, body, bar, barMat };
  }

  update(em: EmergencySystem, t: number): void {
    // Fires.
    const burning = em.fires.filter((f) => f.state === "burning");
    for (let i = 0; i < this.fireRigs.length; i++) {
      const rig = this.fireRigs[i];
      if (i >= burning.length) {
        rig.group.visible = false;
        rig.light.intensity = 0;
        continue;
      }
      const fire = burning[i];
      rig.group.visible = true;
      rig.group.position.set(fire.x, 0, fire.y);
      const flick = 0.78 + 0.22 * Math.sin(t * 13 + rig.phase);
      for (let k = 0; k < rig.flames.length; k++) {
        const f = rig.flames[k];
        f.scale.set(1, flick + 0.12 * Math.sin(t * 17 + k), 1);
        f.rotation.y = t * (1.2 + k * 0.3);
      }
      for (let k = 0; k < rig.smoke.length; k++) {
        const puff = rig.smoke[k];
        const rise = ((t * 6 + k * 5) % 30) / 30; // 0→1 loop
        puff.position.set(Math.sin(t * 0.7 + k) * 2.5, 8 + rise * 22, Math.cos(t * 0.5 + k) * 2.5);
        const s = 0.6 + rise * 2.2;
        puff.scale.set(s, s, s);
        (puff.material as THREE.MeshLambertMaterial).opacity = 0.5 * (1 - rise);
      }
      rig.light.intensity = 2.4 + 1.3 * Math.sin(t * 11 + rig.phase);
    }

    // Vehicles, split by kind so each draws from its own coloured pool.
    let fi = 0;
    let pi = 0;
    for (const v of em.vehicles) {
      const pool = v.kind === "fire" ? this.fireVehRigs : this.policeVehRigs;
      const idx = v.kind === "fire" ? fi++ : pi++;
      if (idx >= pool.length) continue;
      this.placeVehicle(pool[idx], v, t);
    }
    for (let i = fi; i < this.fireVehRigs.length; i++) this.fireVehRigs[i].group.visible = false;
    for (let i = pi; i < this.policeVehRigs.length; i++)
      this.policeVehRigs[i].group.visible = false;
  }

  private placeVehicle(rig: VehRig, v: EVehicle, t: number): void {
    rig.group.visible = true;
    rig.group.position.set(v.x, 0.2, v.y);
    rig.group.rotation.y = -v.angle;
    // Strobe: alternate the bar between the vehicle's two warning colours.
    const blue = Math.sin(t * 9 + v.id) > 0;
    rig.barMat.emissive.setHex(blue ? 0x3a7bff : 0xff2b2b);
  }

  dispose(): void {
    disposeGroup(this.group);
  }
}
