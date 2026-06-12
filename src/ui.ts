/** DOM lookups and control wiring — everything impure lives out here. */

export interface UiHandlers {
  onPlayPause(): boolean; // returns new "playing" state
  onSpeedChange(multiplier: number): void;
  onRestart(seed: number, n: number): void;
  onTrace(): void;
}

export interface Ui {
  clock: HTMLElement;
  hudActive: HTMLElement;
  hudSpeed: HTMLElement;
  hudArrived: HTMLElement;
  hudWaiting: HTMLElement;
  hudFps: HTMLElement;
  traceInfo: HTMLElement;
  setSeed(seed: number): void;
  setAgents(n: number): void;
  speedMultiplier(): number;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

/** Slider 0–100 → log scale 1×–600×. */
function sliderToMult(v: number, maxMult: number): number {
  return Math.round(maxMult ** (v / 100));
}
function multToSlider(m: number, maxMult: number): number {
  return Math.round((100 * Math.log(m)) / Math.log(maxMult));
}

export function setupUi(handlers: UiHandlers, maxMult: number, initialMult: number): Ui {
  const playPause = el<HTMLButtonElement>("playPause");
  const speed = el<HTMLInputElement>("speed");
  const speedValue = el<HTMLElement>("speedValue");
  const seed = el<HTMLInputElement>("seed");
  const agents = el<HTMLInputElement>("agents");
  const restart = el<HTMLButtonElement>("restart");
  const trace = el<HTMLButtonElement>("trace");

  speed.value = String(multToSlider(initialMult, maxMult));
  speedValue.textContent = `${initialMult}×`;

  playPause.addEventListener("click", () => {
    playPause.textContent = handlers.onPlayPause() ? "Pause" : "Play";
  });
  speed.addEventListener("input", () => {
    const m = sliderToMult(Number(speed.value), maxMult);
    speedValue.textContent = `${m}×`;
    handlers.onSpeedChange(m);
  });
  restart.addEventListener("click", () => {
    handlers.onRestart(Number(seed.value) || 0, Number(agents.value) || 1);
  });
  trace.addEventListener("click", () => {
    handlers.onTrace();
  });

  return {
    clock: el("clock"),
    hudActive: el("hudActive"),
    hudSpeed: el("hudSpeed"),
    hudArrived: el("hudArrived"),
    hudWaiting: el("hudWaiting"),
    hudFps: el("hudFps"),
    traceInfo: el("traceInfo"),
    setSeed(s: number): void {
      seed.value = String(s);
    },
    setAgents(n: number): void {
      agents.value = String(n);
    },
    speedMultiplier(): number {
      return sliderToMult(Number(speed.value), maxMult);
    },
  };
}

export function fmtClock(s: number): string {
  const clamped = Math.max(0, s) % 86400;
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
