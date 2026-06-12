import type { SimsConfig } from "../config";
import { applyDayLearning } from "./learning";
import { Metrics } from "./metrics";
import { buildNetwork } from "./network";
import { buildPopulation } from "./population";
import { makeStream } from "./rng";
import { Router } from "./routing";
import { Scheduler } from "./scheduler";
import { TrafficEngine } from "./traffic/engine";
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
  engine: TrafficEngine;
  walk: WalkSystem;
  scheduler: Scheduler;
  metrics: Metrics;
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

  const net = buildNetwork(cfg, worldRng);
  const agents = buildPopulation(cfg, net, popRng);
  const router = new Router(cfg, net);
  finalizePlans(cfg, agents, router);

  const walk = new WalkSystem(net);
  const engine = new TrafficEngine(cfg, net, agents, router);
  const scheduler = new Scheduler(cfg, net, agents, engine, walk, router);
  const metrics = new Metrics(cfg, net);
  scheduler.scheduleDay(0);
  let learnedUpTo = 0; // index into metrics.trips already consumed by learning

  const arterialBridgeEdges = net.edges
    .filter((e) => e.isBridge && cfg.network.arterialCols.includes(e.bridgeCol))
    .map((e) => e.id);

  return {
    cfg,
    net,
    agents,
    engine,
    walk,
    scheduler,
    metrics,
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
        metrics.update(scheduler.t, engine, walk, scheduler);
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
        errand: null,
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
      for (let i = 0; i < scheduler.workersAt.length; i++) {
        mix(scheduler.workersAt[i]);
        mix(scheduler.residentsAt[i]);
      }
      for (const trip of metrics.trips) {
        mix(trip.agentId);
        mixF(trip.arriveS);
      }
      return (h >>> 0).toString(16).padStart(8, "0");
    },
  };
}

/**
 * Turn sampled plans into concrete departures. Walk-preferrers whose commute
 * is too long become drivers; everyone gets departS = workStart − expected
 * travel (free-flow — what people assume when planning) − personal buffer.
 */
function finalizePlans(cfg: SimsConfig, agents: Agent[], router: Router): void {
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
    }
    if (agent.mode === "wfh") continue;
    // Day 0 belief: the free-flow time (optimism — nobody has sat in this
    // city's traffic yet). Learning replaces it with experience nightly.
    agent.expectedS = agent.freeFlowS;
    agent.departS = Math.max(0, agent.workStartS - agent.expectedS - agent.bufferS);
  }
}
