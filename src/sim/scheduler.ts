import type { SimsConfig } from "../config";
import type { Router } from "./routing";
import type { TrafficEngine } from "./traffic/engine";
import type { Agent, Network, TripArrival, TripEvent, TripKind } from "./types";
import type { WalkSystem } from "./walkers";

/**
 * The tick loop and the day's choreography.
 *
 * Trips are EVENTS in a priority heap, not a precomputed list, because the
 * day chains: you can only head home after you actually reached work, and a
 * commute that congestion made 40 minutes late pushes the whole rest of that
 * person's day. (toWork arrival → maybe errand → errand return → toHome.)
 *
 * The scheduler also maintains building occupancy — workersAt / residentsAt
 * per node — purely from real arrivals and departures. "A business opens"
 * MEANS its first worker walked in; nothing reads opening hours anywhere.
 */
export class Scheduler {
  tick = 0;
  private readonly dt: number;
  private readonly chainGapS: number;
  private readonly heap: TripEvent[] = [];
  private seq = 0;
  /** People currently inside buildings, by node. */
  readonly workersAt: Int32Array;
  readonly residentsAt: Int32Array;
  /** Completed legs (drained by metrics). */
  readonly completed: TripArrival[] = [];

  constructor(
    cfg: SimsConfig,
    net: Network,
    private readonly agents: Agent[],
    private readonly engine: TrafficEngine,
    private readonly walk: WalkSystem,
    private readonly router: Router,
  ) {
    this.dt = cfg.sim.dt;
    this.chainGapS = cfg.population.chainGapS;
    this.workersAt = new Int32Array(net.nodes.length);
    this.residentsAt = new Int32Array(net.nodes.length);
    for (const a of agents) {
      this.residentsAt[a.home]++; // everyone starts the day at home
      if (a.mode !== "wfh") {
        this.push(a.departS, a.id, "toWork", a.home, a.work);
      }
    }
  }

  get t(): number {
    return this.tick * this.dt;
  }

  get pendingTrips(): number {
    return this.heap.length;
  }

  /** External (probe) trips enter through the same heap. */
  push(timeS: number, agentId: number, kind: TripKind, from: number, to: number): void {
    const ev: TripEvent = { timeS, seq: this.seq++, agentId, kind, from, to };
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (before(h[parent], ev)) break;
      h[i] = h[parent];
      i = parent;
    }
    h[i] = ev;
  }

  private pop(): TripEvent {
    const h = this.heap;
    const top = h[0];
    const last = h.pop() as TripEvent;
    if (h.length > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= h.length) break;
        const r = l + 1;
        const child = r < h.length && before(h[r], h[l]) ? r : l;
        if (before(last, h[child])) break;
        h[i] = h[child];
        i = child;
      }
      h[i] = last;
    }
    return top;
  }

  step(): void {
    const t = this.t;

    // Dispatch every due trip: route NOW, on currently observed travel times.
    while (this.heap.length > 0 && this.heap[0].timeS <= t) {
      const ev = this.pop();
      const agent = this.agents[ev.agentId];
      if (agent.mode === "car") {
        const route = this.router.route(ev.from, ev.to, agent, t);
        if (route === null) {
          this.push(t + 60, ev.agentId, ev.kind, ev.from, ev.to); // closed off; retry shortly
          continue;
        }
        agent.route = route;
        this.leaveBuilding(ev, agent);
        this.engine.requestSpawn({
          agentId: ev.agentId,
          kind: ev.kind,
          from: ev.from,
          to: ev.to,
          route,
          freeFlowS: this.router.routeFreeFlowS(route),
          plannedS: ev.timeS,
        });
      } else {
        const route = this.router.walkRoute(ev.from, ev.to);
        if (route === null) continue; // cannot happen: walk ignores closures
        agent.route = route;
        this.leaveBuilding(ev, agent);
        this.walk.start(
          {
            agentId: ev.agentId,
            kind: ev.kind,
            from: ev.from,
            to: ev.to,
            route,
            freeFlowS: 0,
            plannedS: ev.timeS,
          },
          agent.walkSpeed,
          t,
        );
      }
    }

    this.engine.step(t, this.tick);
    this.walk.step(t, this.dt);

    // Arrivals (deterministic order: engine's edge order, then walkers).
    for (const arr of this.engine.tripArrivals) this.handleArrival(arr);
    this.engine.tripArrivals.length = 0;
    for (const arr of this.walk.arrivals) this.handleArrival(arr);
    this.walk.arrivals.length = 0;

    this.tick++;
  }

  private leaveBuilding(ev: TripEvent, agent: Agent): void {
    if (ev.kind === "toWork") this.residentsAt[agent.home]--;
    else if (ev.kind === "toErrand" || ev.kind === "toHome") this.workersAt[agent.work]--;
    // errandReturn departs from the shop — no tracked occupancy there.
  }

  /** Chain the rest of the day off real arrival times. */
  private handleArrival(arr: TripArrival): void {
    this.completed.push(arr);
    const agent = this.agents[arr.agentId];
    if (agent === undefined || agent.probe === true) return;
    const earliestNext = arr.arriveS + this.chainGapS;
    switch (arr.kind) {
      case "toWork": {
        this.workersAt[agent.work]++;
        if (agent.errand !== null) {
          this.push(
            Math.max(agent.errand.departS, earliestNext),
            agent.id,
            "toErrand",
            agent.work,
            agent.errand.node,
          );
        } else {
          this.push(
            Math.max(agent.workStartS + agent.workDurS, earliestNext),
            agent.id,
            "toHome",
            agent.work,
            agent.home,
          );
        }
        break;
      }
      case "toErrand": {
        const errand = agent.errand;
        if (errand !== null) {
          this.push(arr.arriveS + errand.dwellS, agent.id, "errandReturn", errand.node, agent.work);
        }
        break;
      }
      case "errandReturn": {
        this.workersAt[agent.work]++;
        this.push(
          Math.max(agent.workStartS + agent.workDurS, earliestNext),
          agent.id,
          "toHome",
          agent.work,
          agent.home,
        );
        break;
      }
      case "toHome": {
        this.residentsAt[agent.home]++;
        break;
      }
    }
  }
}

function before(a: TripEvent, b: TripEvent): boolean {
  return a.timeS < b.timeS || (a.timeS === b.timeS && a.seq < b.seq);
}
