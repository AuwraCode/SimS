import * as THREE from "three";
import type { SimsConfig } from "../config";
import { networkBounds, riverBand } from "../sim/network";
import { makeStream, uniform } from "../sim/rng";
import { isApproachGreen } from "../sim/traffic/junction";
import type { Network } from "../sim/types";
import { disposeGroup, streetHalfWidth } from "./util";

interface BuildingInfo {
  nodeId: number;
  biz: boolean;
  base: THREE.Color;
  /** Stable per-building randomness for the night-window pattern. */
  windowSeed: number;
  jobW: number;
}

/**
 * All static city geometry plus the slow-changing dynamic layers (signal
 * lamps, building lights, closure barriers).
 *
 * Buildings carry the sandbox's "businesses open" feel: a workplace building
 * brightens when its node's workersAt counter is positive — i.e. the moment
 * its first employee ACTUALLY arrives, which congestion can visibly delay.
 * Residential windows glow after dark in proportion to who is actually home.
 * Both signals derive from the agent simulation; none of it reads a schedule.
 */
export class CityMeshes {
  readonly group = new THREE.Group();
  private readonly signalMesh: THREE.InstancedMesh;
  private readonly signalNodes: number[] = [];
  private readonly buildingMesh: THREE.InstancedMesh;
  private readonly buildings: BuildingInfo[] = [];
  private readonly streetLampMesh: THREE.InstancedMesh;
  private readonly lampOn = new THREE.Color();
  private readonly lampOff = new THREE.Color(0x2a2f38);
  private readonly closureGroup = new THREE.Group();
  private readonly colorScratch = new THREE.Color();

  constructor(
    private readonly net: Network,
    cfg: SimsConfig,
  ) {
    const c3 = cfg.render.three;
    const b = networkBounds(net);
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.y0 + b.y1) / 2;
    const w = b.x1 - b.x0;
    const d = b.y1 - b.y0;

