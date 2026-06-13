import { AudioEngine } from "./audio";
import { cloneConfig, config } from "./config";
import { TimeChart } from "./render/charts";
import { Scene3D } from "./render3d/scene";
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
const urlClose = params.get("close"); // ?close=7.75 → close the arterial bridge at 07:45

interface Scenario {
  seed: number;
  n: number;
  flatten: boolean;
}
const baseScenario: Scenario = {
  seed: urlSeed !== null ? Number(urlSeed) : config.seed,
  n: urlN !== null ? Number(urlN) : config.population.N,
  flatten: false,
};
let scenario: Scenario = { ...baseScenario };

let cfg = cloneConfig(scenario);
let sim: Simulation = createSimulation(cfg);
warpIfRequested(sim);

function warpIfRequested(s: Simulation): void {
  if (urlWarp === null || s.tick > 0) return;
  // Hours, possibly spanning days: ?warp=103.5 = day 5, 07:30 (learned city).
  const warpS = Math.max(0, Math.min(240, Number(urlWarp))) * 3600;
  s.step(Math.round(warpS / cfg.sim.dt));
}

const cityCanvas = document.getElementById("city") as HTMLCanvasElement;
const scene = new Scene3D(cityCanvas, sim);
const audio = new AudioEngine();
const MAX_AGENTS = 200000;

const palette = config.render;
const tripsChart = new TimeChart(
  document.getElementById("chartTrips") as HTMLCanvasElement,
  palette.chartLine,
  palette.chartGrid,
  palette.chartCursor,
);
const speedChart = new TimeChart(
  document.getElementById("chartSpeed") as HTMLCanvasElement,
  palette.chartLine2,
  palette.chartGrid,
  palette.chartCursor,
);
const queueChart = new TimeChart(
  document.getElementById("chartQueue") as HTMLCanvasElement,
  palette.chartLine3,
  palette.chartGrid,
  palette.chartCursor,
);

let playing = true;
let speedMult = cfg.sim.defaultSpeedMultiplier;
let traceId: number | null = null;
let acc = 0;

function restart(next: Scenario): void {
  scenario = next;
  cfg = cloneConfig(scenario);
  sim = createSimulation(cfg);
  scene.setSimulation(sim);
  traceId = null;
  acc = 0;
  ui.traceInfo.hidden = true;
  ui.setSeed(scenario.seed);
  ui.setAgents(scenario.n);
  ui.setFlattenLabel(scenario.flatten);
  ui.setClosedLabel(false);
  updateScenarioStatus();
}

function updateScenarioStatus(): void {
  const bits: string[] = [];
  if (scenario.flatten) bits.push("FLATTENED schedules (uniform)");
  if (sim.arterialBridgeClosed()) bits.push("arterial bridge CLOSED");
  if (scenario.n !== baseScenario.n) bits.push(`population ${scenario.n}`);
  ui.scenarioStatus.textContent = bits.length > 0 ? bits.join(" · ") : "baseline";
}

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
      restart({ ...scenario, seed, n: Math.max(1, Math.min(MAX_AGENTS, n)) });
    },
    onTrace(): void {
      const movers = sim.agents.filter(
        (a) => a.mode !== "wfh" && a.probe !== true && a.id < cfg.population.N,
      );
      if (movers.length === 0) return;
      traceId = movers[Math.floor(Math.random() * movers.length)].id;
      ui.traceInfo.hidden = false;
    },
    onToggleSound(): boolean {
      audio.resume(); // the click is the user gesture that unlocks audio
      return audio.toggleMute();
    },
    onTriggerFire(): void {
      // UI-side randomness (Math.random) — must not touch the sim's streams.
      const node = Math.floor(Math.random() * sim.net.nodes.length);
      sim.emergency.igniteAt(node, sim.t);
    },
    onFlatten(): boolean {
      restart({ ...scenario, flatten: !scenario.flatten });
      return scenario.flatten;
    },
    onCloseBridge(): boolean {
      sim.setArterialBridgeClosed(!sim.arterialBridgeClosed());
      updateScenarioStatus();
      return sim.arterialBridgeClosed();
    },
    onBoost(): void {
      restart({ ...scenario, n: Math.min(MAX_AGENTS, Math.round(scenario.n * 1.5)) });
    },
    onReset(): void {
      restart({ ...baseScenario });
    },
  },
  cfg.sim.maxSpeedMultiplier,
  speedMult,
);
ui.setSeed(scenario.seed);
ui.setAgents(scenario.n);
updateScenarioStatus();

window.addEventListener("resize", () => {
  scene.resize();
  tripsChart.resize();
  speedChart.resize();
  queueChart.resize();
});

// --- HUD ---
let fpsFrames = 0;
let fpsLastT = performance.now();

