import type { SimsConfig } from "../config";
import { Metrics } from "./metrics";
import { buildNetwork } from "./network";
import { buildPopulation } from "./population";
import { makeStream } from "./rng";
import { assignRoutes } from "./routing";
import { Scheduler } from "./scheduler";
import { TrafficEngine } from "./traffic/engine";
import type { Agent, Network } from "./types";

/**
 * Framework-agnostic simulation façade: everything the browser front-end or
 * the headless runner needs, with no DOM dependencies anywhere beneath it.
 */
export interface Simulation {
  cfg: SimsConfig;
  net: Network;
  agents: Agent[];
  engine: TrafficEngine;
  metrics: Metrics;
  /** Current sim time, seconds of day. */
  readonly t: number;
  readonly tick: number;
  step(nSteps: number): void;
  /** True once the day is over and the road has drained. */
  isDone(): boolean;
  /** Inject a synthetic trip now (headless probes). Returns its agent id. */
  injectTrip(home: number, work: number): number;
  /** FNV-1a hash of all dynamic state — the determinism fingerprint. */
  hashState(): string;
}

export function createSimulation(cfg: SimsConfig): Simulation {
  const worldRng = makeStream(cfg.seed, "worldgen");
  const popRng = makeStream(cfg.seed, "population");
  const probeRng = makeStream(cfg.seed, "probes");

  const net = buildNetwork(cfg, worldRng);
  const agents = buildPopulation(cfg, net, popRng);
  assignRoutes(cfg, net, agents, popRng);

  const engine = new TrafficEngine(cfg, net, agents);
  const scheduler = new Scheduler(cfg, agents, engine);
  const metrics = new Metrics(cfg);

  return {
    cfg,
    net,
    agents,
    engine,
    metrics,
    get t() {
      return scheduler.t;
    },
    get tick() {
      return scheduler.tick;
    },
    step(nSteps: number): void {
      for (let s = 0; s < nSteps; s++) {
        scheduler.step();
        metrics.update(scheduler.t, engine);
      }
    },
    isDone(): boolean {
      return (
        scheduler.t >= cfg.sim.dayEndS &&
        engine.activeCount === 0 &&
        engine.waitingCount === 0 &&
        scheduler.pendingDepartures === 0
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
        v0mul: 1,
        T: (cfg.idm.TMin + cfg.idm.TMax) / 2,
        route: null,
      };
      agents.push(agent);
      assignRoutes(cfg, net, [agent], probeRng);
      agent.departS = scheduler.t; // probes leave NOW, whatever routing planned
      engine.registerAgent(agent);
      engine.requestSpawn(id);
      return id;
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
      mix(engine.bridgeCrossings);
      engine.forEachActive((slot) => {
        mix(engine.agentOf[slot]);
        mixF(engine.pos[slot]);
        mixF(engine.vel[slot]);
      });
      for (const trip of metrics.trips) {
        mix(trip.agentId);
        mixF(trip.arriveS);
      }
      return (h >>> 0).toString(16).padStart(8, "0");
    },
  };
}
