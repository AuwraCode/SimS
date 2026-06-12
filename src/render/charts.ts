/**
 * Dependency-free line charts over a fixed 00:00–24:00 x-axis. Times are
 * ABSOLUTE sim seconds: each simulated day is folded onto the same axis,
 * with previous days drawn as faded "ghosts" under today's bright line —
 * which is exactly where Phase 3's day-to-day peak spreading becomes
 * visible (the morning hump migrates earlier and flattens, day after day).
 */
const DAY_S = 86400;
const MAX_GHOST_DAYS = 7;

export class TimeChart {
  readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly lineColor: string,
    private readonly gridColor: string,
    private readonly cursorColor: string,
    private readonly ghostColor = "rgba(139,147,163,0.35)",
  ) {
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("no 2d context");
    this.ctx = ctx;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
  }

  draw(timesS: number[], values: number[], currentT: number): void {
    const { ctx, canvas } = this;
    if (canvas.width === 0) this.resize();
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const padL = 30 * dpr;
    const padB = 14 * dpr;
    const padT = 6 * dpr;
    ctx.clearRect(0, 0, w, h);

    const curDay = Math.floor(currentT / DAY_S);
    const firstDay = Math.max(0, curDay - MAX_GHOST_DAYS);

    let maxV = 1;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isNaN(v) && v > maxV && timesS[i] >= firstDay * DAY_S) maxV = v;
    }
    maxV *= 1.08;

    const xOf = (tod: number): number => padL + (tod / DAY_S) * (w - padL - 4 * dpr);
    const yOf = (v: number): number => padT + (1 - v / maxV) * (h - padT - padB);

    // Grid: every 6 h plus labels.
    ctx.strokeStyle = this.gridColor;
    ctx.fillStyle = this.gridColor;
    ctx.lineWidth = 1;
    ctx.font = `${10 * dpr}px system-ui`;
    ctx.textAlign = "center";
    for (let hr = 0; hr <= 24; hr += 6) {
      const x = xOf(hr * 3600);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, h - padB);
      ctx.stroke();
      ctx.fillText(`${hr}h`, x, h - 3 * dpr);
    }
    ctx.textAlign = "right";
    ctx.fillText(
      maxV >= 10 ? `${Math.round(maxV)}` : maxV.toFixed(1),
      padL - 3 * dpr,
      padT + 8 * dpr,
    );

    // One pass per visible day: ghosts first, today last and bright.
    for (let day = firstDay; day <= curDay; day++) {
      const today = day === curDay;
      ctx.strokeStyle = today ? this.lineColor : this.ghostColor;
      ctx.lineWidth = (today ? 1.5 : 1) * dpr;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < timesS.length; i++) {
        if (Math.floor(timesS[i] / DAY_S) !== day && !(today && timesS[i] === currentT)) {
          if (timesS[i] >= (day + 1) * DAY_S) break;
          continue;
        }
        const v = values[i];
        if (Number.isNaN(v)) {
          pen = false;
          continue;
        }
        const x = xOf(timesS[i] - day * DAY_S);
        const y = yOf(v);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
    }

    // Now-cursor at today's time of day.
    ctx.strokeStyle = this.cursorColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(xOf(currentT - curDay * DAY_S), padT);
    ctx.lineTo(xOf(currentT - curDay * DAY_S), h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
