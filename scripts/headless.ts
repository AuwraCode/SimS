/**
 * Headless full-day run of the simulation core in Node — proof that sim/ is
 * framework-agnostic, plus the calibration & determinism harness:
 *
 *   pnpm headless                 one seeded day, summary table
 *   pnpm headless --seed 7        different world
 *   pnpm headless --n 3000        population override
 *   pnpm headless --check         run twice, compare state hashes (determinism)
 */
import { cloneConfig } from "../src/config";
import { createSimulation, type Simulation } from "../src/sim/sim";

interface Args {
  seed: number;
  n: number | undefined;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seed: cloneConfig().seed, n: undefined, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") args.seed = Number(argv[++i]);
    else if (argv[i] === "--n") args.n = Number(argv[++i]);
    else if (argv[i] === "--check") args.check = true;
  }
  return args;
}

const fmtT = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

interface DayResult {
  hash: string;
  wallMs: number;
  peakActive: number;
  peakActiveT: number;
  minSpeed: number;
  minSpeedT: number;
  offPeakSpeed: number;
  maxBridgeFlow: number;
  maxStuck: number;
  arrivals: number;
  meanDelayS: number;
  p90DelayS: number;
  probeRatios: number[];
  gridlockWarn: boolean;
}

function runDay(seed: number, n: number | undefined): { res: DayResult; sim: Simulation } {
  const cfg = cloneConfig({ seed, n });
  const sim: Simulation = createSimulation(cfg);
  const t0 = performance.now();

  const probeAtS = 3 * 3600;
  let probesInjected = false;
  const probeIds: number[] = [];

  const minutesPerDay = cfg.sim.dayEndS / 60;
  const stepsPerMinute = Math.round(60 / cfg.sim.dt);
  let gridlockWarn = false;
  let stuckRising = 0;

  for (let minute = 0; minute < minutesPerDay; minute++) {
    if (!probesInjected && sim.t >= probeAtS) {
      probesInjected = true;
      // Three night probes: deep-south homes → CBD center. The population has
      // essentially nobody on the road at 03:00, so these measure the
      // infrastructure baseline (signals included, congestion absent).
      const south = sim.net.nodes.filter((nd) => !nd.north && nd.row >= 6);
      const cbdMid = sim.net.nodes.find(
        (nd) =>
          nd.col === Math.floor((cfg.network.cbd.col0 + cfg.network.cbd.col1) / 2) &&
          nd.row === cfg.network.cbd.row1,
      );
      if (cbdMid !== undefined) {
        for (const home of [
          south[0],
          south[Math.floor(south.length / 2)],
          south[south.length - 1],
        ]) {
          probeIds.push(sim.injectTrip(home.id, cbdMid.id));
        }
      }
    }
    sim.step(stepsPerMinute);
    // Gridlock telemetry: stuck-vehicle count rising for 15 straight minutes.
    const st = sim.metrics.stuck;
    if (st.length >= 2 && (st[st.length - 1] ?? 0) > (st[st.length - 2] ?? 0)) {
      stuckRising++;
      if (stuckRising >= 15 && !gridlockWarn) {
        gridlockWarn = true;
        console.warn(`!! GRIDLOCK WARNING at ${fmtT(sim.t)}: stuck count rising 15 min straight`);
      }
    } else {
      stuckRising = 0;
    }
    if (sim.isDone()) break;
  }

  const wallMs = performance.now() - t0;
  const m = sim.metrics;

  let peakActive = 0;
  let peakActiveT = 0;
  let minSpeed = Number.POSITIVE_INFINITY;
  let minSpeedT = 0;
  let maxBridgeFlow = 0;
  let maxStuck = 0;
  const offPeakSpeeds: number[] = [];
  for (let i = 0; i < m.timesS.length; i++) {
    const t = m.timesS[i];
    const act = m.activeTrips[i];
    const spd = m.meanSpeedKmh[i];
    if (act > peakActive) {
      peakActive = act;
      peakActiveT = t;
    }
    // Morning window, with enough vehicles for the mean to be meaningful.
    if (t >= 5 * 3600 && t <= 12 * 3600 && act >= 30 && spd < minSpeed) {
      minSpeed = spd;
      minSpeedT = t;
    }
    // Late off-peak reference: after the peak has drained, before the road empties.
    if (t >= 9.75 * 3600 && t <= 13 * 3600 && act >= 3 && !Number.isNaN(spd)) {
      offPeakSpeeds.push(spd);
    }
    if (m.bridgeFlowPerMin[i] > maxBridgeFlow) maxBridgeFlow = m.bridgeFlowPerMin[i];
    if (m.stuck[i] > maxStuck) maxStuck = m.stuck[i];
  }
  const offPeakSpeed =
    offPeakSpeeds.length > 0
      ? offPeakSpeeds.reduce((a, b) => a + b, 0) / offPeakSpeeds.length
      : Number.NaN;

  const delays = m.trips
    .filter((tr) => tr.agentId < (sim.cfg.population.N as number))
    .map((tr) => tr.arriveS - tr.plannedDepartS - tr.freeFlowS)
    .sort((a, b) => a - b);
  const p90DelayS = delays.length > 0 ? delays[Math.floor(delays.length * 0.9)] : 0;

  const probeRatios = probeIds.map((id) => {
    const trip = m.trips.find((tr) => tr.agentId === id);
    if (trip === undefined) return Number.NaN;
    return trip.freeFlowS / (trip.arriveS - trip.plannedDepartS);
  });

  const res: DayResult = {
    hash: sim.hashState(),
    wallMs,
    peakActive,
    peakActiveT,
    minSpeed,
    minSpeedT,
    offPeakSpeed,
    maxBridgeFlow,
    maxStuck,
    arrivals: m.trips.length,
    meanDelayS: m.meanDelayS(),
    p90DelayS,
    probeRatios,
    gridlockWarn,
  };
  return { res, sim };
}

