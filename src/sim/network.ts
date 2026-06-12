import type { SimsConfig } from "../config";
import { type Rng, uniform } from "./rng";
import type { NetEdge, NetNode, Network, RoadClass, Signal } from "./types";

/**
 * Procedural city generator.
 *
 * The map is a jittered grid split by a river: a small north bank carrying the
 * CBD (high job weight) and a large south bank that is mostly residential
 * (high home weight). Only the configured bridge columns get edges across the
 * river, and bridge spans are always 1 lane per direction.
 *
 * This spatial layout — not any clock-driven rule — is what gives commuting a
 * direction: in the morning thousands of independently planned trips all need
 * the same two bridges, demand exceeds their discharge rate, and queues grow.
 */
export function buildNetwork(cfg: SimsConfig, rng: Rng): Network {
  const n = cfg.network;
  const nodes: NetNode[] = [];
  const edges: NetEdge[] = [];

  const nodeId = (col: number, row: number): number => row * n.cols + col;
  const isBridgeCol = (col: number): boolean => n.bridgeCols.includes(col);
  const colClass = (col: number): RoadClass =>
    n.arterialCols.includes(col) ? "arterial" : "local";
  const rowClass = (row: number): RoadClass =>
    n.arterialRows.includes(row) ? "arterial" : "local";
  const inCbd = (col: number, row: number): boolean =>
    col >= n.cbd.col0 && col <= n.cbd.col1 && row >= n.cbd.row0 && row <= n.cbd.row1;

  // --- Nodes (row-major; rng draw order is part of the deterministic layout) ---
  for (let row = 0; row < n.rows; row++) {
    for (let col = 0; col < n.cols; col++) {
      const jx = uniform(rng, -n.jitterM, n.jitterM);
      const jy = uniform(rng, -n.jitterM, n.jitterM);
      const north = row <= n.riverNorthRow;
      const hub = n.hubs.find((h) => h.col === col && h.row === row);
      let homeW: number;
      let jobW: number;
      if (inCbd(col, row)) {
        homeW = n.weights.cbd.home;
        jobW = n.weights.cbd.job;
      } else if (north) {
        homeW = n.weights.north.home;
        jobW = hub ? hub.jobW : n.weights.north.job;
      } else {
        homeW = n.weights.south.home;
        jobW = hub ? hub.jobW : n.weights.south.job;
      }
      nodes.push({
        id: nodeId(col, row),
        col,
        row,
        x: col * n.spacingM + jx,
        y: row * n.spacingM + jy,
        north,
        homeW,
        jobW,
        signal: null,
        outEdges: [],
        inEdges: [],
      });
    }
  }

  // --- Edges (every street = two directed edges) ---
  const addPair = (a: number, b: number, klass: RoadClass, axis: 0 | 1, isBridge: boolean) => {
    const lanes = isBridge ? 1 : cfg.network.lanesPerClass[klass];
    const vmax = cfg.network.speeds[klass];
    const dx = nodes[b].x - nodes[a].x;
    const dy = nodes[b].y - nodes[a].y;
    const lengthM = Math.hypot(dx, dy);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const e: NetEdge = {
        id: edges.length,
        from,
        to,
        lengthM,
        lanes,
        vmax,
        klass,
        isBridge,
        axis,
        freeFlowS: lengthM / vmax,
      };
      edges.push(e);
      nodes[from].outEdges.push(e.id);
      nodes[to].inEdges.push(e.id);
    }
  };

  for (let row = 0; row < n.rows; row++) {
    for (let col = 0; col + 1 < n.cols; col++) {
      addPair(nodeId(col, row), nodeId(col + 1, row), rowClass(row), 1, false);
    }
  }
  for (let col = 0; col < n.cols; col++) {
    for (let row = 0; row + 1 < n.rows; row++) {
      const crossesRiver = row === n.riverNorthRow;
      if (crossesRiver && !isBridgeCol(col)) continue; // the river: no edge here
      addPair(nodeId(col, row), nodeId(col, row + 1), colClass(col), 0, crossesRiver);
    }
  }

  // --- Signals: arterial-involved junctions and bridgeheads; the rest run FCFS priority ---
  const greenS = cfg.signals.cycleS / 2 - cfg.signals.lostTimeS;
  for (const node of nodes) {
    const touchesArterial = n.arterialCols.includes(node.col) || n.arterialRows.includes(node.row);
    const bridgehead =
      isBridgeCol(node.col) && (node.row === n.riverNorthRow || node.row === n.riverSouthRow);
    // Signal offsets are sampled for EVERY node so the rng layout does not
    // depend on which junctions end up signalized.
    const offsetS = Math.floor(uniform(rng, 0, cfg.signals.cycleS) / cfg.sim.dt) * cfg.sim.dt;
    if (touchesArterial || bridgehead) {
      const signal: Signal = { cycleS: cfg.signals.cycleS, offsetS, greenS };
      node.signal = signal;
    }
  }

  const net: Network = { nodes, edges, cols: n.cols, rows: n.rows };
  assertStronglyConnected(net);
  return net;
}

/** Both banks plus bridges must form one strongly connected graph. */
function assertStronglyConnected(net: Network): void {
  const reach = (forward: boolean): number => {
    const seen = new Uint8Array(net.nodes.length);
    const stack = [0];
    seen[0] = 1;
    let count = 1;
    while (stack.length > 0) {
      const v = stack.pop() as number;
      const ids = forward ? net.nodes[v].outEdges : net.nodes[v].inEdges;
      for (const id of ids) {
        const e = net.edges[id];
        const next = forward ? e.to : e.from;
        if (seen[next] === 0) {
          seen[next] = 1;
          count++;
          stack.push(next);
        }
      }
    }
    return count;
  };
  if (reach(true) !== net.nodes.length || reach(false) !== net.nodes.length) {
    throw new Error("network generation bug: graph is not strongly connected");
  }
}

/** Screen-space band occupied by the river (between the two bank rows). */
export function riverBand(net: Network, cfgNet: SimsConfig["network"]): { y0: number; y1: number } {
  let y0 = Number.NEGATIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  for (const node of net.nodes) {
    if (node.row === cfgNet.riverNorthRow) y0 = Math.max(y0, node.y);
    if (node.row === cfgNet.riverSouthRow) y1 = Math.min(y1, node.y);
  }
  const margin = (y1 - y0) * 0.18;
  return { y0: y0 + margin, y1: y1 - margin };
}

export function networkBounds(net: Network): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const node of net.nodes) {
    x0 = Math.min(x0, node.x);
    y0 = Math.min(y0, node.y);
    x1 = Math.max(x1, node.x);
    y1 = Math.max(y1, node.y);
  }
  return { x0, y0, x1, y1 };
}
