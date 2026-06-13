import * as THREE from "three";
import type { SimsConfig } from "../config";
import type { Places, Poi } from "../sim/places";
import { hash2 } from "../sim/rng";
import type { Network } from "../sim/types";
import { disposeGroup } from "./util";

/**
 * Points of interest as little landmarks: a turning ferris wheel for the
 * amusement park, a shimmering pool, neon-trimmed casinos, a red-cross
 * hospital, canopied gas stations, malls with rooftop signs, and the fire/
 * police stations the emergency subsystem dispatches from. The animated bits
 * (wheel spin, neon pulse, signs glowing after dark, water shimmer) are pure
 * periodic decoration driven by the sim clock — they encode no demand.
 */
export class PlacesView {
  readonly group = new THREE.Group();
  private readonly matCache = new Map<string, THREE.MeshLambertMaterial>();
  private readonly wheels: { grp: THREE.Object3D; speed: number }[] = [];
  private readonly neon: { mat: THREE.MeshLambertMaterial; base: THREE.Color; phase: number }[] =
    [];
  private readonly nightGlow: { mat: THREE.MeshLambertMaterial; base: THREE.Color }[] = [];
  private readonly water: { mat: THREE.MeshLambertMaterial; base: THREE.Color }[] = [];

  constructor(net: Network, cfg: SimsConfig, places: Places) {
    const pal = cfg.render.three.poi;
    for (const poi of places.all) {
      const node = net.nodes[poi.node];
      const ang = hash2(poi.id, 1) * Math.PI * 2;
      const r = cfg.network.spacingM * 0.3;
      const struct = this.build(poi, pal);
      struct.position.set(node.x + Math.cos(ang) * r, 0, node.y + Math.sin(ang) * r);
      struct.rotation.y = hash2(poi.id, 2) * Math.PI * 2;
      this.group.add(struct);
    }
  }

  private mat(color: number, emissive = 0x000000): THREE.MeshLambertMaterial {
    const key = `${color}:${emissive}`;
    let m = this.matCache.get(key);
    if (m === undefined) {
      m = new THREE.MeshLambertMaterial({ color, emissive });
      this.matCache.set(key, m);
    }
    return m;
  }

