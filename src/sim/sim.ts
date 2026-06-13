import type { SimsConfig } from "../config";
import { EmergencySystem } from "./emergency";
import { applyDayLearning } from "./learning";
import { Metrics } from "./metrics";
import { buildNetwork } from "./network";
import { assignEconomy, buildPlaces, type Places } from "./places";
import { buildPopulation } from "./population";
import { makeStream } from "./rng";
import { Router } from "./routing";
import { Scheduler } from "./scheduler";
import { TrafficEngine } from "./traffic/engine";
import { buildLine, type TransitLine, TransitSystem, transitEstimateS } from "./transit";
import type { Agent, Network } from "./types";
import { WalkSystem } from "./walkers";

/**
 * Framework-agnostic simulation façade: everything the browser front-end or
 * the headless runner needs, with no DOM dependencies anywhere beneath it.
 */
export interface Simulation {
  cfg: SimsConfig;
  net: Network;
  agents: Agent[];
  places: Places;
  engine: TrafficEngine;
  walk: WalkSystem;
  transit: TransitSystem;
  line: TransitLine;
  scheduler: Scheduler;
  metrics: Metrics;
  emergency: EmergencySystem;
  /** Current sim time, ABSOLUTE seconds (day 2 starts at 86400). */
  readonly t: number;
  readonly tick: number;
  /** 0-based simulated day index. */
  readonly day: number;
  step(nSteps: number): void;
  /** True once the day is over and every chained trip has finished. */
  isDone(): boolean;
  /** Inject a synthetic one-way trip now (headless probes). Returns its agent id. */
  injectTrip(home: number, work: number): number;
  /** Acceptance experiment #2: close / reopen the arterial bridge mid-run. */
  setArterialBridgeClosed(closed: boolean): void;
  arterialBridgeClosed(): boolean;
  /** FNV-1a hash of all dynamic state — the determinism fingerprint. */
  hashState(): string;
}

