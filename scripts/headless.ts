/**
 * Headless full-day run of the simulation core in Node — proof that sim/ is
 * framework-agnostic, plus the calibration, acceptance & determinism harness:
 *
 *   pnpm headless                    one seeded day, summary table
 *   pnpm headless --seed 7           different world
 *   pnpm headless --n 3000           population override
 *   pnpm headless --check            run twice, compare state hashes
 *   pnpm headless --flatten          experiment #1: uniform schedules → peaks must vanish
 *   pnpm headless --close [H]        experiment #2: close arterial bridge at hour H (default 7.75)
 *   pnpm headless --boost F          experiment #3: population ×F (default 1.5)
 */
import { cloneConfig } from "../src/config";
import { createSimulation, type Simulation } from "../src/sim/sim";

interface Args {
  seed: number;
  n: number | undefined;
  check: boolean;
  flatten: boolean;
  closeAtH: number | null;
  boost: number | null;
  days: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seed: cloneConfig().seed,
    n: undefined,
    check: false,
    flatten: false,
    closeAtH: null,
    boost: null,
    days: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") args.seed = Number(argv[++i]);
    else if (a === "--n") args.n = Number(argv[++i]);
    else if (a === "--check") args.check = true;
    else if (a === "--flatten") args.flatten = true;
    else if (a === "--days") args.days = Math.max(1, Number(argv[++i]));
    else if (a === "--close") {
      const next = Number(argv[i + 1]);
      args.closeAtH = Number.isFinite(next) ? Number(argv[++i]) : 7.75;
    } else if (a === "--boost") {
      const next = Number(argv[i + 1]);
      args.boost = Number.isFinite(next) ? Number(argv[++i]) : 1.5;
    }
  }
  return args;
}

const fmtT = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

interface WindowStats {
  peakActive: number;
  peakActiveT: number;
  minSpeed: number;
  minSpeedT: number;
}

function windowStats(sim: Simulation, h0: number, h1: number, minActive: number): WindowStats {
  const m = sim.metrics;
  const w: WindowStats = {
    peakActive: 0,
    peakActiveT: 0,
    minSpeed: Number.POSITIVE_INFINITY,
    minSpeedT: 0,
  };
  for (let i = 0; i < m.timesS.length; i++) {
    const t = m.timesS[i];
    if (t < h0 * 3600 || t > h1 * 3600) continue;
    if (m.activeTrips[i] > w.peakActive) {
      w.peakActive = m.activeTrips[i];
      w.peakActiveT = t;
    }
    if (m.activeTrips[i] >= minActive && m.meanSpeedKmh[i] < w.minSpeed) {
      w.minSpeed = m.meanSpeedKmh[i];
      w.minSpeedT = t;
    }
  }
  return w;
}

function runDay(args: Args): Simulation {
  const n =
    args.boost !== null ? Math.round((args.n ?? cloneConfig().population.N) * args.boost) : args.n;
  const cfg = cloneConfig({ seed: args.seed, n, flatten: args.flatten });
  const sim = createSimulation(cfg);

  const probeAtS = 3 * 3600;
  let probesInjected = false;
  let closed = false;
  const stepsPerMinute = Math.round(60 / cfg.sim.dt);
  // Run K full days plus an hour of day K so the last midnight rollover lands.
  const maxMinutes = args.days * 1440 + 60;
  let stuckRising = 0;
  let gridlockWarned = false;

  for (let minute = 0; minute < maxMinutes; minute++) {
    if (!probesInjected && sim.t >= probeAtS) {
      probesInjected = true;
      // Night probes: deep-south homes → CBD center, measuring the
      // infrastructure baseline (signals included, congestion absent).
      const south = sim.net.nodes.filter((nd) => !nd.north && nd.row >= 6);
      const cbdMid = sim.net.nodes.find(
        (nd) =>
          nd.col === Math.floor((cfg.network.cbd.col0 + cfg.network.cbd.col1) / 2) &&
          nd.row === cfg.network.cbd.row1,
      );
      if (cbdMid !== undefined) {
        sim.injectTrip(south[0].id, cbdMid.id);
        sim.injectTrip(south[Math.floor(south.length / 2)].id, cbdMid.id);
        sim.injectTrip(south[south.length - 1].id, cbdMid.id);
      }
    }
    if (args.closeAtH !== null && !closed && sim.t >= args.closeAtH * 3600) {
      closed = true;
      sim.setArterialBridgeClosed(true);
      console.log(`>> arterial bridge CLOSED at ${fmtT(sim.t)}`);
    }
    sim.step(stepsPerMinute);
    const st = sim.metrics.stuck;
    if (st.length >= 2 && st[st.length - 1] > st[st.length - 2]) {
      stuckRising++;
      if (stuckRising >= 15 && !gridlockWarned) {
        gridlockWarned = true;
        console.warn(`!! GRIDLOCK WARNING at ${fmtT(sim.t)}: stuck count rising 15 min straight`);
      }
    } else {
      stuckRising = 0;
    }
  }
  return sim;
}

