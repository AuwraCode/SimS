import type { SimsConfig } from "../config";
import type { Places } from "./places";
import { makeStream, pickCumulative, type Rng } from "./rng";
import type { Router } from "./routing";
import type { Network } from "./types";

/**
 * Emergencies: fires, and the fire/police response to them.
 *
 * Fires ignite as a memoryless Poisson hazard — a constant per-second rate
 * drawn from a DEDICATED stream. That rate is independent of the time of day,
 * so this obeys The One Rule exactly as the planes and tram timetable do: it
 * reads the clock for nothing. (A real city's fire risk is roughly flat across
 * the day; we model it that way on purpose.)
 *
 * Response vehicles are dispatched from the nearest station and glide along a
 * routed path at a hot cruising speed. They deliberately do NOT enter the
 * microscopic traffic engine: keeping them out preserves the calibrated car
 * dynamics and the acceptance experiments bit-for-bit, at the cost of not
 * modelling sirens parting traffic (a noted simplification). Everything here
 * is fully deterministic and folded into the state fingerprint.
 */

export type EVehicleKind = "fire" | "police";
export type FireState = "burning" | "out";

export interface Fire {
  id: number;
  node: number;
  x: number;
  y: number;
  state: FireState;
  igniteT: number;
  /** When an engine is on scene, the time the fire will be extinguished. */
  suppressEndT: number;
  engineOnScene: boolean;
}

export interface EVehicle {
  id: number;
  kind: EVehicleKind;
  fireId: number;
  baseNode: number;
  route: Int32Array;
  edgeIdx: number;
  posM: number;
  phase: "toScene" | "onScene" | "returning" | "done";
  /** Cached world pose for the renderer. */
  x: number;
  y: number;
  angle: number;
}

export class EmergencySystem {
  readonly fires: Fire[] = [];
  readonly vehicles: EVehicle[] = [];
  /** Lifetime count of fires that have broken out — telemetry + fingerprint. */
  ignitedCount = 0;

  private readonly rng: Rng;
  private readonly igniteCum: Float64Array;
  private readonly enabled: boolean;
  private readonly lambdaPerS: number;
  private readonly maxActive: number;
  private readonly suppressS: number;
  private readonly speedMs: number;
  private nextFireId = 0;
  private nextVehId = 0;

  constructor(
    cfg: SimsConfig,
    private readonly net: Network,
    private readonly router: Router,
    private readonly places: Places,
  ) {
    this.rng = makeStream(cfg.seed, "emergency");
    this.enabled = cfg.emergency.enabled;
    this.lambdaPerS = cfg.emergency.firesPerHour / 3600;
    this.maxActive = cfg.emergency.maxActive;
    this.suppressS = cfg.emergency.suppressS;
    this.speedMs = cfg.emergency.vehicleSpeedMs;
    // Ignition is biased toward populated nodes (more to burn).
    this.igniteCum = new Float64Array(net.nodes.length);
    let acc = 0;
    for (let i = 0; i < net.nodes.length; i++) {
      acc += net.nodes[i].homeW + net.nodes[i].jobW + 1;
      this.igniteCum[i] = acc;
    }
  }

  /** Active (still-burning) fire count. */
  get activeCount(): number {
    let n = 0;
    for (const f of this.fires) if (f.state === "burning") n++;
    return n;
  }

  step(t: number, dt: number): void {
    // 1. Stochastic ignition (clock-independent hazard).
    if (this.enabled && this.activeCount < this.maxActive && this.rng() < this.lambdaPerS * dt) {
      this.igniteAt(pickCumulative(this.rng, this.igniteCum), t);
    }

    // 2. Move vehicles and handle their arrivals.
    for (const v of this.vehicles) {
      if (v.phase === "done" || v.phase === "onScene") continue;
      const finished = this.advance(v, dt);
      this.place(v);
      if (finished) {
        if (v.phase === "toScene") {
          v.phase = "onScene";
          const fire = this.fireById(v.fireId);
          if (fire !== null && v.kind === "fire" && !fire.engineOnScene) {
            fire.engineOnScene = true;
            fire.suppressEndT = t + this.suppressS;
          }
        } else if (v.phase === "returning") {
          v.phase = "done";
        }
      }
    }

    // 3. Extinguish fires whose suppression time has elapsed; send crews home.
    for (const fire of this.fires) {
      if (fire.state === "burning" && fire.engineOnScene && t >= fire.suppressEndT) {
        fire.state = "out";
        for (const v of this.vehicles) {
          if (v.fireId === fire.id && v.phase === "onScene") this.sendHome(v);
        }
      }
    }

    // 4. Reap finished vehicles and extinguished fires (once their crews left).
    this.reap();
  }

