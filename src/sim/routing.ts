import type { SimsConfig } from "../config";
import { hash2 } from "./rng";
import type { Agent, Network } from "./types";

/**
 * Route choice, Phase 2: congestion-aware shortest paths.
 *
 * Every edge keeps an exponential moving average of the travel times REAL
 * vehicles just experienced on it (the engine reports each traversal). A
 * driver departing now routes on those observed costs, decayed toward free
 * flow as observations go stale — so jams repel newcomers onto parallel
 * streets, which is exactly how route choice behaves in a real city, and a
 * negative feedback loop that spreads congestion across alternatives.
 *
 * Anti-herding heterogeneity (so equal drivers don't all flip to the same
 * "best" alternative simultaneously):
 *   1. tie noise: a stateless ±tieNoise hash of (agent, edge) on every cost;
 *   2. per-agent arterialAffinity ~ N(1, σ): some drivers love big roads,
 *      some avoid them.
 *
 * None of this reads the clock: costs come from what vehicles measured,
 * perturbations from per-agent taste. Walkers route by plain distance and
 * ignore closures (sidewalks stay open).
 */
export class Router {
  private readonly emaS: Float64Array;
  private readonly lastObsT: Float64Array;
  readonly ffS: Float64Array;
  private readonly dijkstra: Dijkstra;
  private readonly tieNoise: number;
  private readonly alpha: number;
  private readonly tau: number;

  constructor(
    cfg: SimsConfig,
    private readonly net: Network,
  ) {
    const m = net.edges.length;
    this.ffS = new Float64Array(m);
    for (let e = 0; e < m; e++) this.ffS[e] = net.edges[e].freeFlowS;
    this.emaS = Float64Array.from(this.ffS);
    this.lastObsT = new Float64Array(m).fill(-1e12);
    this.dijkstra = makeDijkstra(net);
    this.tieNoise = cfg.population.tieNoise;
    this.alpha = cfg.routing.emaAlpha;
    this.tau = cfg.routing.decayTauS;
  }

  /** Engine reports every completed edge traversal here. */
  observe(edgeId: number, travelS: number, t: number): void {
    const cur = this.expected(edgeId, t);
    this.emaS[edgeId] = cur + this.alpha * (travelS - cur);
    this.lastObsT[edgeId] = t;
  }

  /** Expected travel time now: observation EMA decayed toward free flow. */
  expected(edgeId: number, t: number): number {
    const ff = this.ffS[edgeId];
    const age = t - this.lastObsT[edgeId];
    if (age > 6 * this.tau) return ff;
    return ff + (this.emaS[edgeId] - ff) * Math.exp(-age / this.tau);
  }

  /** Congestion-aware car route; returns null only if dest is unreachable (all paths closed). */
  route(from: number, to: number, agent: Agent, t: number): Int32Array | null {
    return this.dijkstra(from, to, (edgeId) => {
      const e = this.net.edges[edgeId];
      if (e.closed) return Number.POSITIVE_INFINITY;
      const noise = 1 + this.tieNoise * (hash2(agent.id, edgeId) - 0.5) * 2;
      const aff = e.klass === "arterial" ? agent.affinity : 1;
      return this.expected(edgeId, t) * noise * aff;
    });
  }

  /** Plan-time route on free-flow costs (what an agent EXPECTS when scheduling the day). */
  routeFreeFlow(from: number, to: number, agent: Agent): Int32Array | null {
    return this.dijkstra(from, to, (edgeId) => {
      const e = this.net.edges[edgeId];
      const noise = 1 + this.tieNoise * (hash2(agent.id, edgeId) - 0.5) * 2;
      const aff = e.klass === "arterial" ? agent.affinity : 1;
      return this.ffS[edgeId] * noise * aff;
    });
  }

  /** Pedestrian route: plain shortest distance; closures don't apply to sidewalks. */
  walkRoute(from: number, to: number): Int32Array | null {
    return this.dijkstra(from, to, (edgeId) => this.net.edges[edgeId].lengthM);
  }

  /** Unperturbed free-flow seconds along a route — the honest delay baseline. */
  routeFreeFlowS(route: Int32Array): number {
    let s = 0;
    for (const id of route) s += this.ffS[id];
    return s;
  }

  routeLengthM(route: Int32Array): number {
    let s = 0;
    for (const id of route) s += this.net.edges[id].lengthM;
    return s;
  }
}

type CostFn = (edgeId: number) => number;
type Dijkstra = (from: number, to: number, cost: CostFn) => Int32Array | null;

/** Dijkstra with a tiny binary heap, reusing scratch arrays across calls. */
function makeDijkstra(net: Network): Dijkstra {
  const n = net.nodes.length;
  const dist = new Float64Array(n);
  const prevEdge = new Int32Array(n);
  const settled = new Uint8Array(n);
  // Binary heap as parallel arrays.
  const heapCost = new Float64Array(n * 8);
  const heapNode = new Int32Array(n * 8);

  return (from: number, to: number, cost: CostFn): Int32Array | null => {
    dist.fill(Number.POSITIVE_INFINITY);
    prevEdge.fill(-1);
    settled.fill(0);
    let heapSize = 0;

    const push = (c: number, v: number): void => {
      let i = heapSize++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heapCost[parent] <= c) break;
        heapCost[i] = heapCost[parent];
        heapNode[i] = heapNode[parent];
        i = parent;
      }
      heapCost[i] = c;
      heapNode[i] = v;
    };
    const pop = (): number => {
      const top = heapNode[0];
      const lastC = heapCost[--heapSize];
      const lastN = heapNode[heapSize];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= heapSize) break;
        const r = l + 1;
        const child = r < heapSize && heapCost[r] < heapCost[l] ? r : l;
        if (heapCost[child] >= lastC) break;
        heapCost[i] = heapCost[child];
        heapNode[i] = heapNode[child];
        i = child;
      }
      heapCost[i] = lastC;
      heapNode[i] = lastN;
      return top;
    };

    dist[from] = 0;
    push(0, from);
    while (heapSize > 0) {
      const v = pop();
      if (settled[v] === 1) continue;
      settled[v] = 1;
      if (v === to) break;
      const d = dist[v];
      for (const edgeId of net.nodes[v].outEdges) {
        const c = cost(edgeId);
        if (c === Number.POSITIVE_INFINITY) continue;
        const next = net.edges[edgeId].to;
        if (settled[next] === 1) continue;
        const nd = d + c;
        if (nd < dist[next]) {
          dist[next] = nd;
          prevEdge[next] = edgeId;
          push(nd, next);
        }
      }
    }

    if (prevEdge[to] === -1) return null;
    const reversed: number[] = [];
    let v = to;
    while (v !== from) {
      const e = prevEdge[v];
      reversed.push(e);
      v = net.edges[e].from;
    }
    return Int32Array.from(reversed.reverse());
  };
}
