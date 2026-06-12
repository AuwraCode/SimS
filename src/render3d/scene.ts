import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SimsConfig } from "../config";
import { networkBounds } from "../sim/network";
import type { Simulation } from "../sim/sim";
import { AgentsView } from "./agents3d";
import { SkyTraffic } from "./ambient";
import { CityMeshes } from "./city3d";
import { disposeGroup } from "./util";

/**
 * The sandbox view: WebGL city, day/night driven by the sim clock (the sun
 * is a function of time — that's astronomy, not traffic), instanced agents,
 * ambient planes, and a trace beacon. Owns one persistent WebGLRenderer;
 * restarting the simulation swaps the world groups without leaking contexts.
 */
export class Scene3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly skyDay = new THREE.Color();
  private readonly skyNight = new THREE.Color();
  private readonly skyScratch = new THREE.Color();

  private city: CityMeshes;
  private agentsView: AgentsView;
  private ambient: SkyTraffic;
  private traceLine: THREE.Line | null = null;
  private readonly traceBeacon: THREE.Mesh;
  private readonly v3 = new THREE.Vector3();
  private center = new THREE.Vector3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    sim: Simulation,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new THREE.PerspectiveCamera(45, 1, 5, 12000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    this.skyDay.set(sim.cfg.render.three.skyDay);
    this.skyNight.set(sim.cfg.render.three.skyNight);
    this.hemi = new THREE.HemisphereLight(0xbdd3ef, 0x2a2f28, 0.8);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.0);
    this.scene.add(this.hemi);
    this.scene.add(this.sun);
    this.scene.fog = new THREE.Fog(0x87b5e8, 2200, 7000);

    this.traceBeacon = new THREE.Mesh(
      new THREE.ConeGeometry(4.5, 11, 4),
      new THREE.MeshBasicMaterial({ color: 0x4fa3ff }),
    );
    this.traceBeacon.rotation.x = Math.PI;
    this.traceBeacon.visible = false;
    this.scene.add(this.traceBeacon);

    this.city = new CityMeshes(sim.net, sim.cfg);
    this.agentsView = new AgentsView(sim.net, sim.engine.cap, 4096);
    const b = networkBounds(sim.net);
    this.ambient = new SkyTraffic(
      b,
      sim.cfg.ambient.planes,
      sim.cfg.ambient.planeAltitudeM,
      sim.cfg.ambient.planeSpeedMs,
    );
    this.scene.add(this.city.group);
    this.scene.add(this.agentsView.group);
    this.scene.add(this.ambient.group);

    this.center.set((b.x0 + b.x1) / 2, 0, (b.y0 + b.y1) / 2);
    this.camera.position.set(this.center.x - 350, 1050, this.center.z + 1500);
    this.controls.target.copy(this.center);
    this.resize();
  }

  /** Swap in a fresh simulation world (UI restart) without recreating WebGL. */
  setSimulation(sim: Simulation): void {
    this.scene.remove(this.city.group);
    this.scene.remove(this.agentsView.group);
    this.city.dispose();
    disposeGroup(this.city.group);
    this.agentsView.dispose();
    this.city = new CityMeshes(sim.net, sim.cfg);
    this.agentsView = new AgentsView(sim.net, sim.engine.cap, 4096);
    this.scene.add(this.city.group);
    this.scene.add(this.agentsView.group);
    this.clearTrace();
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 0 = deep night, 1 = full day; smooth dawn/dusk ramps. */
  private day01(cfg: SimsConfig, t: number): number {
    const h = t / 3600;
    const { sunriseH, sunsetH } = cfg.render.three;
    const ramp = 0.8;
    const up = smooth01((h - (sunriseH - ramp)) / (2 * ramp));
    const down = smooth01((sunsetH + ramp - h) / (2 * ramp));
    return Math.min(up, down);
  }

  render(sim: Simulation, traceId: number | null, realDt: number): void {
    const t = sim.t;
    const day = this.day01(sim.cfg, t);

    // Sky, fog, lights.
    this.skyScratch.copy(this.skyNight).lerp(this.skyDay, day);
    this.scene.background = this.skyScratch;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.skyScratch);
    this.hemi.intensity = 0.22 + 0.66 * day;
    this.sun.intensity = 1.05 * day;
    const { sunriseH, sunsetH } = sim.cfg.render.three;
    const sunU = ((t / 3600 - sunriseH) / (sunsetH - sunriseH)) * Math.PI;
    this.sun.position.set(
      this.center.x + Math.cos(sunU) * 2200,
      Math.max(120, Math.sin(sunU) * 1800),
      this.center.z + 700,
    );

    this.city.updateSignals(t);
    this.city.updateBuildings(sim.scheduler.workersAt, sim.scheduler.residentsAt, day);
    this.city.updateClosure(sim.arterialBridgeClosed());
    this.agentsView.update(sim);
    this.ambient.update(t);
    this.updateTrace(sim, traceId, realDt);

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private traceBob = 0;

  private updateTrace(sim: Simulation, traceId: number | null, realDt: number): void {
    if (traceId === null) {
      this.clearTrace();
      return;
    }
    const agent = sim.agents[traceId];
    const live = sim.engine.liveRoute(traceId) ?? agent?.route ?? null;
    if (live !== null && (this.traceLine === null || this.traceLine.userData.route !== live)) {
      this.clearTraceLine();
      const pts: THREE.Vector3[] = [];
      const first = sim.net.edges[live[0]];
      const start = sim.net.nodes[first.from];
      pts.push(new THREE.Vector3(start.x, 3, start.y));
      for (const eid of live) {
        const node = sim.net.nodes[sim.net.edges[eid].to];
        pts.push(new THREE.Vector3(node.x, 3, node.y));
      }
      this.traceLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x4fa3ff }),
      );
      this.traceLine.userData.route = live;
      this.scene.add(this.traceLine);
    }
    this.traceBob += realDt * 3;
    if (this.agentsView.entityPosition(sim, traceId, this.v3)) {
      this.traceBeacon.visible = true;
      this.traceBeacon.position.set(
        this.v3.x,
        this.v3.y + 14 + Math.sin(this.traceBob) * 2,
        this.v3.z,
      );
    } else {
      this.traceBeacon.visible = false;
    }
  }

  private clearTraceLine(): void {
    if (this.traceLine !== null) {
      this.scene.remove(this.traceLine);
      this.traceLine.geometry.dispose();
      (this.traceLine.material as THREE.Material).dispose();
      this.traceLine = null;
    }
  }

  clearTrace(): void {
    this.clearTraceLine();
    this.traceBeacon.visible = false;
  }
}

function smooth01(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
}