  /** Inject a fire at a node directly (UI "trigger fire" — bypasses the hazard). */
  igniteAt(node: number, t: number): Fire {
    const n = this.net.nodes[node];
    const fire: Fire = {
      id: this.nextFireId++,
      node,
      x: n.x,
      y: n.y,
      state: "burning",
      igniteT: t,
      suppressEndT: t + this.suppressS * 3, // self-resolves if no engine can reach it
      engineOnScene: false,
    };
    this.fires.push(fire);
    this.ignitedCount++;
    const dispatched = this.dispatch(fire, "fire");
    this.dispatch(fire, "police");
    if (!dispatched) fire.engineOnScene = true; // no reachable station: let it burn out
    return fire;
  }

  /** Spawn one responder of `kind` from its nearest station toward the fire. */
  private dispatch(fire: Fire, kind: EVehicleKind): boolean {
    const base = this.places.nearest(kind === "fire" ? "fireStation" : "police", fire.node);
    if (base === null || base.node === fire.node) return false;
    const route = this.router.walkRoute(base.node, fire.node);
    if (route === null || route.length === 0) return false;
    const v: EVehicle = {
      id: this.nextVehId++,
      kind,
      fireId: fire.id,
      baseNode: base.node,
      route,
      edgeIdx: 0,
      posM: 0,
      phase: "toScene",
      x: base.x,
      y: base.y,
      angle: 0,
    };
    this.place(v);
    this.vehicles.push(v);
    return true;
  }

  private sendHome(v: EVehicle): void {
    const fire = this.fireById(v.fireId);
    const from = fire !== null ? fire.node : v.baseNode;
    const route = this.router.walkRoute(from, v.baseNode);
    if (route === null || route.length === 0) {
      v.phase = "done";
      return;
    }
    v.route = route;
    v.edgeIdx = 0;
    v.posM = 0;
    v.phase = "returning";
  }

  /** Advance along the route; returns true when the route is exhausted. */
  private advance(v: EVehicle, dt: number): boolean {
    let remaining = this.speedMs * dt;
    while (remaining > 0 && v.edgeIdx < v.route.length) {
      const e = this.net.edges[v.route[v.edgeIdx]];
      const left = e.lengthM - v.posM;
      if (remaining < left) {
        v.posM += remaining;
        remaining = 0;
      } else {
        remaining -= left;
        v.edgeIdx++;
        v.posM = 0;
      }
    }
    return v.edgeIdx >= v.route.length;
  }

  private place(v: EVehicle): void {
    if (v.edgeIdx >= v.route.length) {
      const lastE = this.net.edges[v.route[v.route.length - 1]];
      const n = this.net.nodes[lastE.to];
      v.x = n.x;
      v.y = n.y;
      return;
    }
    const e = this.net.edges[v.route[v.edgeIdx]];
    const a = this.net.nodes[e.from];
    const b = this.net.nodes[e.to];
    const f = e.lengthM > 0 ? v.posM / e.lengthM : 0;
    v.x = a.x + (b.x - a.x) * f;
    v.y = a.y + (b.y - a.y) * f;
    v.angle = Math.atan2(b.y - a.y, b.x - a.x);
  }

  private fireById(id: number): Fire | null {
    for (const f of this.fires) if (f.id === id) return f;
    return null;
  }

  private reap(): void {
    if (this.vehicles.some((v) => v.phase === "done")) {
      for (let i = this.vehicles.length - 1; i >= 0; i--) {
        if (this.vehicles[i].phase === "done") this.vehicles.splice(i, 1);
      }
    }
    // An extinguished fire is removed once no vehicle is still tied to it.
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const fire = this.fires[i];
      if (fire.state === "out" && !this.vehicles.some((v) => v.fireId === fire.id)) {
        this.fires.splice(i, 1);
      }
    }
  }
}
