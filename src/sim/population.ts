import type { SimsConfig } from "../config";
import { type Rng, normalClamped, pickCumulative } from "./rng";
import type { Agent, Network } from "./types";

/**
 * Population & daily plans.
 *
 * THIS FILE IS THE ONLY PLACE THE CLOCK IS ALLOWED TO SHAPE BEHAVIOUR.
 * Each agent samples a personal plan ("be at work by 08:23") from the
 * configured mixture distributions. Everything the simulation later shows —
 * the morning peak, the queues, the speed collapse — is a downstream
 * consequence of thousands of these independent plans overlapping on a
 * network with finite capacity. Flatten these distributions and the peaks
 * disappear; nothing else in the codebase knows what "rush hour" is.
 */
export function buildPopulation(cfg: SimsConfig, net: Network, rng: Rng): Agent[] {
  const p = cfg.population;
  const nNodes = net.nodes.length;

  // Cumulative land-use weights → weighted node sampling for homes and jobs.
  const homeCum = new Float64Array(nNodes);
  const jobCum = new Float64Array(nNodes);
  let hAcc = 0;
  let jAcc = 0;
  for (let i = 0; i < nNodes; i++) {
    hAcc += net.nodes[i].homeW;
    jAcc += net.nodes[i].jobW;
    homeCum[i] = hAcc;
    jobCum[i] = jAcc;
  }

  const mixCum = new Float64Array(p.startMix.length);
  let mAcc = 0;
  for (let i = 0; i < p.startMix.length; i++) {
    mAcc += p.startMix[i].w;
    mixCum[i] = mAcc;
  }

  const agents: Agent[] = [];
  for (let id = 0; id < p.N; id++) {
    const home = pickCumulative(rng, homeCum);
    let work = pickCumulative(rng, jobCum);
    for (let tries = 0; work === home && tries < 20; tries++) {
      work = pickCumulative(rng, jobCum);
    }
    const drives = rng() < p.driverShare;

    const comp = p.startMix[pickCumulative(rng, mixCum)];
    const workStartS = normalClamped(
      rng,
      comp.mu,
      comp.sigma,
      p.startClampS[0],
      p.startClampS[1],
    );
    const workDurS = normalClamped(rng, p.workDur.mu, p.workDur.sigma, p.workDur.min, p.workDur.max);
    const bufferS = normalClamped(rng, p.buffer.mu, p.buffer.sigma, p.buffer.min, p.buffer.max);
    const v0mul = normalClamped(rng, 1, cfg.idm.v0Sigma, cfg.idm.v0MulMin, cfg.idm.v0MulMax);
    const T = cfg.idm.TMin + (cfg.idm.TMax - cfg.idm.TMin) * rng();

    agents.push({
      id,
      home,
      work,
      mode: drives ? "car" : "offroad",
      workStartS,
      workDurS,
      bufferS,
      departS: workStartS, // provisional; routing fills the real value for drivers
      freeFlowS: 0,
      v0mul,
      T,
      route: null,
    });
  }
  return agents;
}