function printTimeline(sim: Simulation): void {
  const m = sim.metrics;
  console.log("\n time   active  speed km/h  bridge/min  stuck  waiting");
  for (let i = 0; i < m.timesS.length; i++) {
    const t = m.timesS[i];
    if (t % 1800 !== 0) continue;
    if (t < 5 * 3600 || t > 13 * 3600) continue;
    const spd = Number.isNaN(m.meanSpeedKmh[i])
      ? "    —"
      : m.meanSpeedKmh[i].toFixed(1).padStart(5);
    console.log(
      ` ${fmtT(t)}  ${String(m.activeTrips[i]).padStart(5)}  ${spd}       ${m.bridgeFlowPerMin[i]
        .toFixed(0)
        .padStart(
          5,
        )}      ${String(m.stuck[i]).padStart(4)}  ${String(m.waitingDepart[i]).padStart(5)}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const { res: r1, sim: sim1 } = runDay(args.seed, args.n);

console.log(
  `\n=== SimS headless day — seed ${args.seed}${args.n !== undefined ? `, N ${args.n}` : ""} ===`,
);
printTimeline(sim1);
console.log(`peak active trips     ${r1.peakActive}  at ${fmtT(r1.peakActiveT)}`);
console.log(`min mean speed (am)   ${r1.minSpeed.toFixed(1)} km/h  at ${fmtT(r1.minSpeedT)}`);
console.log(`off-peak mean speed   ${r1.offPeakSpeed.toFixed(1)} km/h  (09:45–13:00 reference)`);
console.log(`peak bridge flow      ${r1.maxBridgeFlow.toFixed(1)} veh/min (all bridge transfers)`);
console.log(
  `max stuck >5 min      ${r1.maxStuck}${r1.gridlockWarn ? "  !! gridlock warning fired" : ""}`,
);
console.log(`completed trips       ${r1.arrivals}`);
console.log(
  `mean / p90 delay      ${(r1.meanDelayS / 60).toFixed(1)} min / ${(r1.p90DelayS / 60).toFixed(1)} min`,
);
console.log(
  `03:00 probe speed     ${r1.probeRatios.map((x) => x.toFixed(2)).join(", ")} × free-flow`,
);
console.log(`state hash            ${r1.hash}`);
console.log(`wall time             ${(r1.wallMs / 1000).toFixed(2)} s`);

if (args.check) {
  const { res: r2 } = runDay(args.seed, args.n);
  const ok = r1.hash === r2.hash;
  console.log(`\ndeterminism check     run2 hash ${r2.hash}  →  ${ok ? "MATCH" : "MISMATCH"}`);
  if (!ok) process.exit(1);
}
