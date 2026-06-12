import type { SimsConfig } from "../config";
import type { Network, SpawnRequest, TripArrival } from "./types";

/**
 * Public transit: one tram line on its own right-of-way (it never consumes
 * road capacity — that is precisely its appeal once the bridges jam).
 *
 * The timetable is CLOSED-FORM: tram positions and stop departure times are
 * pure periodic functions of absolute time, exactly like signal cycles — an
 * infrastructure fixture that encodes nothing about demand. Riders are a
 * deterministic state machine: walk to the stop, wait for the next scheduled
 * departure, ride, walk to the destination.
 *
 * What is NOT fixed is who rides: agents choose tram vs car from their own
 * learned expectations (see learning.ts), so the tram's mode share is an
 * emergent response to congestion — the morning collapse pushes commuters
 * onto rails day by day, which in turn relieves the bridges.
 */

export interface TransitLine {
  /** Node ids along the track, terminus → terminus. */
  pathNodes: number[];
  /** Indices into pathNodes that are stops. */
  stopPathIdx: number[];
  stopNodes: number[];
  /** Cumulative track distance at each path node (m). */
  cumDistM: number[];
  /** Direction A (path order): arrival / departure offsets per path node (s from run start). */
  arrA: number[];
  depA: number[];
  /** Direction B (reverse path), same convention over reversed indices. */
  arrB: number[];
  depB: number[];
  headwayS: number;
  totalS: number;
}