/** Phase 3 proof table: the morning peak migrates earlier and pain shrinks. */
function printDayTable(sim: Simulation, days: number): void {
  const m = sim.metrics;
  const popN = sim.cfg.population.N;
  console.log(
    "\n day | am peak (act @ time) | min km/h | mean depart | mean late | p90 delay | tram share",
  );
  for (let d = 0; d < days; d++) {
    const w = windowStats(sim, d * 24 + 5, d * 24 + 12, 30);
    const legs = m.trips.filter(
      (tr) =>
        tr.kind === "toWork" &&
        tr.agentId < popN &&
        tr.plannedDepartS >= d * 86400 &&
        tr.plannedDepartS < (d + 1) * 86400,
    );
    let departSum = 0;
    let lateSum = 0;
    let tram = 0;
    const delays: number[] = [];
    for (const tr of legs) {
      departSum += tr.plannedDepartS - d * 86400;
      const agent = sim.agents[tr.agentId];
      const late = (tr.arriveS % 86400) - agent.workStartS;
      lateSum += Math.max(0, late);
      delays.push(tr.arriveS - tr.plannedDepartS - tr.freeFlowS);
      if (tr.mode === "transit") tram++;
    }
    delays.sort((a, b) => a - b);
    const p90 = delays.length > 0 ? delays[Math.floor(delays.length * 0.9)] : 0;
    const n = Math.max(1, legs.length);
    console.log(
      `  ${String(d + 1).padStart(2)} | ${String(w.peakActive).padStart(6)} @ ${fmtT(
        w.peakActiveT % 86400,
      )}    |   ${w.minSpeed.toFixed(1).padStart(5)} |    ${fmtT(departSum / n)}    |  ${(
        lateSum /
        n /
        60
      )
        .toFixed(1)
        .padStart(5)} min | ${(p90 / 60).toFixed(1).padStart(6)} min |   ${((100 * tram) / n)
        .toFixed(1)
        .padStart(5)} %`,
    );
  }
}

function printTimeline(sim: Simulation): void {
  const m = sim.metrics;
  console.log("\n time   active  km/h   queue  brA/min brB/min  walk  atWork");
  for (let i = 0; i < m.timesS.length; i++) {
    const t = m.timesS[i];
    if (t % 1800 !== 0 || t < 5 * 3600 || t > 21.5 * 3600) continue;
    const spd = Number.isNaN(m.meanSpeedKmh[i]) ? "   —" : m.meanSpeedKmh[i].toFixed(1).padStart(4);
    console.log(
      ` ${fmtT(t)} ${String(m.activeTrips[i]).padStart(6)}  ${spd}  ${String(m.queued[i]).padStart(
        5,
      )}  ${m.bridgeAFlow[i].toFixed(0).padStart(6)} ${m.bridgeBFlow[i]
        .toFixed(0)
        .padStart(7)} ${String(m.walkers[i]).padStart(5)} ${String(m.atWork[i]).padStart(7)}`,
    );
  }
}

