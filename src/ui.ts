/** DOM lookups and control wiring — everything impure lives out here. */

export interface UiHandlers {
  onPlayPause(): boolean; // returns new "playing" state
  onSpeedChange(multiplier: number): void;
  onRestart(seed: number, n: number): void;
  onTrace(): void;
  /** Toggles; each returns the new state for button labeling. */
  onFlatten(): boolean;
  onCloseBridge(): boolean;
  onBoost(): void;
  onReset(): void;
}

export interface Ui {
  clock: HTMLElement;
  hudActive: HTMLElement;
  hudSpeed: HTMLElement;
  hudWalkers: HTMLElement;
  hudRiders: HTMLElement;
  hudAtWork: HTMLElement;
  hudArrived: HTMLElement;
  hudWaiting: HTMLElement;
  hudFps: HTMLElement;
  traceInfo: HTMLElement;
  scenarioStatus: HTMLElement;
  setSeed(seed: number): void;
  setAgents(n: number): void;
  setFlattenLabel(on: boolean): void;
  setClosedLabel(closed: boolean): void;
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
  const flattenBtn = el<HTMLButtonElement>("expFlatten");
  const closeBtn = el<HTMLButtonElement>("expClose");

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
  el<HTMLButtonElement>("restart").addEventListener("click", () => {
    handlers.onRestart(Number(seed.value) || 0, Number(agents.value) || 1);
  });
  el<HTMLButtonElement>("trace").addEventListener("click", () => {
    handlers.onTrace();
  });
  flattenBtn.addEventListener("click", () => {
    ui.setFlattenLabel(handlers.onFlatten());
  });
  closeBtn.addEventListener("click", () => {
    ui.setClosedLabel(handlers.onCloseBridge());
  });
  el<HTMLButtonElement>("expBoost").addEventListener("click", () => {
    handlers.onBoost();
  });
  el<HTMLButtonElement>("expReset").addEventListener("click", () => {
    handlers.onReset();
  });

  const ui: Ui = {
    clock: el("clock"),
    hudActive: el("hudActive"),
    hudSpeed: el("hudSpeed"),
    hudWalkers: el("hudWalkers"),
    hudRiders: el("hudRiders"),
    hudAtWork: el("hudAtWork"),
    hudArrived: el("hudArrived"),
    hudWaiting: el("hudWaiting"),
    hudFps: el("hudFps"),
    traceInfo: el("traceInfo"),
    scenarioStatus: el("scenarioStatus"),
    setSeed(s: number): void {
      seed.value = String(s);
    },
    setAgents(n: number): void {
      agents.value = String(n);
    },
    setFlattenLabel(on: boolean): void {
      flattenBtn.textContent = on ? "Restore schedules" : "Flatten schedules";
    },
    setClosedLabel(closed: boolean): void {
      closeBtn.textContent = closed ? "Reopen bridge" : "Close bridge";
    },
  };
  return ui;
}

export function fmtClock(s: number): string {
  const clamped = Math.max(0, s) % 86400;
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