export function buildLine(cfg: SimsConfig, net: Network): TransitLine {
  const tcfg = cfg.transit;
  const nodeId = (c: { col: number; row: number }): number => c.row * cfg.network.cols + c.col;
  const pathNodes = tcfg.path.map(nodeId);
  const stopNodes = tcfg.stops.map(nodeId);
  const stopPathIdx = stopNodes.map((n) => pathNodes.indexOf(n));
  if (stopPathIdx.includes(-1)) throw new Error("transit stop not on path");

  const cumDistM: number[] = [0];
  for (let i = 1; i < pathNodes.length; i++) {
    const a = net.nodes[pathNodes[i - 1]];
    const b = net.nodes[pathNodes[i]];
    cumDistM.push(cumDistM[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }

  const profile = (order: number[]): { arr: number[]; dep: number[] } => {
    const arr: number[] = new Array(pathNodes.length).fill(0);
    const dep: number[] = new Array(pathNodes.length).fill(0);
    let t = 0;
    for (let k = 0; k < order.length; k++) {
      const j = order[k];
      if (k === 0) {
        arr[j] = 0;
        dep[j] = 0; // runs are timed from terminus departure
        continue;
      }
      const prev = order[k - 1];
      t += Math.abs(cumDistM[j] - cumDistM[prev]) / tcfg.speed;
      arr[j] = t;
      if (stopPathIdx.includes(j)) t += tcfg.dwellS;
      dep[j] = t;
    }
    return { arr, dep };
  };
  const fwd = [...pathNodes.keys()];
  const a = profile(fwd);
  const b = profile([...fwd].reverse());

  return {
    pathNodes,
    stopPathIdx,
    stopNodes,
    cumDistM,
    arrA: a.arr,
    depA: a.dep,
    arrB: b.arr,
    depB: b.dep,
    headwayS: tcfg.headwayS,
    totalS: Math.max(a.dep[pathNodes.length - 1], b.dep[0]),
  };
}

/** Nearest stop to a node by manhattan grid distance; returns [stopIdx, distM]. */
export function nearestStop(
  line: TransitLine,
  net: Network,
  nodeId: number,
  spacingM: number,
): [number, number] {
  const node = net.nodes[nodeId];
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let s = 0; s < line.stopNodes.length; s++) {
    const sn = net.nodes[line.stopNodes[s]];
    const d = (Math.abs(sn.col - node.col) + Math.abs(sn.row - node.row)) * spacingM;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return [best, bestD];
}

/** Next scheduled departure from stop s toward stop sTo, at or after time t. */
export function nextDeparture(line: TransitLine, sFrom: number, sTo: number, t: number): number {
  const jFrom = line.stopPathIdx[sFrom];
  const dir = line.stopPathIdx[sTo] > jFrom ? "A" : "B";
  const dep = dir === "A" ? line.depA[jFrom] : line.depB[jFrom];
  const k = Math.max(0, Math.ceil((t - dep) / line.headwayS));
  return k * line.headwayS + dep;
}

/** Ride duration from boarding departure at sFrom to arrival at sTo. */
export function rideTime(line: TransitLine, sFrom: number, sTo: number): number {
  const jF = line.stopPathIdx[sFrom];
  const jT = line.stopPathIdx[sTo];
  return jT > jF ? line.arrA[jT] - line.depA[jF] : line.arrB[jT] - line.depB[jF];
}

/** Door-to-door transit estimate used for planning (walk + ½ headway + ride + walk). */
export function transitEstimateS(
  line: TransitLine,
  net: Network,
  spacingM: number,
  home: number,
  work: number,
  walkSpeed: number,
): { totalS: number; access: number; egress: number } | null {
  const [sH, dH] = nearestStop(line, net, home, spacingM);
  const [sW, dW] = nearestStop(line, net, work, spacingM);
  if (sH === sW) return null; // not a meaningful ride
  return {
    totalS: dH / walkSpeed + line.headwayS / 2 + rideTime(line, sH, sW) + dW / walkSpeed,
    access: dH,
    egress: dW,
  };
}

/** Live tram poses for rendering: position along the track + heading sign. */
export function tramPositions(line: TransitLine, t: number): { posM: number; dir: 1 | -1 }[] {
  const out: { posM: number; dir: 1 | -1 }[] = [];
  const last = line.pathNodes.length - 1;
  for (const dir of [1, -1] as const) {
    const dep = dir === 1 ? line.depA : line.depB;
    const arr = dir === 1 ? line.arrA : line.arrB;
    const endS = dir === 1 ? dep[last] : dep[0];
    const kMax = Math.floor(t / line.headwayS);
    const kMin = Math.ceil((t - endS) / line.headwayS);
    for (let k = kMin; k <= kMax; k++) {
      const u = t - k * line.headwayS;
      if (u < 0 || u > endS) continue;
      // Walk the profile to find the current segment / dwell.
      const order = dir === 1 ? [...line.pathNodes.keys()] : [...line.pathNodes.keys()].reverse();
      let posM = line.cumDistM[order[0]];
      for (let q = 0; q < order.length; q++) {
        const j = order[q];
        if (u <= arr[j]) {
          const prev = order[q - 1];
          const span = arr[j] - dep[prev];
          const frac = span > 0 ? (u - dep[prev]) / span : 1;
          posM = line.cumDistM[prev] + (line.cumDistM[j] - line.cumDistM[prev]) * Math.min(1, frac);
          break;
        }
        posM = line.cumDistM[j];
        if (u <= dep[j]) break;
      }
      out.push({ posM, dir });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

type Phase = 0 | 1 | 2 | 3; // walkTo, wait, ride, walkFrom

interface WalkLeg {
  route: Int32Array;
  cum: Float64Array;
  idx: number;
  distM: number;
  totalM: number;
}

interface Rider {
  agentId: number;
  kind: SpawnRequest["kind"];
  plannedS: number;
  estimateS: number;
  dest: number;
  phase: Phase;
  leg1: WalkLeg | null;
  leg2: WalkLeg | null;
  boardStop: number;
  alightStop: number;
  boardDepS: number;
  alightS: number;
  speed: number;
  /** Node the rider is currently waiting at (render). */
  waitNode: number;
}

export class TransitSystem {
  private riders: Rider[] = [];
  arrivals: TripArrival[] = [];

  constructor(
    private readonly net: Network,
    private readonly line: TransitLine,
    private readonly spacingM: number,
  ) {}

  get count(): number {
    return this.riders.length;
  }

  /** walkRoute: caller-supplied pedestrian path finder (the Router's). */
  start(
    req: SpawnRequest,
    walkSpeed: number,
    t: number,
    walkRoute: (from: number, to: number) => Int32Array | null,
  ): void {
    const [sFrom] = nearestStop(this.line, this.net, req.from, this.spacingM);
    const [sTo] = nearestStop(this.line, this.net, req.to, this.spacingM);
    const boardNode = this.line.stopNodes[sFrom];
    const alightNode = this.line.stopNodes[sTo];
    const makeLeg = (a: number, b: number): WalkLeg | null => {
      if (a === b) return null;
      const route = walkRoute(a, b);
      if (route === null) return null;
      const cum = new Float64Array(route.length);
      let acc = 0;
      for (let i = 0; i < route.length; i++) {
        acc += this.net.edges[route[i]].lengthM;
        cum[i] = acc;
      }
      return { route, cum, idx: 0, distM: 0, totalM: acc };
    };
    this.riders.push({
      agentId: req.agentId,
      kind: req.kind,
      plannedS: req.plannedS,
      estimateS: req.freeFlowS,
      dest: req.to,
      phase: 0,
      leg1: makeLeg(req.from, boardNode),
      leg2: makeLeg(alightNode, req.to),
      boardStop: sFrom,
      alightStop: sTo,
      boardDepS: 0,
      alightS: 0,
      speed: walkSpeed,
      waitNode: boardNode,
    });
    void t;
  }

  step(t: number, dt: number): void {
    let keep = 0;
    for (let i = 0; i < this.riders.length; i++) {
      const r = this.riders[i];
      let done = false;
      switch (r.phase) {
        case 0: {
          if (r.leg1 === null || advance(r.leg1, r.speed * dt)) {
            r.phase = 1;
            r.boardDepS = nextDeparture(this.line, r.boardStop, r.alightStop, t);
            r.alightS = r.boardDepS + rideTime(this.line, r.boardStop, r.alightStop);
          }
          break;
        }
        case 1: {
          if (t >= r.boardDepS) r.phase = 2;
          break;
        }
        case 2: {
          if (t >= r.alightS) {
            r.phase = 3;
            if (r.leg2 === null) done = true;
          }
          break;
        }
        case 3: {
          if (r.leg2 === null || advance(r.leg2, r.speed * dt)) done = true;
          break;
        }
      }
      if (done) {
        this.arrivals.push({
          agentId: r.agentId,
          kind: r.kind,
          mode: "transit",
          plannedDepartS: r.plannedS,
          arriveS: t,
          freeFlowS: r.estimateS,
          dest: r.dest,
        });
      } else {
        this.riders[keep++] = r; // order preserved — deterministic
      }
    }
    this.riders.length = keep;
  }

  /** Walking riders for render (same shape as WalkSystem.forEach). */
  forEachWalking(cb: (agentId: number, edgeId: number, posM: number) => void): void {
    for (const r of this.riders) {
      const leg = r.phase === 0 ? r.leg1 : r.phase === 3 ? r.leg2 : null;
      if (leg === null) continue;
      const before = leg.idx > 0 ? leg.cum[leg.idx - 1] : 0;
      cb(r.agentId, leg.route[leg.idx], leg.distM - before);
    }
  }

  /** Riders standing on platforms, grouped per stop node (render + hash). */
  waitingAt(): Map<number, number> {
    const m = new Map<number, number>();
    for (const r of this.riders) {
      if (r.phase !== 1) continue;
      m.set(r.waitNode, (m.get(r.waitNode) ?? 0) + 1);
    }
    return m;
  }

  /** Deterministic state walk for the hash. */
  forEachState(cb: (agentId: number, phase: number, distM: number) => void): void {
    for (const r of this.riders) {
      const leg = r.phase === 0 ? r.leg1 : r.phase === 3 ? r.leg2 : null;
      cb(r.agentId, r.phase, leg !== null ? leg.distM : 0);
    }
  }
}

/** Move a walk leg forward; true when finished. */
function advance(leg: WalkLeg, dM: number): boolean {
  leg.distM += dM;
  while (leg.idx < leg.route.length - 1 && leg.distM >= leg.cum[leg.idx]) leg.idx++;
  return leg.distM >= leg.totalM;
}
