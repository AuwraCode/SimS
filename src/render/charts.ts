/**
 * Dependency-free line charts over a fixed 00:00–24:00 x-axis. These are
 * where the emergent peaks become visible: active trips swell when many
 * plans overlap, mean speed collapses when the network saturates.
 */
export class TimeChart {
  readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly lineColor: string,
    private readonly gridColor: string,
    private readonly cursorColor: string,
    private readonly dayEndS: number,
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

    let maxV = 1;
    for (const v of values) if (!Number.isNaN(v) && v > maxV) maxV = v;
    maxV *= 1.08;

    const xOf = (t: number): number => padL + (t / this.dayEndS) * (w - padL - 4 * dpr);
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

    // The series (NaN samples break the line — an empty network has no mean speed).
    ctx.strokeStyle = this.lineColor;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < timesS.length; i++) {
      const v = values[i];
      if (Number.isNaN(v)) {
        pen = false;
        continue;
      }
      const x = xOf(timesS[i]);
      const y = yOf(v);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();

    // Now-cursor.
    ctx.strokeStyle = this.cursorColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(xOf(currentT), padT);
    ctx.lineTo(xOf(currentT), h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
