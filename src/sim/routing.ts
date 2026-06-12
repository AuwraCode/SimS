import type { SimsConfig } from "../config";
import { hash2, normalClamped, type Rng } from "./rng";
import type { Agent, Network } from "./types";

/**
 * Route choice, Phase 1: shortest path on free-flow travel times.
 *
 * If every agent picked the literal cost-optimal path, the grid's many
 * exactly-equal "staircase" paths would collapse onto one street and produce
 * unrealistic herding. Two per-agent perturbations spread the flow instead —
 * both are *route-choice heterogeneity* (people weight roads differently),
 * never traffic control:
 *
 *  1. tie noise: a stateless ±tieNoise hash of (agent, edge) on every edge
 *     cost, which randomizes the choice among equal-cost paths;
 *  2. arterialAffinity ~ N(1, σ): a per-agent multiplier on arterial costs —
 *     some drivers love the big roads, some avoid them — peeling a share of
 *     traffic onto parallel locals.
 *
 * Congestion-aware re-routing arrives in Phase 2; Phase 1 routes are fixed
 * for the day, so jams punish everyone who planned through them (visibly).
 */
export function assignRoutes(cfg: SimsConfig, net: Network, agents: Agent[], rng: Rng): void {
  const p = cfg.population;
  const dijkstra = makeDijkstra(net);

  for (const agent of agents) {
    // Sample affinity for every agent (keeps the rng layout independent of mode).
    const affinity = normalClamped(
      rng,
      1,
      p.arterialAffinitySigma,
      p.arterialAffinityClamp[0],
      p.arterialAffinityClamp[1],
    );
    if (agent.mode !== "car") continue;

    const cost = (edgeId: number): number => {
      const e = net.edges[edgeId];
      const noise = 1 + p.tieNoise * (hash2(agent.id, edgeId) - 0.5) * 2;
      const aff = e.klass === "arterial" ? affinity : 1;
      return e.freeFlowS * noise * aff;
    };

    const route = dijkstra(agent.home, agent.work, cost);
    if (route === null) {
      // Unreachable should be impossible (graph is strongly connected).
      agent.mode = "offroad";
      continue;
    }
    agent.route = route;

    // Free-flow time uses UNPERTURBED costs: it is the honest physical
    // baseline used for departure planning and later for delay metrics.
    let freeFlow = 0;
    for (const id of route) freeFlow += net.edges[id].freeFlowS;
    agent.freeFlowS = freeFlow;

    // Agents target their arrival time: leave early enough at free-flow speed
    // plus a personal safety buffer. When congestion builds, "early enough"
    // stops being enough — lateness is an emergent outcome, not an input.
    agent.departS = Math.max(0, agent.workStartS - freeFlow - agent.bufferS);
  }
}

type CostFn = (edgeId: number) => number;

/** Dijkstra with a tiny binary heap, reusing scratch arrays across calls. */
function makeDijkstra(net: Network) {
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
        const next = net.edges[edgeId].to;
        if (settled[next] === 1) continue;
        const nd = d + cost(edgeId);
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