function summarize(sim: Simulation, args: Args): string {
  const m = sim.metrics;
  const am = windowStats(sim, 5, 12, 30);
  const pm = windowStats(sim, 14.5, 21, 30);
  const all = windowStats(sim, 0, 24, 0);

  let meanActive = 0;
  let nSamples = 0;
  for (let i = 0; i < m.timesS.length; i++) {
    if (m.timesS[i] >= 5 * 3600 && m.timesS[i] <= 21 * 3600) {
      meanActive += m.activeTrips[i];
      nSamples++;
    }
  }
  meanActive /= Math.max(1, nSamples);

  const popN = sim.cfg.population.N;
  const delays = m.trips
    .filter((tr) => tr.mode === "car" && tr.agentId < popN)
    .map((tr) => tr.arriveS - tr.plannedDepartS - tr.freeFlowS)
    .sort((a, b) => a - b);
  const p90 = delays.length > 0 ? delays[Math.floor(delays.length * 0.9)] : 0;

  const probeRatios = sim.agents
    .filter((a) => a.probe === true)
    .map((a) => {
      const trip = m.trips.find((tr) => tr.agentId === a.id);
      if (trip === undefined) return Number.NaN;
      return trip.freeFlowS / (trip.arriveS - trip.plannedDepartS);
    });

  let maxAtWork = 0;
  let maxWalkers = 0;
  let maxQueue = 0;
  for (let i = 0; i < m.timesS.length; i++) {
    if (m.atWork[i] > maxAtWork) maxAtWork = m.atWork[i];
    if (m.walkers[i] > maxWalkers) maxWalkers = m.walkers[i];
    if (m.queued[i] > maxQueue) maxQueue = m.queued[i];
  }

  const lines = [
    `am peak active        ${am.peakActive}  at ${fmtT(am.peakActiveT)}   (min speed ${am.minSpeed.toFixed(1)} km/h at ${fmtT(am.minSpeedT)})`,
    `pm peak active        ${pm.peakActive}  at ${fmtT(pm.peakActiveT)}   (min speed ${pm.minSpeed.toFixed(1)} km/h at ${fmtT(pm.minSpeedT)})`,
    `peak/mean ratio       ${(all.peakActive / Math.max(1, meanActive)).toFixed(2)}  (baseline ≈10; --flatten collapses the peaks)`,
    `max queue / at work   ${maxQueue} / ${maxAtWork}`,
    `walkers peak          ${maxWalkers}`,
    `completed legs        ${m.trips.length}`,
    `mean / p90 car delay  ${(m.meanDelayS() / 60).toFixed(1)} min / ${(p90 / 60).toFixed(1)} min`,
    `03:00 probe speed     ${probeRatios.map((x) => x.toFixed(2)).join(", ")} × free-flow`,
    `state hash            ${sim.hashState()}`,
  ];
  void args;
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const t0 = performance.now();
const sim1 = runDay(args);
const wall = ((performance.now() - t0) / 1000).toFixed(2);

const tags = [
  args.flatten ? "FLATTEN" : null,
  args.closeAtH !== null ? `CLOSE@${args.closeAtH}` : null,
  args.boost !== null ? `BOOST×${args.boost}` : null,
  args.days > 1 ? `${args.days} DAYS` : null,
]
  .filter(Boolean)
  .join(" ");
console.log(
  `\n=== SimS headless — seed ${args.seed}${args.n !== undefined ? `, N ${args.n}` : ""}${
    tags.length > 0 ? ` [${tags}]` : ""
  } ===`,
);
if (args.days === 1) {
  printTimeline(sim1);
  console.log(summarize(sim1, args));
} else {
  printDayTable(sim1, args.days);
  console.log(`state hash            ${sim1.hashState()}`);
}
console.log(`wall time             ${wall} s`);

if (args.check) {
  const sim2 = runDay(args);
  const ok = sim1.hashState() === sim2.hashState();
  console.log(
    `\ndeterminism check     run2 hash ${sim2.hashState()}  →  ${ok ? "MATCH" : "MISMATCH"}`,
  );
  if (!ok) process.exit(1);
}
