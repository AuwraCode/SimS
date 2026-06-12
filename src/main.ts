import { cloneConfig, config } from "./config";
import { TimeChart } from "./render/charts";
import { CityRenderer } from "./render/city";
import { createSimulation, type Simulation } from "./sim/sim";
import { fmtClock, setupUi } from "./ui";

/**
 * Browser bootstrap: a fixed-dt simulation driven by a requestAnimationFrame
 * accumulator. Render rate and simulation rate are fully decoupled — the
 * slider changes how many sim-seconds elapse per real second, never the
 * physics step. UI-side randomness (picking an agent to trace) deliberately
 * uses Math.random: it must not touch the deterministic sim streams.
 */

const params = new URLSearchParams(window.location.search);
const urlSeed = params.get("seed");
const urlN = params.get("n");
const urlWarp = params.get("warp"); // ?warp=7.5 → fast-forward to 07:30 on load

let cfg = cloneConfig({
  seed: urlSeed !== null ? Number(urlSeed) : undefined,
  n: urlN !== null ? Number(urlN) : undefined,
});
let sim: Simulation = createSimulation(cfg);
if (urlWarp !== null) {
  const warpS = Math.max(0, Math.min(24, Number(urlWarp))) * 3600;
  sim.step(Math.round(warpS / cfg.sim.dt));
}

const cityCanvas = document.getElementById("city") as HTMLCanvasElement;
let renderer = new CityRenderer(cityCanvas, sim.net, cfg);

const colors = config.render;
const tripsChart = new TimeChart(
  document.getElementById("chartTrips") as HTMLCanvasElement,
  colors.chartLine,
  colors.chartGrid,
  colors.chartCursor,
  cfg.sim.dayEndS,
);
const speedChart = new TimeChart(
  document.getElementById("chartSpeed") as HTMLCanvasElement,
  "#ffc44f",
  colors.chartGrid,
  colors.chartCursor,
  cfg.sim.dayEndS,
);

let playing = true;
let speedMult = cfg.sim.defaultSpeedMultiplier;
let traceId: number | null = null;
let acc = 0;

const ui = setupUi(
  {
    onPlayPause(): boolean {
      playing = !playing;
      return playing;
    },
    onSpeedChange(m: number): void {
      speedMult = m;
    },
    onRestart(seed: number, n: number): void {
      cfg = cloneConfig({ seed, n: Math.max(1, Math.min(50000, n)) });
      sim = createSimulation(cfg);
      renderer = new CityRenderer(cityCanvas, sim.net, cfg);
      traceId = null;
      acc = 0;
      ui.traceInfo.hidden = true;
    },
    onTrace(): void {
      const drivers = sim.agents.filter((a) => a.mode === "car" && a.id < cfg.population.N);
      if (drivers.length === 0) return;
      traceId = drivers[Math.floor(Math.random() * drivers.length)].id;
      ui.traceInfo.hidden = false;
    },
  },
  cfg.sim.maxSpeedMultiplier,
  speedMult,
);
ui.setSeed(cfg.seed);
ui.setAgents(cfg.population.N);

window.addEventListener("resize", () => {
  renderer.resize();
  tripsChart.resize();
  speedChart.resize();
});

// --- HUD helpers ---
let fpsFrames = 0;
let fpsLastT = performance.now();

function updateHud(): void {
  const m = sim.metrics;
  const lastSpeed = m.meanSpeedKmh.length > 0 ? m.meanSpeedKmh[m.meanSpeedKmh.length - 1] : NaN;
  ui.hudActive.textContent = String(sim.engine.activeCount);
  ui.hudSpeed.textContent = Number.isNaN(lastSpeed) ? "—" : `${lastSpeed.toFixed(1)} km/h`;
  ui.hudArrived.textContent = String(sim.engine.arrivedCount);
  ui.hudWaiting.textContent = String(sim.engine.waitingCount);
  ui.clock.textContent = fmtClock(sim.t);

  if (traceId !== null) {
    const a = sim.agents[traceId];
    const slot = sim.engine.slotOfAgent[traceId] ?? -1;
    const trip = sim.metrics.trips.find((tr) => tr.agentId === traceId);
    let status: string;
    if (trip !== undefined) {
      const delayMin = (trip.arriveS - trip.plannedDepartS - trip.freeFlowS) / 60;
      status = `arrived ${fmtClock(trip.arriveS)} (delay ${delayMin.toFixed(1)} min)`;
    } else if (slot >= 0) {
      status = `en route — ${((sim.engine.vel[slot] ?? 0) * 3.6).toFixed(0)} km/h`;
    } else if (sim.t < a.departS) {
      status = "at home";
    } else {
      status = "waiting to pull out / en route soon";
    }
    ui.traceInfo.innerHTML =
      `<b>agent #${a.id}</b> — wants to be at work <b>${fmtClock(a.workStartS)}</b><br>` +
      `plans to leave ${fmtClock(a.departS)} (free-flow ${(a.freeFlowS / 60).toFixed(1)} min ` +
      `+ ${(a.bufferS / 60).toFixed(0)} min buffer)<br>status: ${status}`;
  }
}

// --- main loop ---
let lastT = performance.now();

function frame(now: number): void {
  const realDt = Math.min(0.25, (now - lastT) / 1000);
  lastT = now;

  if (playing && !sim.isDone()) {
    acc += realDt * speedMult;
    let steps = Math.floor(acc / cfg.sim.dt);
    if (steps > cfg.sim.maxStepsPerFrame) {
      steps = cfg.sim.maxStepsPerFrame;
      acc = 0; // shed backlog: slow tabs lose sim speed, never correctness
    } else {
      acc -= steps * cfg.sim.dt;
    }
    if (steps > 0) sim.step(steps);
  }

  renderer.draw(sim, traceId);
  tripsChart.draw(sim.metrics.timesS, sim.metrics.activeTrips, sim.t);
  speedChart.draw(sim.metrics.timesS, sim.metrics.meanSpeedKmh, sim.t);
  updateHud();

  fpsFrames++;
  if (now - fpsLastT >= 500) {
    ui.hudFps.textContent = String(Math.round((fpsFrames * 1000) / (now - fpsLastT)));
    fpsFrames = 0;
    fpsLastT = now;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
