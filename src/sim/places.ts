import type { SimsConfig } from "../config";
import { normalClamped, type Rng, uniform } from "./rng";
import type { Agent, NetNode, Network, PoiKind } from "./types";

/**
 * Land use beyond homes & jobs.
 *
 * Points of interest (shops, malls, hospitals, gas stations, casinos, pools,
 * amusement parks, and the fire/police stations the emergency subsystem
 * dispatches from) are scattered across the grid at worldgen, deterministically
 * from a DEDICATED rng stream. Because they consume no draws from the commute
 * streams, every calibrated traffic number is preserved exactly; agents simply
 * gain new places to plan trips to. Nothing in here reads the clock.
 */

export interface Poi {
  id: number;
  kind: PoiKind;
  node: number;
  x: number;
  y: number;
  /** Visit cost range (currency units). */
  costMin: number;
  costMax: number;
  /** True for after-work leisure destinations. */
  leisure: boolean;
}

export interface Places {
  all: Poi[];
  byKind: Map<PoiKind, Poi[]>;
  /** Daytime errand destinations (shops, gas, malls). */
  errandTargets: Poi[];
  /** After-work outing destinations (malls, pools, parks, casinos). */
  leisure: Poi[];
  /** Nearest POI of a kind to a node (Euclidean), or null if none exist. */
  nearest(kind: PoiKind, fromNode: number): Poi | null;
}

const ERRAND_KINDS: PoiKind[] = ["shop", "gas", "mall"];

/** Zone predicate: which grid nodes are candidates for a given `zone` tag. */
function zoneFilter(cfg: SimsConfig, zone: string): (n: NetNode) => boolean {
  const net = cfg.network;
  const inCbd = (n: NetNode): boolean =>
    n.col >= net.cbd.col0 &&
    n.col <= net.cbd.col1 &&
    n.row >= net.cbd.row0 &&
    n.row <= net.cbd.row1;
  const onArterial = (n: NetNode): boolean =>
    net.arterialCols.includes(n.col) || net.arterialRows.includes(n.row);
  switch (zone) {
    case "south":
      return (n) => !n.north;
    case "north":
      return (n) => n.north;
    case "cbd":
      return inCbd;
    case "arterial":
      return onArterial;
    case "commercial":
      return (n) => inCbd(n) || n.jobW >= 10;
    default:
      return () => true;
  }
}

export function buildPlaces(cfg: SimsConfig, net: Network, rng: Rng): Places {
  const all: Poi[] = [];
  const byKind = new Map<PoiKind, Poi[]>();
  // Deterministic kind order (object key order is insertion order here).
  for (const kind of Object.keys(cfg.places.kinds) as PoiKind[]) {
    const spec = cfg.places.kinds[kind];
    const candidates = net.nodes.filter(zoneFilter(cfg, spec.zone));
    const used = new Set<number>();
    const list: Poi[] = [];
    const want = Math.min(spec.count, candidates.length);
    for (let k = 0; k < want; k++) {
      // Reject-sample a fresh node so two POIs of one kind never stack.
      let node = candidates[Math.floor(rng() * candidates.length)];
      for (let tries = 0; used.has(node.id) && tries < 24; tries++) {
        node = candidates[Math.floor(rng() * candidates.length)];
      }
      if (used.has(node.id)) continue;
      used.add(node.id);
      const poi: Poi = {
        id: all.length,
        kind,
        node: node.id,
        x: node.x,
        y: node.y,
        costMin: spec.cost[0],
        costMax: spec.cost[1],
        leisure: spec.leisure,
      };
      all.push(poi);
      list.push(poi);
    }
    byKind.set(kind, list);
  }

  const errandTargets = all.filter((p) => ERRAND_KINDS.includes(p.kind));
  const leisure = all.filter((p) => p.leisure);

  return {
    all,
    byKind,
    errandTargets,
    leisure,
    nearest(kind: PoiKind, fromNode: number): Poi | null {
      const list = byKind.get(kind);
      if (list === undefined || list.length === 0) return null;
      const from = net.nodes[fromNode];
      let best = list[0];
      let bestD = Number.POSITIVE_INFINITY;
      for (const p of list) {
        const d = (p.x - from.x) ** 2 + (p.y - from.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return best;
    },
  };
}

/**
 * Layer per-agent economy and POI visits onto an already-built population,
 * using a stream INDEPENDENT of the commute sampling. Each agent draws the
 * same fixed number of values regardless of which branch it takes, so config
 * tweaks here never shift the sequence — the same discipline rng.ts documents.
 */
export function assignEconomy(cfg: SimsConfig, agents: Agent[], places: Places, rng: Rng): void {
  const e = cfg.economy;
  const pickFrom = (pool: Poi[]): Poi | null =>
    pool.length === 0 ? null : pool[Math.floor(rng() * pool.length)];
  for (const a of agents) {
    a.money = uniform(rng, e.startBalance[0], e.startBalance[1]);
    a.wage = normalClamped(rng, e.wage.mu, e.wage.sigma, e.wage.min, e.wage.max);
    a.wfhPay = a.mode === "wfh" ? uniform(rng, e.wfhDailyPay[0], e.wfhDailyPay[1]) : 0;

    // Retarget the midday errand (its existence was decided by the commute
    // stream) onto a real POI; always draw so the stream stays aligned.
    const errandPoi = pickFrom(places.errandTargets);
    const errandCostU = rng();
    if (a.errand !== null && errandPoi !== null) {
      a.errand.node = errandPoi.node;
      a.errand.kind = errandPoi.kind;
      a.errand.cost = errandPoi.costMin + errandCostU * (errandPoi.costMax - errandPoi.costMin);
    }

    // After-work outing (drivers only, mirroring errands).
    const outingDraw = rng();
    const outingDwell = uniform(rng, cfg.places.outingDwellS[0], cfg.places.outingDwellS[1]);
    const outingPoi = pickFrom(places.leisure);
    const outingCostU = rng();
    if (
      a.mode === "car" &&
      outingDraw < cfg.places.outingShare &&
      outingPoi !== null &&
      outingPoi.node !== a.work
    ) {
      a.outing = {
        node: outingPoi.node,
        kind: outingPoi.kind,
        dwellS: outingDwell,
        cost: outingPoi.costMin + outingCostU * (outingPoi.costMax - outingPoi.costMin),
      };
    }
  }
}