  private box(w: number, h: number, d: number, color: number, x = 0, y = h / 2, z = 0): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(color));
    m.position.set(x, y, z);
    return m;
  }

  /** Box with its OWN material — required for anything whose emissive animates. */
  private litBox(
    w: number,
    h: number,
    d: number,
    color: number,
    x = 0,
    y = h / 2,
    z = 0,
  ): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color }),
    );
    m.position.set(x, y, z);
    return m;
  }

  private build(poi: Poi, pal: SimsConfig["render"]["three"]["poi"]): THREE.Object3D {
    switch (poi.kind) {
      case "shop":
        return this.shop(pal, poi.id);
      case "gas":
        return this.gas(pal);
      case "mall":
        return this.mall(pal);
      case "hospital":
        return this.hospital(pal);
      case "pool":
        return this.pool(pal);
      case "park":
        return this.park(pal);
      case "casino":
        return this.casino(pal, poi.id);
      case "fireStation":
        return this.fireStation(pal);
      case "police":
        return this.police(pal, poi.id);
    }
  }

  private shop(pal: PoiPal, id: number): THREE.Object3D {
    const g = new THREE.Group();
    g.add(this.box(17, 9, 15, pal.shop));
    // Awning in a per-shop accent colour.
    const accents = [0xd94f4f, 0x3fae8f, 0xe0a23a, 0x6f7bd6];
    const accent = accents[Math.floor(hash2(id, 9) * accents.length)];
    const awning = this.box(17.5, 1.0, 4, accent, 0, 6.5, 8.5);
    awning.rotation.x = -0.32;
    g.add(awning);
    // Lit sign over the door — comes on after dark.
    const sign = this.litBox(8, 1.8, 0.6, 0x101010, 0, 9.6, 7.6);
    this.addNightGlow(sign, accent);
    g.add(sign);
    return g;
  }

  private gas(pal: PoiPal): THREE.Object3D {
    const g = new THREE.Group();
    for (const sx of [-9, 9]) {
      for (const sz of [-5, 5]) {
        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.7, 0.7, 9, 8),
          this.mat(0x9aa1ab),
        );
        pillar.position.set(sx, 4.5, sz);
        g.add(pillar);
      }
    }
    g.add(this.box(24, 1.6, 16, pal.gas, 0, 9.6, 0)); // canopy
    for (const px of [-5, 5]) g.add(this.box(1.4, 2.6, 3.2, 0xb8c0ca, px, 1.3, 0)); // pumps
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 13, 8), this.mat(0x6b727c));
    post.position.set(13, 6.5, 0);
    g.add(post);
    const sign = this.litBox(5, 4, 0.8, 0x101010, 13, 13, 0);
    this.addNightGlow(sign, pal.gasSign);
    g.add(sign);
    return g;
  }

  private mall(pal: PoiPal): THREE.Object3D {
    const g = new THREE.Group();
    g.add(this.box(70, 17, 46, pal.mall, 0, 8.5, 0));
    // Rooftop HVAC clutter.
    for (const [rx, rz] of [
      [-22, -12],
      [10, 8],
      [24, -6],
    ] as const) {
      g.add(this.box(8, 3.5, 8, 0x6c7079, rx, 18.8, rz));
    }
    // Parking apron + a few parked cars.
    const lot = new THREE.Mesh(new THREE.PlaneGeometry(40, 46), this.mat(0x2a2d33));
    lot.rotation.x = -Math.PI / 2;
    lot.position.set(57, 0.06, 0);
    g.add(lot);
    const carCols = [0xb7c0cc, 0xc25b5b, 0x5b7fc2, 0xd6c27a];
    for (let i = 0; i < 8; i++) {
      const car = this.box(
        4.4,
        1.5,
        2,
        carCols[i % carCols.length],
        46 + (i % 4) * 6,
        0.9,
        -14 + Math.floor(i / 4) * 26,
      );
      g.add(car);
    }
    // Big rooftop sign.
    const sign = this.litBox(26, 5, 1, 0x0d0d0d, 0, 22, 0);
    this.addNightGlow(sign, pal.mallSign);
    g.add(sign);
    return g;
  }

  private hospital(pal: PoiPal): THREE.Object3D {
    const g = new THREE.Group();
    g.add(this.box(30, 34, 26, pal.hospital, 0, 17, 0));
    // Standing red cross on the roof — a softly pulsing beacon.
    const crossMat = new THREE.MeshLambertMaterial({
      color: pal.hospitalCross,
      emissive: pal.hospitalCross,
    });
    const cross = new THREE.Group();
    cross.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 9, 1.4), crossMat));
    cross.add(new THREE.Mesh(new THREE.BoxGeometry(9, 2.4, 1.4), crossMat));
    cross.position.set(0, 39, 0);
    this.neon.push({ mat: crossMat, base: new THREE.Color(pal.hospitalCross), phase: 0 });
    g.add(cross);
    // Helipad disk.
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.4, 20), this.mat(0x3b4047));
    pad.position.set(0, 34.3, 0);
    g.add(pad);
    return g;
  }

  private pool(pal: PoiPal): THREE.Object3D {
    const g = new THREE.Group();
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(36, 28), this.mat(pal.poolDeck));
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(0, 0.08, 0);
    g.add(deck);
    const waterMesh = new THREE.Mesh(
      new THREE.BoxGeometry(24, 0.6, 15),
      new THREE.MeshLambertMaterial({ color: pal.pool, emissive: pal.pool }),
    );
    waterMesh.position.set(-2, 0.4, 0);
    this.water.push({
      mat: waterMesh.material as THREE.MeshLambertMaterial,
      base: new THREE.Color(pal.pool),
    });
    g.add(waterMesh);
    // Cabana + a slide running into the water.
    g.add(this.box(6, 3.4, 5, 0xe2dccb, 13, 1.7, -9));
    const slide = this.box(2.4, 0.6, 9, 0x49c0e0, 11, 4, 3);
    slide.rotation.x = 0.7;
    g.add(slide);
    const tower = this.box(2.6, 8, 2.6, 0xcfc6b2, 11, 4, 7);
    g.add(tower);
    return g;
  }

  private park(pal: PoiPal): THREE.Object3D {
    const g = new THREE.Group();
    const R = 17;
    const hubY = R + 3;
    // A-frame supports.
    for (const side of [-1, 1]) {
      for (const lean of [-1, 1]) {
        const leg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.18, 8),
          this.mat(0x8a8f99),
        );
        leg.position.set(side * 3.5, hubY / 2, lean * 6);
        leg.rotation.x = lean * 0.42;
        g.add(leg);
      }
    }
    // The wheel itself (rim + spokes + gondolas) — a group we spin.
    const wheel = new THREE.Group();
    wheel.position.set(0, hubY, 0);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(R, 0.5, 8, 40),
      new THREE.MeshLambertMaterial({ color: pal.parkRim, emissive: pal.parkRim }),
    );
    wheel.add(rim);
    this.neon.push({
      mat: rim.material as THREE.MeshLambertMaterial,
      base: new THREE.Color(pal.parkRim),
      phase: 1.0,
    });
    const cabinCols = [0xff5a5a, 0x5ad1ff, 0xffd23f, 0x8aff7a, 0xc98aff, 0xff9a3f];
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const cx = Math.cos(a) * R;
      const cy = Math.sin(a) * R;
      const spoke = this.box(R, 0.3, 0.3, 0xb9c0c9, cx / 2, cy / 2, 0);
      spoke.rotation.z = a;
      wheel.add(spoke);
      const cabin = this.box(2.6, 2.4, 2.4, cabinCols[i % cabinCols.length], cx, cy, 0);
      wheel.add(cabin);
    }
    this.wheels.push({ grp: wheel, speed: (Math.PI * 2) / 90 });
    g.add(wheel);
    // A couple of striped tents.
    for (const tx of [-22, 24]) {
      const tent = new THREE.Mesh(new THREE.ConeGeometry(6, 7, 10), this.mat(pal.park));
      tent.position.set(tx, 3.5, 14);
      g.add(tent);
    }
    return g;
  }

  private casino(pal: PoiPal, id: number): THREE.Object3D {
    const g = new THREE.Group();
    const w = 26;
    const h = 21;
    const d = 22;
    g.add(this.box(w, h, d, pal.casino));
    // Neon edge bars along the top rim.
    for (const [bx, bz, bw, bd] of [
      [0, d / 2, w, 0.6],
      [0, -d / 2, w, 0.6],
      [w / 2, 0, 0.6, d],
      [-w / 2, 0, 0.6, d],
    ] as const) {
      const bar = this.litBox(bw, 0.8, bd, 0x000000, bx, h, bz);
      const m = bar.material as THREE.MeshLambertMaterial;
      m.emissive = new THREE.Color(pal.casinoNeon);
      this.neon.push({ mat: m, base: new THREE.Color(pal.casinoNeon), phase: hash2(id, 4) * 6.28 });
      g.add(bar);
    }
    // Vertical marquee.
    const sign = this.litBox(2, 14, 6, 0x000000, 0, h + 7, 0);
    const sm = sign.material as THREE.MeshLambertMaterial;
    sm.emissive = new THREE.Color(pal.casinoNeon);
    this.neon.push({ mat: sm, base: new THREE.Color(pal.casinoNeon), phase: hash2(id, 5) * 6.28 });
    g.add(sign);
    return g;
  }

  private fireStation(pal: PoiPal): THREE.Object3D {
    const g = new THREE.Group();
    g.add(this.box(24, 12, 20, pal.fireStation, 0, 6, 0));
    g.add(this.box(24.4, 1.6, 20.4, 0xf0eee8, 0, 9, 0)); // white band
    g.add(this.box(5, 18, 5, 0xa83026, 9, 9, -7)); // hose-drying tower
    for (const dx of [-6, 0, 6]) g.add(this.box(5, 7, 0.6, 0x2a2d31, dx, 3.5, 10)); // bay doors
    return g;
  }

  private police(pal: PoiPal, id: number): THREE.Object3D {
    const g = new THREE.Group();
    g.add(this.box(24, 12, 20, pal.police, 0, 6, 0));
    g.add(this.box(24.4, 1.4, 20.4, 0xd7dde6, 0, 8.5, 0)); // trim band
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 10, 10),
      new THREE.MeshLambertMaterial({ color: 0x0a2a6a }),
    );
    beacon.position.set(0, 13.4, 0);
    const bm = beacon.material as THREE.MeshLambertMaterial;
    bm.emissive = new THREE.Color(0x3a7bff);
    this.neon.push({ mat: bm, base: new THREE.Color(0x3a7bff), phase: hash2(id, 7) * 6.28 });
    g.add(beacon);
    return g;
  }

  private addNightGlow(mesh: THREE.Mesh, color: number): void {
    const m = mesh.material as THREE.MeshLambertMaterial;
    m.emissive = new THREE.Color(color);
    this.nightGlow.push({ mat: m, base: new THREE.Color(color) });
  }

  /** Periodic decoration update: wheel spin, neon pulse, night signs, water. */
  update(t: number, day01: number): void {
    for (const w of this.wheels) w.grp.rotation.z = t * w.speed;
    for (const n of this.neon) {
      const k = 0.55 + 0.45 * Math.sin(t * 1.8 + n.phase);
      n.mat.emissive.copy(n.base).multiplyScalar(k);
    }
    const nightK = 0.2 + 0.8 * (1 - day01);
    for (const s of this.nightGlow) s.mat.emissive.copy(s.base).multiplyScalar(nightK);
    for (const w of this.water) {
      const k = 0.14 + 0.06 * Math.sin(t * 0.6);
      w.mat.emissive.copy(w.base).multiplyScalar(k);
    }
  }

  dispose(): void {
    disposeGroup(this.group);
    for (const m of this.matCache.values()) m.dispose();
  }
}

type PoiPal = SimsConfig["render"]["three"]["poi"];