    // --- Ground plates ---
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 900, d + 900),
      new THREE.MeshLambertMaterial({ color: c3.ground }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.05, cz);
    this.group.add(ground);

    const band = riverBand(net, cfg.network);
    const northPlate = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 900, band.y0 - b.y0 + 450),
      new THREE.MeshLambertMaterial({ color: c3.groundNorth }),
    );
    northPlate.rotation.x = -Math.PI / 2;
    northPlate.position.set(cx, -0.02, (b.y0 - 450 + band.y0) / 2);
    this.group.add(northPlate);

    // --- River ---
    const river = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 900, band.y1 - band.y0),
      new THREE.MeshLambertMaterial({ color: c3.river }),
    );
    river.rotation.x = -Math.PI / 2;
    river.position.set(cx, 0.02, (band.y0 + band.y1) / 2);
    this.group.add(river);

    // --- Roads: one quad per street (even edge id = first of the directed pair) ---
    const localGeos: THREE.BufferGeometry[] = [];
    const arterialGeos: THREE.BufferGeometry[] = [];
    for (const e of net.edges) {
      if (e.id % 2 !== 0) continue;
      const a = net.nodes[e.from];
      const bN = net.nodes[e.to];
      const len = Math.hypot(bN.x - a.x, bN.y - a.y);
      const geo = new THREE.PlaneGeometry(len + 8, streetHalfWidth(e) * 2);
      geo.rotateX(-Math.PI / 2);
      geo.rotateY(-Math.atan2(bN.y - a.y, bN.x - a.x));
      geo.translate((a.x + bN.x) / 2, e.isBridge ? 0.12 : 0.05, (a.y + bN.y) / 2);
      (e.klass === "arterial" ? arterialGeos : localGeos).push(geo);

      if (e.isBridge) {
        // Side rails so bridges read as structures over the water.
        for (const side of [-1, 1]) {
          const rail = new THREE.Mesh(
            new THREE.BoxGeometry(len + 8, 2.2, 0.8),
            new THREE.MeshLambertMaterial({ color: 0x6b7484 }),
          );
          const px = -(bN.y - a.y) / len;
          const pz = (bN.x - a.x) / len;
          const off = (streetHalfWidth(e) + 0.6) * side;
          rail.position.set((a.x + bN.x) / 2 + px * off, 1.1, (a.y + bN.y) / 2 + pz * off);
          rail.rotation.y = -Math.atan2(bN.y - a.y, bN.x - a.x);
          this.group.add(rail);
        }
      }
    }
    const mergeInto = (geos: THREE.BufferGeometry[], color: number): void => {
      if (geos.length === 0) return;
      for (const g of geos) {
        const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
        this.group.add(mesh);
      }
    };
    mergeInto(localGeos, c3.roadLocal);
    mergeInto(arterialGeos, c3.roadArterial);

    // --- Signals: two lamps per signalized junction (NS state / EW state) ---
    for (const node of net.nodes) if (node.signal !== null) this.signalNodes.push(node.id);
    this.signalMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1.6, 8, 8),
      new THREE.MeshBasicMaterial(),
      this.signalNodes.length * 2,
    );
    const dummy = new THREE.Object3D();
    for (let i = 0; i < this.signalNodes.length; i++) {
      const node = net.nodes[this.signalNodes[i]];
      dummy.position.set(node.x - 4, 7.5, node.y);
      dummy.updateMatrix();
      this.signalMesh.setMatrixAt(i * 2, dummy.matrix);
      dummy.position.set(node.x + 4, 7.5, node.y);
      dummy.updateMatrix();
      this.signalMesh.setMatrixAt(i * 2 + 1, dummy.matrix);
    }
    this.signalMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.signalMesh);

    // --- Buildings (deterministic from their own seed stream) ---
    const rng = makeStream(cfg.seed, "buildings");
    const inCbd = (col: number, row: number): boolean =>
      col >= cfg.network.cbd.col0 &&
      col <= cfg.network.cbd.col1 &&
      row >= cfg.network.cbd.row0 &&
      row <= cfg.network.cbd.row1;
    const hubAt = (col: number, row: number): boolean =>
      cfg.network.hubs.some((h) => h.col === col && h.row === row);

    interface Box {
      x: number;
      z: number;
      sx: number;
      sy: number;
      sz: number;
      info: BuildingInfo;
    }
    const boxes: Box[] = [];
    const bizPalette = [0x76808f, 0x8a93a5, 0x9aa6b8, 0x6f7a92];
    const homePalette = [0x9a7f6a, 0x8d7a5f, 0xa08a74, 0x7c6f5c];
    for (const node of net.nodes) {
      // Airport & port get bespoke landmarks instead of generic blocks.
      if (node.district === "airport" || node.district === "port") continue;
      const cbd = inCbd(node.col, node.row);
      const hub = hubAt(node.col, node.row);
      const heights = cbd
        ? c3.heights.cbd
        : hub
          ? c3.heights.hub
          : node.north
            ? c3.heights.northRes
            : c3.heights.southRes;
      const count = Math.round(
        uniform(rng, c3.buildingsPerNode[0], c3.buildingsPerNode[1] + (cbd ? 1 : 0)),
      );
      for (let k = 0; k < count; k++) {
        const quadX = rng() < 0.5 ? -1 : 1;
        const quadZ = rng() < 0.5 ? -1 : 1;
        const offX = uniform(rng, 20, cfg.network.spacingM / 2 - 26) * quadX;
        const offZ = uniform(rng, 20, cfg.network.spacingM / 2 - 26) * quadZ;
        const h = uniform(rng, heights[0], heights[1]);
        const biz = cbd || hub || node.jobW >= 10 || (node.north && rng() < 0.35);
        const palette = biz ? bizPalette : homePalette;
        const info: BuildingInfo = {
          nodeId: node.id,
          biz,
          base: new THREE.Color(palette[Math.floor(rng() * palette.length)]),
          windowSeed: rng(),
          jobW: node.jobW,
        };
        boxes.push({
          x: node.x + offX,
          z: node.y + offZ,
          sx: uniform(rng, 14, 30),
          sy: h,
          sz: uniform(rng, 14, 30),
          info,
        });
      }
    }
    this.buildingMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial(),
      boxes.length,
    );
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      dummy.position.set(box.x, box.sy / 2, box.z);
      dummy.scale.set(box.sx, box.sy, box.sz);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      this.buildingMesh.setMatrixAt(i, dummy.matrix);
      this.buildingMesh.setColorAt(i, box.info.base);
      this.buildings.push(box.info);
    }
    this.buildingMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.buildingMesh);

    // --- Pitched roofs on short houses; rooftop plant on towers ---
    const roofBoxes = boxes.filter((b) => !b.info.biz && b.sy <= 20);
    const roofMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 4),
      new THREE.MeshLambertMaterial({ color: 0x6e4b3a }),
      roofBoxes.length,
    );
    for (let i = 0; i < roofBoxes.length; i++) {
      const box = roofBoxes[i];
      const roofH = uniform(rng, 3.5, 6.5);
      dummy.position.set(box.x, box.sy + roofH / 2, box.z);
      dummy.rotation.set(0, Math.PI / 4, 0); // align the 4-sided pyramid to the walls
      dummy.scale.set(box.sx * 0.78, roofH, box.sz * 0.78);
      dummy.updateMatrix();
      roofMesh.setMatrixAt(i, dummy.matrix);
    }
    roofMesh.instanceMatrix.needsUpdate = true;
    this.group.add(roofMesh);

    const towerBoxes = boxes.filter((b) => b.info.biz && b.sy >= 38);
    const unitMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0x474c56 }),
      towerBoxes.length,
    );
    for (let i = 0; i < towerBoxes.length; i++) {
      const box = towerBoxes[i];
      const uh = uniform(rng, 3, 6);
      dummy.position.set(box.x, box.sy + uh / 2, box.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(box.sx * 0.42, uh, box.sz * 0.42);
      dummy.updateMatrix();
      unitMesh.setMatrixAt(i, dummy.matrix);
    }
    unitMesh.instanceMatrix.needsUpdate = true;
    this.group.add(unitMesh);

    // --- Trees (own stream; render-only, never touches sim determinism) ---
    const treeRng = makeStream(cfg.seed, "trees");
    const tc = c3.trees;
    const spacing = cfg.network.spacingM;
    const foliage = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 7),
      new THREE.MeshLambertMaterial({ color: tc.foliage }),
      tc.count,
    );
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.3, 0.42, 1, 6),
      new THREE.MeshLambertMaterial({ color: tc.trunk }),
      tc.count,
    );
    for (let i = 0; i < tc.count; i++) {
      const node = net.nodes[Math.floor(treeRng() * net.nodes.length)];
      const ang = treeRng() * Math.PI * 2;
      const rad = uniform(treeRng, spacing * 0.22, spacing * 0.46);
      const tx = node.x + Math.cos(ang) * rad;
      const tz = node.y + Math.sin(ang) * rad;
      const fh = uniform(treeRng, 5, 10);
      const trunkH = fh * 0.4;
      const fr = uniform(treeRng, 2.2, 3.6);
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(tx, trunkH / 2, tz);
      dummy.scale.set(1, trunkH, 1);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      dummy.position.set(tx, trunkH + fh / 2, tz);
      dummy.scale.set(fr, fh, fr);
      dummy.updateMatrix();
      foliage.setMatrixAt(i, dummy.matrix);
    }
    foliage.instanceMatrix.needsUpdate = true;
    trunk.instanceMatrix.needsUpdate = true;
    this.group.add(trunk);
    this.group.add(foliage);

    // --- Streetlights at signalized junctions (lamps glow after dark) ---
    const poleMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.35, 0.45, 9, 6),
      new THREE.MeshLambertMaterial({ color: c3.streetlight.pole }),
      this.signalNodes.length,
    );
    this.streetLampMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.9, 8, 8),
      new THREE.MeshBasicMaterial(),
      this.signalNodes.length,
    );
    this.lampOn.set(c3.streetlight.lamp);
    for (let i = 0; i < this.signalNodes.length; i++) {
      const node = net.nodes[this.signalNodes[i]];
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.position.set(node.x + 6, 4.5, node.y + 6);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(node.x + 6, 9.2, node.y + 6);
      dummy.updateMatrix();
      this.streetLampMesh.setMatrixAt(i, dummy.matrix);
      this.streetLampMesh.setColorAt(i, this.lampOff);
    }
    poleMesh.instanceMatrix.needsUpdate = true;
    this.streetLampMesh.instanceMatrix.needsUpdate = true;
    this.group.add(poleMesh);
    this.group.add(this.streetLampMesh);

    // --- Closure barriers on the arterial bridge (hidden until the experiment) ---
    for (const e of net.edges) {
      if (!e.isBridge || !cfg.network.arterialCols.includes(e.bridgeCol) || e.id % 2 !== 0)
        continue;
      const a = net.nodes[e.from];
      const bN = net.nodes[e.to];
      for (const end of [0.12, 0.88]) {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(streetHalfWidth(e) * 2 + 2, 3.2, 1.6),
          new THREE.MeshLambertMaterial({ color: 0xd23b2f }),
        );
        bar.position.set(a.x + (bN.x - a.x) * end, 1.6, a.y + (bN.y - a.y) * end);
        this.closureGroup.add(bar);
      }
    }
    this.closureGroup.visible = false;
    this.group.add(this.closureGroup);
  }

  updateSignals(t: number): void {
    const green = this.colorScratch.set(0x46e09a);
    const red = new THREE.Color(0xff5648);
    for (let i = 0; i < this.signalNodes.length; i++) {
      const node = this.net.nodes[this.signalNodes[i]];
      const sig = node.signal;
      if (sig === null) continue;
      this.signalMesh.setColorAt(i * 2, isApproachGreen(sig, 0, t) ? green : red);
      this.signalMesh.setColorAt(i * 2 + 1, isApproachGreen(sig, 1, t) ? green : red);
    }
    if (this.signalMesh.instanceColor !== null) this.signalMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Building light pass. day01 = 1 full daylight, 0 deep night. Brightness
   * comes from who is PHYSICALLY inside (workersAt / residentsAt) — a shop
   * "opens" the moment its first worker survives the morning traffic.
   */
  updateBuildings(workersAt: Int32Array, residentsAt: Int32Array, day01: number): void {
    const c = this.colorScratch;
    const night = 1 - day01;
    const warm = new THREE.Color(0xffc97c);
    for (let i = 0; i < this.buildings.length; i++) {
      const info = this.buildings[i];
      const ambient = 0.32 + 0.68 * day01;
      c.copy(info.base).multiplyScalar(ambient);
      if (info.biz) {
        const workers = workersAt[info.nodeId];
        if (workers > 0) {
          const open = Math.min(1, workers / (8 + info.jobW));
          c.lerp(warm, (0.18 + 0.5 * open) * (0.45 + 0.55 * night));
        }
      } else {
        const home = residentsAt[info.nodeId];
        if (home > 0 && night > 0.05) {
          const lit = Math.min(1, home / 30) * night;
          // windowSeed varies which houses light up strongly.
          c.lerp(warm, lit * (0.25 + 0.5 * info.windowSeed));
        }
      }
      this.buildingMesh.setColorAt(i, c);
    }
    if (this.buildingMesh.instanceColor !== null)
      this.buildingMesh.instanceColor.needsUpdate = true;

    // Streetlights: warm pools of light that fade up after dusk.
    const lit = night < 0.06 ? 0 : Math.min(1, (night - 0.06) * 1.6);
    const lc = this.colorScratch.copy(this.lampOff).lerp(this.lampOn, lit);
    for (let i = 0; i < this.signalNodes.length; i++) this.streetLampMesh.setColorAt(i, lc);
    if (this.streetLampMesh.instanceColor !== null)
      this.streetLampMesh.instanceColor.needsUpdate = true;
  }

  updateClosure(closed: boolean): void {
    this.closureGroup.visible = closed;
  }

  dispose(): void {
    disposeGroup(this.group);
  }
}