function updateHud(): void {
  const m = sim.metrics;
  const lastSpeed = m.meanSpeedKmh.length > 0 ? m.meanSpeedKmh[m.meanSpeedKmh.length - 1] : NaN;
  let atWork = 0;
  for (let i = 0; i < sim.scheduler.workersAt.length; i++) atWork += sim.scheduler.workersAt[i];
  ui.hudActive.textContent = String(sim.engine.activeCount);
  ui.hudSpeed.textContent = Number.isNaN(lastSpeed) ? "—" : `${lastSpeed.toFixed(1)} km/h`;
  ui.hudWalkers.textContent = String(sim.walk.count);
  ui.hudRiders.textContent = String(sim.transit.count);
  ui.hudAtWork.textContent = String(atWork);
  ui.hudArrived.textContent = String(m.trips.length);
  ui.hudWaiting.textContent = String(sim.engine.waitingCount);
  const popN = cfg.population.N;
  let moneySum = 0;
  for (let i = 0; i < popN && i < sim.agents.length; i++) moneySum += sim.agents[i].money;
  ui.hudMoney.textContent = popN > 0 ? `$${Math.round(moneySum / popN).toLocaleString()}` : "—";
  ui.hudFires.textContent = String(sim.emergency.activeCount);
  ui.clock.innerHTML = `<span class="day">Day ${sim.day + 1}</span>${fmtClock(sim.t)}`;

  if (traceId !== null) {
    const a = sim.agents[traceId];
    const slot = sim.engine.slotOfAgent[traceId] ?? -1;
    const dayBase = sim.day * 86400;
    const legs = sim.metrics.trips.filter(
      (tr) => tr.agentId === traceId && tr.plannedDepartS >= dayBase,
    );
    const last = legs.length > 0 ? legs[legs.length - 1] : undefined;
    const transitStatus = sim.transit.statusOf(traceId, sim.t);
    let status: string;
    if (slot >= 0) {
      status = `driving — ${((sim.engine.vel[slot] ?? 0) * 3.6).toFixed(0)} km/h (${legKind(legs.length)})`;
    } else if (transitStatus !== null) {
      const phaseNames = [
        "walking to the stop",
        "waiting on the platform",
        "riding the tram",
        "walking from the stop",
      ];
      status = `${phaseNames[transitStatus.phase]} (${legKind(legs.length)})`;
    } else if (isWalking(traceId)) {
      status = `walking (${legKind(legs.length)})`;
    } else if (last !== undefined && last.kind === "toHome") {
      status = `home since ${fmtClock(last.arriveS)}`;
    } else if (last !== undefined) {
      const delayMin = (last.arriveS - last.plannedDepartS - last.freeFlowS) / 60;
      status = `${last.kind === "toWork" ? "at work" : "out"} since ${fmtClock(last.arriveS)} (leg delay ${delayMin.toFixed(1)} min)`;
    } else if (sim.t < a.departS) {
      status = "at home, not departed yet";
    } else {
      status = "leaving any moment";
    }
    const expected = a.mode === "transit" ? a.expectedTransitS : a.expectedS;
    const hn = sim.net.nodes[a.home];
    const activity =
      a.errand !== null
        ? `errand → ${a.errand.kind}`
        : a.outing !== null
          ? `outing → ${a.outing.kind}`
          : "no extra trips";
    ui.traceInfo.innerHTML =
      `<b>agent #${a.id}</b> (${a.mode}) — at work by <b>${fmtClock(a.workStartS)}</b>, ` +
      `~${(a.workDurS / 3600).toFixed(1)} h day<br>` +
      `home col ${hn.col}, row ${hn.row} · balance <b>$${Math.round(a.money).toLocaleString()}</b> · ${activity}<br>` +
      `plans to leave ${fmtClock(a.departS)} (expects ${(expected / 60).toFixed(1)} min ` +
      `+ ${(a.bufferS / 60).toFixed(0)} min buffer)<br>status: ${status}`;
  }
}

function legKind(completedLegs: number): string {
  const seq = ["to work", "errand", "back to work", "home"];
  return seq[Math.min(completedLegs, seq.length - 1)];
}

function isWalking(agentId: number): boolean {
  let walking = false;
  sim.walk.forEach((id) => {
    if (id === agentId) walking = true;
  });
  return walking;
}

// --- main loop ---
let lastT = performance.now();

function frame(now: number): void {
  const realDt = Math.min(0.25, (now - lastT) / 1000);
  lastT = now;

  if (urlClose !== null && !sim.arterialBridgeClosed() && sim.t >= Number(urlClose) * 3600) {
    sim.setArterialBridgeClosed(true);
    ui.setClosedLabel(true);
    updateScenarioStatus();
  }

  if (playing) {
    // Multi-day: the city never "finishes" — midnight rollovers keep it alive.
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

  scene.render(sim, traceId, realDt);
  tripsChart.draw(sim.metrics.timesS, sim.metrics.activeTrips, sim.t);
  speedChart.draw(sim.metrics.timesS, sim.metrics.meanSpeedKmh, sim.t);
  queueChart.draw(sim.metrics.timesS, sim.metrics.queued, sim.t);
  updateHud();

  const q = sim.metrics.queued;
  audio.update(
    sim.engine.activeCount / 500,
    (q.length > 0 ? q[q.length - 1] : 0) / 200,
    scene.lastDay01,
    sim.emergency.activeCount > 0 || sim.emergency.vehicles.length > 0,
  );

  fpsFrames++;
  if (now - fpsLastT >= 500) {
    ui.hudFps.textContent = String(Math.round((fpsFrames * 1000) / (now - fpsLastT)));
    fpsFrames = 0;
    fpsLastT = now;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
