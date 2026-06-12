import type { SimsConfig } from "../config";
import { clamp, hash2 } from "./rng";
import type { Agent, TripArrival } from "./types";

/**
 * Day-to-day learning — applied once per midnight.
 *
 * Each agent looks at exactly one thing: their OWN morning commute today.
 *  1. expectedS ← EMA toward the experienced door-to-desk time. A driver who
 *     sat 20 minutes in the bridge queue now *plans* for a longer commute and
 *     therefore departs earlier tomorrow.
 *  2. bufferS grows when they arrived LATE (fear of lateness is asymmetric)
 *     and decays slowly when they wasted more than `earlySlackS` being early.
 *
 * Aggregated over thousands of agents this reproduces the classic emergent
 * result: the morning peak SPREADS EARLIER and flattens over successive days
 * as everyone individually tries to beat the jam — and partially recreates
 * it earlier, until experience and expectation stop disagreeing.
 *
 * No agent sees another agent's data, the network, or any aggregate. The
 * clock plays no role beyond each person's own target arrival time.
 */
export function applyDayLearning(
  cfg: SimsConfig,
  agents: Agent[],
  trips: TripArrival[],
  fromIdx: number,
  day: number,
): number {
  const L = cfg.learning;
  for (let i = fromIdx; i < trips.length; i++) {
    const tr = trips[i];
    if (tr.kind !== "toWork") continue;
    const agent = agents[tr.agentId];
    if (agent === undefined || agent.probe === true) continue;
    // Only a share of people rethink their routine on any given night —
    // deterministic per (agent, day), and the damper that keeps the whole
    // city from over-correcting in lockstep.
    if (hash2(agent.id, 7919 + day) >= L.reviseShare) continue;

    const experiencedS = tr.arriveS - tr.plannedDepartS;
    agent.expectedS += L.lambda * (experiencedS - agent.expectedS);

    const arriveTod = tr.arriveS % 86400;
    const lateS = arriveTod - agent.workStartS;
    if (lateS > 0) {
      agent.bufferS += L.lateBufferGain * lateS;
    } else if (-lateS > L.earlySlackS) {
      agent.bufferS -= L.earlyBufferDecay * (-lateS - L.earlySlackS);
    }
    agent.bufferS = clamp(agent.bufferS, L.bufferClampS[0], L.bufferClampS[1]);
  }

  // Tomorrow's plan: same target, revised beliefs.
  for (const agent of agents) {
    if (agent.probe === true || agent.mode === "wfh") continue;
    agent.departS = Math.max(0, agent.workStartS - agent.expectedS - agent.bufferS);
  }
  return trips.length;
}
