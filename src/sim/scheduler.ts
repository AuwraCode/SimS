import type { SimsConfig } from "../config";
import type { TrafficEngine } from "./traffic/engine";
import type { Agent } from "./types";

/**
 * The tick loop: advances the fixed-dt clock and dispatches departures.
 * Time is always derived as tick × dt (dt = 0.5 s is exact in binary), so
 * there is no floating-point drift between long and short runs.
 */
export class Scheduler {
  tick = 0;
  private ptr = 0;
  private readonly order: Agent[];
  private readonly dt: number;

  constructor(
    cfg: SimsConfig,
    agents: Agent[],
    private readonly engine: TrafficEngine,
  ) {
    this.dt = cfg.sim.dt;
    // Stable order: (departure time, agentId) — determinism under equal times.
    this.order = agents
      .filter((a) => a.mode === "car")
      .sort((a, b) => a.departS - b.departS || a.id - b.id);
  }

  get t(): number {
    return this.tick * this.dt;
  }

  /** Drivers whose planned departure is still in the future. */
  get pendingDepartures(): number {
    return this.order.length - this.ptr;
  }

  step(): void {
    const t = this.t;
    while (this.ptr < this.order.length && this.order[this.ptr].departS <= t) {
      this.engine.requestSpawn(this.order[this.ptr].id);
      this.ptr++;
    }
    this.engine.step(t, this.tick);
    this.tick++;
  }
}