export function createSimulation(cfg: SimsConfig): Simulation {
  const worldRng = makeStream(cfg.seed, "worldgen");
  const popRng = makeStream(cfg.seed, "population");
  const econRng = makeStream(cfg.seed, "economy");

  const net = buildNetwork(cfg, worldRng);
  const agents = buildPopulation(cfg, net, popRng);
  const places = buildPlaces(cfg, net, makeStream(cfg.seed, "places"));
  const router = new Router(cfg, net);
  const line = buildLine(cfg, net);
  finalizePlans(cfg, agents, router, line, net);
  // Economy runs AFTER finalizePlans so each agent's final mode is known
  // (outings are drivers-only). Its own stream keeps commute draws untouched.
  assignEconomy(cfg, agents, places, econRng);

  const walk = new WalkSystem(net);
  const transit = new TransitSystem(net, line, cfg.network.spacingM);
  const engine = new TrafficEngine(cfg, net, agents, router);
  const scheduler = new Scheduler(cfg, net, agents, engine, walk, transit, router);
  const metrics = new Metrics(cfg, net);
  const emergency = new EmergencySystem(cfg, net, router, places);
  scheduler.scheduleDay(0);
  let learnedUpTo = 0; // index into metrics.trips already consumed by learning

  // The "close a bridge" experiment shuts ONE arterial bridge (the lowest
  // such column) so traffic visibly reroutes onto the parallel crossings —
  // with several bridges now, closing them all would just sever the banks.
  const arterialBridgeColsSet = new Set(
    net.edges
      .filter((e) => e.isBridge && cfg.network.arterialCols.includes(e.bridgeCol))
      .map((e) => e.bridgeCol),
  );
  const closeCol = [...arterialBridgeColsSet].sort((a, b) => a - b)[0];
  const arterialBridgeEdges = net.edges
    .filter((e) => e.isBridge && e.bridgeCol === closeCol)
    .map((e) => e.id);

  return {
    cfg,
    net,
    agents,
    places,
    engine,
    walk,
    transit,
    line,
    scheduler,
    metrics,
    emergency,
    get t() {
      return scheduler.t;
    },
    get tick() {
      return scheduler.tick;
    },
    get day() {
      return Math.floor(scheduler.t / 86400);
    },
    step(nSteps: number): void {
      for (let s = 0; s < nSteps; s++) {
        scheduler.step();
        metrics.update(scheduler.t, engine, walk, transit, scheduler);
        emergency.step(scheduler.t, cfg.sim.dt);
        // Midnight rollover: everyone sleeps on what the day taught them,
        // then tomorrow's departures enter the heap.
        const t = scheduler.t;
        if (t > 0 && t % 86400 === 0) {
          const finishedDay = t / 86400 - 1;
          learnedUpTo = applyDayLearning(cfg, agents, metrics.trips, learnedUpTo, finishedDay);
          scheduler.scheduleDay(t / 86400);
        }
      }
    },
    isDone(): boolean {
      // Multi-day: the city never ends; "done" only means the road has
      // drained AND nothing is scheduled — which rollover always prevents.
      return (
        engine.activeCount === 0 &&
        engine.waitingCount === 0 &&
        walk.count === 0 &&
        transit.count === 0 &&
        scheduler.pendingTrips === 0
      );
    },
    injectTrip(home: number, work: number): number {
      const id = agents.length;
      const agent: Agent = {
        id,
        home,
        work,
        mode: "car",
        workStartS: scheduler.t,
        workDurS: 0,
        bufferS: 0,
        departS: scheduler.t,
        freeFlowS: 0,
        expectedS: 0,
        canTransit: false,
        expectedTransitS: 0,
        transitBaseS: 0,
        transitAffinity: 1,
        errand: null,
        outing: null,
        money: 0,
        wage: 0,
        wfhPay: 0,
        v0mul: 1,
        T: (cfg.idm.TMin + cfg.idm.TMax) / 2,
        walkSpeed: 1.4,
        affinity: 1,
        route: null,
        probe: true,
      };
      agents.push(agent);
      engine.registerAgent(agent);
      scheduler.push(scheduler.t, id, "toWork", home, work);
      return id;
    },
    setArterialBridgeClosed(closed: boolean): void {
      engine.setEdgesClosed(arterialBridgeEdges, closed, scheduler.t);
    },
    arterialBridgeClosed(): boolean {
      return net.edges[arterialBridgeEdges[0]].closed;
    },
    hashState(): string {
      let h = 0x811c9dc5;
      const mix = (n: number): void => {
        // FNV-1a over the 4 bytes of an int32.
        let x = n | 0;
        for (let b = 0; b < 4; b++) {
          h ^= x & 0xff;
          h = Math.imul(h, 0x01000193);
          x >>>= 8;
        }
      };
      const f32 = new Float32Array(1);
      const i32 = new Int32Array(f32.buffer);
      const mixF = (n: number): void => {
        f32[0] = n;
        mix(i32[0]);
      };
      mix(scheduler.tick);
      mix(engine.activeCount);
      mix(engine.arrivedCount);
      mix(walk.count);
      mix(scheduler.pendingTrips);
      engine.forEachActive((slot) => {
        mix(engine.agentOf[slot]);
        mixF(engine.pos[slot]);
        mixF(engine.vel[slot]);
      });
      walk.forEach((agentId, edgeId, posM) => {
        mix(agentId);
        mix(edgeId);
        mixF(posM);
      });
      transit.forEachState((agentId, phase, distM) => {
        mix(agentId);
        mix(phase);
        mixF(distM);
      });
      for (let i = 0; i < scheduler.workersAt.length; i++) {
        mix(scheduler.workersAt[i]);
        mix(scheduler.residentsAt[i]);
      }
      for (const trip of metrics.trips) {
        mix(trip.agentId);
        mixF(trip.arriveS);
      }
      // Economy is deterministic too — fold every balance into the fingerprint.
      for (const a of agents) mixF(a.money);
      // Emergencies are deterministic too (Poisson hazard off a seeded stream).
      mix(emergency.ignitedCount);
      for (const f of emergency.fires) {
        mix(f.node);
        mix(f.state === "burning" ? 1 : 0);
      }
      for (const v of emergency.vehicles) {
        mix(v.id);
        mix(v.edgeIdx);
        mixF(v.posM);
      }
      return (h >>> 0).toString(16).padStart(8, "0");
    },
  };
}

/**
 * Turn sampled plans into concrete departures. Walk-preferrers whose commute
 * is too long become drivers; drivers near the tram line get it as a learned
 * alternative; everyone gets departS = workStart − expected travel (free-flow
 * — what people assume when planning) − personal buffer.
 */
function finalizePlans(
  cfg: SimsConfig,
  agents: Agent[],
  router: Router,
  line: TransitLine,
  net: Network,
): void {
  for (const agent of agents) {
    if (agent.mode === "walk") {
      const wr = router.walkRoute(agent.home, agent.work);
      const dist = wr !== null ? router.routeLengthM(wr) : Number.POSITIVE_INFINITY;
      if (dist > cfg.population.walk.maxDistM) {
        agent.mode = "car";
      } else {
        agent.freeFlowS = dist / agent.walkSpeed;
      }
    }
    if (agent.mode === "car") {
      const r = router.routeFreeFlow(agent.home, agent.work, agent);
      agent.freeFlowS = r !== null ? router.routeFreeFlowS(r) : 0;
      // Is the tram an option for this commute?
      const est = transitEstimateS(
        line,
        net,
        cfg.network.spacingM,
        agent.home,
        agent.work,
        agent.walkSpeed,
      );
      if (
        est !== null &&
        est.access <= cfg.transit.maxAccessM &&
        est.egress <= cfg.transit.maxAccessM
      ) {
        agent.canTransit = true;
        agent.transitBaseS = est.totalS;
        agent.expectedTransitS = est.totalS;
      }
    }
    if (agent.mode === "wfh") continue;
    // Day 0 belief: free-flow driving (optimism — nobody has sat in this
    // city's traffic yet, so nobody starts on the tram). Learning fixes that.
    agent.expectedS = agent.freeFlowS;
    agent.departS = Math.max(0, agent.workStartS - agent.expectedS - agent.bufferS);
  }
}
