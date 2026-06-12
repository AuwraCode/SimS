import type { Network, SpawnRequest, TripArrival } from "./types";

interface ActiveWalk {
  agentId: number;
  kind: SpawnRequest["kind"];
  plannedS: number;
  freeFlowS: number;
  dest: number;
  route: Int32Array;
  /** Cumulative length at the END of each route edge (m). */
  cum: Float64Array;
  edgeIdx: number;
  distM: number;
  totalM: number;
  speed: number;
}

/**
 * Pedestrians. They use the same street network (sidewalks) but consume no
 * road capacity — walking has effectively infinite supply, which is exactly
 * why flattening car demand onto feet would kill congestion. They still obey
 * their owners' daily plans, so the sidewalks fill toward 08:00 too.
 */
export class WalkSystem {
  private active: ActiveWalk[] = [];
  /** Drained by the scheduler every step. */
  arrivals: TripArrival[] = [];

  constructor(private readonly net: Network) {}

  get count(): number {
    return this.active.length;
  }

  start(req: SpawnRequest, walkSpeed: number, t: number): void {
    const cum = new Float64Array(req.route.length);
    let acc = 0;
    for (let i = 0; i < req.route.length; i++) {
      acc += this.net.edges[req.route[i]].lengthM;
      cum[i] = acc;
    }
    this.active.push({
      agentId: req.agentId,
      kind: req.kind,
      plannedS: req.plannedS,
      freeFlowS: acc / walkSpeed,
      dest: req.to,
      route: req.route,
      cum,
      edgeIdx: 0,
      distM: 0,
      totalM: acc,
      speed: walkSpeed,
    });
    void t;
  }

  step(t: number, dt: number): void {
    let keep = 0;
    for (let i = 0; i < this.active.length; i++) {
      const w = this.active[i];
      w.distM += w.speed * dt;
      while (w.edgeIdx < w.route.length - 1 && w.distM >= w.cum[w.edgeIdx]) w.edgeIdx++;
      if (w.distM >= w.totalM) {
        this.arrivals.push({
          agentId: w.agentId,
          kind: w.kind,
          mode: "walk",
          plannedDepartS: w.plannedS,
          arriveS: t,
          freeFlowS: w.freeFlowS,
          dest: w.dest,
        });
      } else {
        this.active[keep++] = w; // preserve order — deterministic iteration
      }
    }
    this.active.length = keep;
  }

  /** Deterministic iteration for render & state hashing. */
  forEach(cb: (agentId: number, edgeId: number, posM: number, speed: number) => void): void {
    for (const w of this.active) {
      const before = w.edgeIdx > 0 ? w.cum[w.edgeIdx - 1] : 0;
      cb(w.agentId, w.route[w.edgeIdx], w.distM - before, w.speed);
    }
  }
}
