import type { SimsConfig } from "../config";
import { normalClamped, pickCumulative, type Rng, uniform } from "./rng";
import type { Agent, Network } from "./types";

/**
 * Population & daily plans.
 *
 * THIS FILE IS THE ONLY PLACE THE CLOCK IS ALLOWED TO SHAPE BEHAVIOUR.
 * Each agent samples a personal plan — "be at work by 08:23, stay ~8.6 h,
 * maybe pop out for a midday errand, then come home" — from the configured
 * distributions. Everything the simulation later shows (the morning peak,
 * the evening peak, midday background traffic, businesses lighting up,
 * residential windows going dark at 9 am) is a downstream consequence of
 * thousands of these independent plans executing on a finite network.
 * Flatten these distributions and every peak disappears; nothing else in the
 * codebase knows what "rush hour" is.
 *
 * The flattenSchedules scenario (acceptance experiment #1) swaps the start
 * mixture for a uniform draw across the day — the ONLY change — and the
 * peaks must vanish with it.
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
    // Every agent draws the SAME sequence of samples regardless of which
    // branch it lands in — keeps the rng layout stable under config tweaks.
    const home = pickCumulative(rng, homeCum);
    let work = pickCumulative(rng, jobCum);
    for (let tries = 0; work === home && tries < 20; tries++) {
      work = pickCumulative(rng, jobCum);
    }
    const modeDraw = rng();
    const mixDraw = pickCumulative(rng, mixCum);
    const flatDraw = rng();
    const workDurRaw = normalClamped(
      rng,
      p.workDur.mu,
      p.workDur.sigma,
      p.workDur.min,
      p.workDur.max,
    );
    const bufferS = normalClamped(rng, p.buffer.mu, p.buffer.sigma, p.buffer.min, p.buffer.max);
    const v0mul = normalClamped(rng, 1, cfg.idm.v0Sigma, cfg.idm.v0MulMin, cfg.idm.v0MulMax);
    const T = cfg.idm.TMin + (cfg.idm.TMax - cfg.idm.TMin) * rng();
    const affinity = normalClamped(
      rng,
      1,
      p.arterialAffinitySigma,
      p.arterialAffinityClamp[0],
      p.arterialAffinityClamp[1],
    );
    const walkSpeed = uniform(rng, p.walk.speedMin, p.walk.speedMax);
    const errandDraw = rng();
    const errandAfterS = uniform(rng, p.errand.afterMinS, p.errand.afterMaxS);
    const errandDwellS = uniform(rng, p.errand.dwellMinS, p.errand.dwellMaxS);
    let errandNode = pickCumulative(rng, jobCum);
    const transitAffinity = normalClamped(
      rng,
      cfg.transit.affinity.mu,
      cfg.transit.affinity.sigma,
      cfg.transit.affinity.clamp[0],
      cfg.transit.affinity.clamp[1],
    );

    // Work start: the plan mixture — or, under the flatten experiment, a
    // uniform draw (this single substitution is what kills rush hour).
    let workStartS: number;
    if (cfg.scenario.flattenSchedules) {
      workStartS =
        cfg.scenario.flattenRangeS[0] +
        flatDraw * (cfg.scenario.flattenRangeS[1] - cfg.scenario.flattenRangeS[0]);
    } else {
      const comp = p.startMix[mixDraw];
      workStartS = normalClamped(rng, comp.mu, comp.sigma, p.startClampS[0], p.startClampS[1]);
    }
    // Everyone is home before midnight: clamp the workday end.
    const workDurS = Math.min(workDurRaw, p.latestEndS - workStartS);

    const mode: Agent["mode"] =
      modeDraw < p.modes.wfh ? "wfh" : modeDraw < p.modes.wfh + p.modes.walkPref ? "walk" : "car";

    // Midday errand (drivers only): planned exit from work and a shop target.
    let errand: Agent["errand"] = null;
    if (
      mode === "car" &&
      errandDraw < p.errand.share &&
      errandAfterS + errandDwellS + p.errand.minRemainderS < workDurS
    ) {
      if (errandNode === work) errandNode = (errandNode + 7) % nNodes;
      errand = {
        departS: workStartS + errandAfterS,
        dwellS: errandDwellS,
        node: errandNode,
        // Retargeted onto a real POI (with its cost) by assignEconomy.
        kind: "shop",
        cost: 0,
      };
    }

    agents.push({
      id,
      home,
      work,
      mode,
      workStartS,
      workDurS,
      bufferS,
      departS: workStartS, // provisional; planning fills the real value
      freeFlowS: 0,
      expectedS: 0,
      canTransit: false, // planning fills these once the line geometry is known
      expectedTransitS: 0,
      transitBaseS: 0,
      transitAffinity,
      errand,
      outing: null, // filled by assignEconomy
      money: 0,
      wage: 0,
      wfhPay: 0,
      v0mul,
      T,
      walkSpeed,
      affinity,
      route: null,
    });
  }
  return agents;
}
