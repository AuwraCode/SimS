import type { SimsConfig } from "../../config";
import type { Router } from "../routing";
import type { Agent, NetEdge, Network, SpawnRequest, TripArrival, TripKind } from "../types";
import { ballistic, ballisticOut, type Idm, idmAccel, makeIdm } from "./idm";
import { isApproachGreen } from "./junction";

const KINDS: TripKind[] = ["toWork", "toErrand", "errandReturn", "toHome"];
const KIND_IDX: Record<TripKind, number> = { toWork: 0, toErrand: 1, errandReturn: 2, toHome: 3 };

/**
 * Microscopic traffic engine: a pool of vehicles in structure-of-arrays typed
 * arrays, organized into per-lane FIFO queues (no overtaking within a lane,
 * so ordering is invariant and every vehicle's leader is just its FIFO
 * predecessor — an O(V) step with no sorting and no neighbor search).
 *
 * Spillback — the mechanism that turns local saturation into area gridlock —
 * is implemented as *leader selection* at edge heads: a vehicle at the end of
 * an edge either follows the last vehicle of its next edge (gap reaches
 * across the junction) or, when the light is red / priority is against it,
 * follows a virtual standing wall at the stop line. When a downstream edge
 * fills to jam density its tail sits at the edge entrance, the upstream
 * head's gap collapses, and the queue grows backwards — no rule anywhere says
 * "be congested"; full roads simply refuse to accept more metal.
 *
 * Phase 2 additions: every edge traversal is reported to the Router (the
 * observed-cost feedback loop), vehicles stuck long enough re-plan their
 * remaining route, and edges can close mid-run (acceptance experiment #2) —
 * everyone routed through a closure re-plans at their next junction.
 */
export class TrafficEngine {
  readonly cap: number;
  // --- vehicle pool (SoA) ---
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly acc: Float32Array;
  readonly edgeOf: Int32Array;
  readonly laneOf: Uint8Array;
  readonly routePtr: Int32Array;
  readonly agentOf: Int32Array;
  readonly v0mul: Float32Array;
  readonly Thw: Float32Array;
  readonly spawnT: Float64Array;
  readonly stoppedS: Float32Array;
  private readonly enterT: Float64Array;
  private readonly kindOf: Uint8Array;
  private readonly planS: Float64Array;
  private readonly ffS: Float32Array;
  private readonly destOf: Int32Array;
  private readonly rerouted: Uint8Array;
  private readonly needsReroute: Uint8Array;
  private readonly fcfsTick: Int32Array;
  private readonly committed: Uint8Array;
  private readonly canCross: Uint8Array;
  private readonly targetLane: Uint8Array;
  private readonly routeOf: (Int32Array | null)[];

  /** lanes[edgeId][lane] = vehicle slots, index 0 = head (closest to edge end). */
  readonly lanes: number[][][];
  private freeStack: number[] = [];
  /** agentId → pool slot (−1 when not on the road). */
  readonly slotOfAgent: number[] = [];
  activeCount = 0;
  arrivedCount = 0;
  /** Routed legs waiting in driveways for room on their first street. */
  private waiting: SpawnRequest[] = [];
  /** Drained by the scheduler after every step. */
  tripArrivals: TripArrival[] = [];
  /** Cumulative transfers onto each edge (bridge telemetry reads the bridge rows). */
  readonly edgeEntries: Int32Array;

  // FCFS winner cache, tagged by tick.
  private readonly fcfsWinTick: Int32Array;
  private readonly fcfsWinSlot: Int32Array;

  readonly idm: Idm;
  private readonly dt: number;
  private readonly stoppedSpeed: number;
  private readonly stopZoneM: number;
  private readonly stuckRerouteS: number;
  private readonly maxReroutes: number;

  constructor(
    cfg: SimsConfig,
    private readonly net: Network,
    private readonly agents: Agent[],
    private readonly router: Router,
  ) {
    const drivers = agents.reduce((n, a) => n + (a.mode === "car" ? 1 : 0), 0);
    this.cap = drivers + 32; // each agent runs at most one concurrent trip (+probe headroom)
    this.pos = new Float32Array(this.cap);
    this.vel = new Float32Array(this.cap);
    this.acc = new Float32Array(this.cap);
    this.edgeOf = new Int32Array(this.cap);
    this.laneOf = new Uint8Array(this.cap);
    this.routePtr = new Int32Array(this.cap);
    this.agentOf = new Int32Array(this.cap);
    this.v0mul = new Float32Array(this.cap);
    this.Thw = new Float32Array(this.cap);
    this.spawnT = new Float64Array(this.cap);
    this.stoppedS = new Float32Array(this.cap);
    this.enterT = new Float64Array(this.cap);
    this.kindOf = new Uint8Array(this.cap);
    this.planS = new Float64Array(this.cap);
    this.ffS = new Float32Array(this.cap);
    this.destOf = new Int32Array(this.cap);
    this.rerouted = new Uint8Array(this.cap);
    this.needsReroute = new Uint8Array(this.cap);
    this.fcfsTick = new Int32Array(this.cap).fill(-1);
    this.committed = new Uint8Array(this.cap);
    this.canCross = new Uint8Array(this.cap);
    this.targetLane = new Uint8Array(this.cap);
    this.routeOf = new Array(this.cap).fill(null);
    for (let i = this.cap - 1; i >= 0; i--) this.freeStack.push(i); // LIFO, deterministic
    for (let i = 0; i < agents.length; i++) this.slotOfAgent.push(-1);
    this.lanes = net.edges.map((e) => Array.from({ length: e.lanes }, () => [] as number[]));
    this.edgeEntries = new Int32Array(net.edges.length);
    this.fcfsWinTick = new Int32Array(net.nodes.length).fill(-1);
    this.fcfsWinSlot = new Int32Array(net.nodes.length).fill(-1);
    this.idm = makeIdm(cfg);
    this.dt = cfg.sim.dt;
    this.stoppedSpeed = cfg.metrics.stoppedSpeed;
    this.stopZoneM = cfg.priority.stopZoneM;
    this.stuckRerouteS = cfg.routing.stuckRerouteS;
    this.maxReroutes = cfg.routing.maxReroutes;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  /** Queue a routed leg; the vehicle enters the road as soon as there is room. */
  requestSpawn(req: SpawnRequest): void {
    this.waiting.push(req);
  }

  /** Track agents added after construction (headless probe trips). */
  registerAgent(agent: Agent): void {
    while (this.slotOfAgent.length <= agent.id) this.slotOfAgent.push(-1);
  }

  /**
   * Acceptance experiment #2: close roads mid-run. Vehicles already ON a
   * closing edge may finish it; everyone whose remaining route uses one
   * re-plans from their next junction; queued driveway legs re-route whole.
   */
  setEdgesClosed(edgeIds: number[], closed: boolean, t: number): void {
    for (const id of edgeIds) this.net.edges[id].closed = closed;
    if (!closed) return;
    this.forEachActive((slot) => {
      const route = this.routeOf[slot] as Int32Array;
      for (let k = this.routePtr[slot] + 1; k < route.length; k++) {
        if (this.net.edges[route[k]].closed) {
          this.needsReroute[slot] = 1;
          break;
        }
      }
    });
    for (const req of this.waiting) {
      let hit = false;
      for (const id of req.route) {
        if (this.net.edges[id].closed) {
          hit = true;
          break;
        }
      }
      if (hit) {
        const fresh = this.router.route(req.from, req.to, this.agents[req.agentId], t);
        if (fresh !== null) {
          req.route = fresh;
          req.freeFlowS = this.router.routeFreeFlowS(fresh);
        }
      }
    }
  }

  step(t: number, tick: number): void {
    this.reroutes(t);
    this.computeAccels(t, tick);
    this.integrate();
    this.transfers(t);
    this.spawns(t);
  }

  // ---------------------------------------------------------------- reroute

  /**
   * Lane heads re-plan their remaining route when flagged by a closure or
   * when they've been standing long enough to give up on this street
   * (drivers diverting around a jam — pure reaction to observed space).
   */
  private reroutes(t: number): void {
    const { edges } = this.net;
    for (let e = 0; e < edges.length; e++) {
      const laneSet = this.lanes[e];
      for (let li = 0; li < laneSet.length; li++) {
        const fifo = laneSet[li];
        if (fifo.length === 0) continue;
        const i = fifo[0];
        const route = this.routeOf[i] as Int32Array;
        const ptr = this.routePtr[i];
        if (ptr + 1 >= route.length) {
          this.needsReroute[i] = 0;
          continue; // already on the final edge
        }
        const stuck = this.stoppedS[i] >= this.stuckRerouteS && this.rerouted[i] < this.maxReroutes;
        if (this.needsReroute[i] === 0 && !stuck) continue;
        const fresh = this.router.route(
          edges[e].to,
          this.destOf[i],
          this.agents[this.agentOf[i]],
          t,
        );
        this.needsReroute[i] = 0;
        if (fresh === null) continue; // temporarily unreachable; retry via flag later
        const changed = fresh.length !== route.length - ptr - 1 || fresh[0] !== route[ptr + 1];
        if (stuck && !changed) {
          this.rerouted[i] = this.maxReroutes; // no better option exists — stop asking
          continue;
        }
        if (changed) {
          const merged = new Int32Array(1 + fresh.length);
          merged[0] = route[ptr];
          merged.set(fresh, 1);
          this.routeOf[i] = merged;
          this.routePtr[i] = 0;
          this.canCross[i] = 0;
          if (stuck) {
            this.rerouted[i]++;
            this.stoppedS[i] = 0; // fresh patience on the new plan
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ accel

  private computeAccels(t: number, tick: number): void {
    const { edges } = this.net;
    const { idm, pos, vel, lanes } = this;
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      const L = edge.lengthM;
      const laneSet = lanes[e];
      for (let li = 0; li < laneSet.length; li++) {
        const fifo = laneSet[li];
        for (let k = 0; k < fifo.length; k++) {
          const i = fifo[k];
          let v0 = edge.vmax * this.v0mul[i];
          const route = this.routeOf[i] as Int32Array;
          const ptr = this.routePtr[i];
          const nextId = ptr + 1 < route.length ? route[ptr + 1] : -1;
          const distEnd = L - pos[i];
          // Corner friction: slow down into a turn (junctions are zero-length).
          if (nextId >= 0 && edges[nextId].axis !== edge.axis && distEnd <= idm.turnZone) {
            v0 = v0 < idm.turnSpeed ? v0 : idm.turnSpeed;
          }
          let gap: number;
          let vLead: number;
          if (k > 0) {
            const j = fifo[k - 1];
            gap = pos[j] - idm.vehLen - pos[i];
            vLead = vel[j];
          } else {
            gap = this.headGap(i, edge, nextId, distEnd, t, tick);
            vLead = this.headVLead;
          }
          this.acc[i] = idmAccel(idm, vel[i], v0, this.Thw[i], gap, vLead);
        }
      }
    }
  }

  private headVLead = 0;

  /**
   * Leader selection for the first vehicle on a lane — the junction logic.
   * Returns the gap and sets headVLead / canCross / targetLane as side state.
   */
  private headGap(
    i: number,
    edge: NetEdge,
    nextId: number,
    distEnd: number,
    t: number,
    tick: number,
  ): number {
    const { pos, vel, idm } = this;
    if (nextId < 0) {
      // Destination lies at the end of this edge: free run-off, despawn there.
      this.canCross[i] = 1;
      this.headVLead = vel[i];
      return 1e6;
    }
    const node = this.net.nodes[edge.to];
    let green: boolean;
    if (this.net.edges[nextId].closed) {
      // A closed road refuses entry like a hard red; the reroute pass will
      // hand this head a fresh plan within a tick.
      green = false;
    } else if (node.signal !== null) {
      const g = isApproachGreen(node.signal, edge.axis, t);
      // Amber commit: once inside braking distance during green, finish the
      // crossing even if the light flips — that is what real amber is for,
      // and it avoids commanding physically absurd decelerations.
      if (g && distEnd <= (vel[i] * vel[i]) / (2 * idm.b) + idm.commitPad) this.committed[i] = 1;
      green = g || this.committed[i] === 1;
    } else {
      // Unsignalized local junction: deterministic first-come-first-served.
      // Heads register on entering the stop zone; the earliest registration
      // (ties: lower edge, lower lane) holds priority this tick.
      if (distEnd <= this.stopZoneM) {
        if (this.fcfsTick[i] < 0) this.fcfsTick[i] = tick;
        green = this.fcfsWinner(node.id, tick) === i;
      } else {
        green = true; // still far; locals are slow enough to stop within the zone
      }
    }
    if (!green) {
      this.canCross[i] = 0;
      this.headVLead = 0;
      return distEnd; // virtual standing wall AT the stop line (no length term)
    }
    // Green (or priority): follow the tail vehicle of the chosen target lane
    // across the junction. THIS is the spillback rule — if the next edge is
    // jammed back to its entrance, this gap is ~distEnd and the head queues
    // at the line even on green; the jam has propagated upstream one edge.
    const tl = this.pickLane(nextId);
    this.targetLane[i] = tl;
    this.canCross[i] = 1;
    const tFifo = this.lanes[nextId][tl];
    if (tFifo.length === 0) {
      this.headVLead = vel[i];
      return 1e6;
    }
    const tail = tFifo[tFifo.length - 1];
    const gap = distEnd + pos[tail] - idm.vehLen;
    this.headVLead = vel[tail];
    return gap;
  }

  /** Entering vehicles take the emptier lane (tie → lower index). */
  private pickLane(edgeId: number): number {
    const laneSet = this.lanes[edgeId];
    if (laneSet.length === 1) return 0;
    let best = 0;
    for (let li = 1; li < laneSet.length; li++) {
      if (laneSet[li].length < laneSet[best].length) best = li;
    }
    return best;
  }

  private fcfsWinner(nodeId: number, tick: number): number {
    if (this.fcfsWinTick[nodeId] === tick) return this.fcfsWinSlot[nodeId];
    let bestSlot = -1;
    let bestKey = Number.POSITIVE_INFINITY;
    const node = this.net.nodes[nodeId];
    for (const eId of node.inEdges) {
      const laneSet = this.lanes[eId];
      for (let li = 0; li < laneSet.length; li++) {
        const fifo = laneSet[li];
        if (fifo.length === 0) continue;
        const head = fifo[0];
        const reg = this.fcfsTick[head];
        if (reg < 0) continue;
        const key = reg * 4096 + eId * 4 + li; // (arrival tick, edge, lane) lexicographic
        if (key < bestKey) {
          bestKey = key;
          bestSlot = head;
        }
      }
    }
    this.fcfsWinTick[nodeId] = tick;
    this.fcfsWinSlot[nodeId] = bestSlot;
    return bestSlot;
  }

  // -------------------------------------------------------------- integrate

  private integrate(): void {
    const { edges } = this.net;
    const { pos, vel, acc, idm, dt } = this;
    for (let e = 0; e < edges.length; e++) {
      const L = edges[e].lengthM;
      const laneSet = this.lanes[e];
      for (let li = 0; li < laneSet.length; li++) {
        const fifo = laneSet[li];
        for (let k = 0; k < fifo.length; k++) {
          const i = fifo[k];
          ballistic(vel[i], acc[i], dt);
          pos[i] += ballisticOut.dx;
          vel[i] = ballisticOut.v;
          if (k === 0) {
            // A head that may not cross can never pass the stop line.
            if (this.canCross[i] === 0 && pos[i] > L - 0.01) {
              pos[i] = L - 0.01;
              vel[i] = 0;
            }
          } else {
            // Hard anti-overlap safety net (leader k−1 already moved this tick).
            const j = fifo[k - 1];
            const limit = pos[j] - idm.vehLen - 0.05;
            if (pos[i] > limit) {
              pos[i] = limit;
              vel[i] = vel[i] < vel[j] ? vel[i] : vel[j];
            }
          }
          this.stoppedS[i] = vel[i] < this.stoppedSpeed ? this.stoppedS[i] + dt : 0;
        }
      }
    }
  }

  // -------------------------------------------------------------- transfers

  private transfers(t: number): void {
    const { edges } = this.net;
    const { pos, vel, idm } = this;
    for (let e = 0; e < edges.length; e++) {
      const L = edges[e].lengthM;
      const laneSet = this.lanes[e];
      for (let li = 0; li < laneSet.length; li++) {
        const fifo = laneSet[li];
        while (fifo.length > 0) {
          const i = fifo[0];
          if (pos[i] < L || this.canCross[i] === 0) break;
          const route = this.routeOf[i] as Int32Array;
          const ptr = this.routePtr[i];
          // Feed the router: this vehicle just finished this edge.
          this.router.observe(e, t - this.enterT[i], t);
          if (ptr + 1 >= route.length) {
            // Arrived: leave the road (capacity releases instantly —
            // a noted artifact).
            fifo.shift();
            this.despawn(i, t);
            continue;
          }
          const nextId = route[ptr + 1];
          const tl = this.targetLane[i];
          const tFifo = this.lanes[nextId][tl];
          let insertPos = pos[i] - L; // overshoot carry: never reset to 0
          if (tFifo.length > 0) {
            const tail = tFifo[tFifo.length - 1];
            const maxPos = pos[tail] - idm.vehLen - 0.1;
            if (maxPos < 0) {
              // Same-tick race: someone else filled the entrance. Hold the line.
              pos[i] = L - 0.01;
              vel[i] = 0;
              break;
            }
            if (insertPos > maxPos) {
              insertPos = maxPos;
              vel[i] = vel[i] < vel[tail] ? vel[i] : vel[tail];
            }
          }
          fifo.shift();
          tFifo.push(i);
          this.edgeOf[i] = nextId;
          this.laneOf[i] = tl;
          this.pos[i] = insertPos;
          this.routePtr[i] = ptr + 1;
          this.committed[i] = 0;
          this.canCross[i] = 0;
          this.fcfsTick[i] = -1;
          this.enterT[i] = t;
          this.edgeEntries[nextId]++;
        }
      }
    }
  }

  // ------------------------------------------------------------------ spawn

  private spawns(t: number): void {
    const { idm } = this;
    let keep = 0;
    for (let r = 0; r < this.waiting.length; r++) {
      const req = this.waiting[r];
      const firstEdge = req.route[0];
      const tl = this.pickLane(firstEdge);
      const fifo = this.lanes[firstEdge][tl];
      const tailClear = fifo.length === 0 || this.pos[fifo[fifo.length - 1]] >= idm.vehLen + idm.s0;
      if (tailClear && this.freeStack.length > 0) {
        const agent = this.agents[req.agentId];
        const i = this.freeStack.pop() as number;
        this.pos[i] = 0;
        this.vel[i] = 0;
        this.acc[i] = 0;
        this.edgeOf[i] = firstEdge;
        this.laneOf[i] = tl;
        this.routePtr[i] = 0;
        this.agentOf[i] = req.agentId;
        this.v0mul[i] = agent.v0mul;
        this.Thw[i] = agent.T;
        this.spawnT[i] = t;
        this.stoppedS[i] = 0;
        this.enterT[i] = t;
        this.kindOf[i] = KIND_IDX[req.kind];
        this.planS[i] = req.plannedS;
        this.ffS[i] = req.freeFlowS;
        this.destOf[i] = req.to;
        this.rerouted[i] = 0;
        this.needsReroute[i] = 0;
        this.fcfsTick[i] = -1;
        this.committed[i] = 0;
        this.canCross[i] = 0;
        this.routeOf[i] = req.route;
        fifo.push(i);
        this.slotOfAgent[req.agentId] = i;
        this.activeCount++;
        this.edgeEntries[firstEdge]++;
      } else {
        this.waiting[keep++] = req; // stay in the driveway queue, retry next tick
      }
    }
    this.waiting.length = keep;
  }

  /** The single place a vehicle leaves the road: lane removal happened first. */
  private despawn(i: number, t: number): void {
    const agent = this.agents[this.agentOf[i]];
    this.tripArrivals.push({
      agentId: agent.id,
      kind: KINDS[this.kindOf[i]],
      mode: "car",
      plannedDepartS: this.planS[i],
      arriveS: t,
      freeFlowS: this.ffS[i],
      dest: this.destOf[i],
    });
    this.slotOfAgent[agent.id] = -1;
    this.routeOf[i] = null;
    this.freeStack.push(i);
    this.activeCount--;
    this.arrivedCount++;
  }

  /** Deterministic iteration over active vehicles (edges → lanes → FIFO order). */
  forEachActive(cb: (slot: number, edge: NetEdge) => void): void {
    const { edges } = this.net;
    for (let e = 0; e < edges.length; e++) {
      const laneSet = this.lanes[e];
      for (let li = 0; li < laneSet.length; li++) {
        const fifo = laneSet[li];
        for (let k = 0; k < fifo.length; k++) cb(fifo[k], edges[e]);
      }
    }
  }

  /** Live route of an on-road agent (for trace display); null if not driving. */
  liveRoute(agentId: number): Int32Array | null {
    const slot = this.slotOfAgent[agentId] ?? -1;
    return slot >= 0 ? this.routeOf[slot] : null;
  }
}
