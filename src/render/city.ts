import type { SimsConfig } from "../config";
import { networkBounds, riverBand } from "../sim/network";
import type { Simulation } from "../sim/sim";
import { isApproachGreen } from "../sim/traffic/junction";
import type { Network } from "../sim/types";
import { makeSpeedRamp, rampColor } from "./colors";

/** Transitional 2D style constants (this renderer is being replaced by render3d). */
const STYLE = {
  paddingPx: 24,
  laneOffsetPx: 3,
  signalDotPx: 2.4,
  vehiclePx: 3.2,
  roadWidthPx: { arterial: 5, local: 2.5 } as Record<string, number>,
  colors: {
    road: "#3a4150",
    roadArterial: "#4a5366",
    river: "#1d3a55",
    cbdTint: "rgba(79,163,255,0.07)",
    hubTint: "rgba(255,196,79,0.08)",
    signalGreen: "#3dd68c",
    signalRed: "#ff5d5d",
    traceRoute: "#4fa3ff",
  },
};

/**
 * Top-down canvas view: a prerendered static layer (river, zones, roads) and
 * a dynamic pass per frame (signal states, every vehicle colored by speed,
 * optional traced agent). Directed edges are offset to the right of their
 * travel direction so the two directions of a street read separately —
 * morning inbound jams appear on one side, the outbound side stays green.
 */
export class CityRenderer {
  readonly ctx: CanvasRenderingContext2D;
  private staticLayer: HTMLCanvasElement;
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private readonly ramp = makeSpeedRamp();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private net: Network,
    private readonly cfg: SimsConfig,
  ) {
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("no 2d context");
    this.ctx = ctx;
    this.staticLayer = document.createElement("canvas");
    this.resize();
  }

  setNetwork(net: Network): void {
    this.net = net;
    this.renderStatic();
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.staticLayer.width = this.canvas.width;
    this.staticLayer.height = this.canvas.height;
    const b = networkBounds(this.net);
    const pad = STYLE.paddingPx * dpr;
    this.scale = Math.min(
      (this.canvas.width - 2 * pad) / (b.x1 - b.x0),
      (this.canvas.height - 2 * pad) / (b.y1 - b.y0),
    );
    this.offX = (this.canvas.width - (b.x1 - b.x0) * this.scale) / 2 - b.x0 * this.scale;
    this.offY = (this.canvas.height - (b.y1 - b.y0) * this.scale) / 2 - b.y0 * this.scale;
    this.renderStatic();
  }

  private sx(x: number): number {
    return x * this.scale + this.offX;
  }
  private sy(y: number): number {
    return y * this.scale + this.offY;
  }

  private renderStatic(): void {
    const ctx = this.staticLayer.getContext("2d");
    if (ctx === null) return;
    const { colors } = STYLE;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, this.staticLayer.width, this.staticLayer.height);

    // Zone tints: CBD block and hub halos.
    const ncfg = this.cfg.network;
    const sp = ncfg.spacingM;
    ctx.fillStyle = colors.cbdTint;
    ctx.fillRect(
      this.sx((ncfg.cbd.col0 - 0.45) * sp),
      this.sy((ncfg.cbd.row0 - 0.45) * sp),
      (ncfg.cbd.col1 - ncfg.cbd.col0 + 0.9) * sp * this.scale,
      (ncfg.cbd.row1 - ncfg.cbd.row0 + 0.9) * sp * this.scale,
    );
    ctx.fillStyle = colors.hubTint;
    for (const hub of ncfg.hubs) {
      ctx.beginPath();
      ctx.arc(this.sx(hub.col * sp), this.sy(hub.row * sp), 0.6 * sp * this.scale, 0, Math.PI * 2);
      ctx.fill();
    }

    // The river.
    const band = riverBand(this.net, ncfg);
    ctx.fillStyle = colors.river;
    ctx.fillRect(0, this.sy(band.y0), this.staticLayer.width, (band.y1 - band.y0) * this.scale);

    // Roads: one stroke per directed edge, offset right of travel.
    for (const e of this.net.edges) {
      const a = this.net.nodes[e.from];
      const b = this.net.nodes[e.to];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const off = this.edgeScreenOffset(e.id);
      const ox = ((-dy / len) * off) / this.scale;
      const oy = ((dx / len) * off) / this.scale;
      ctx.strokeStyle = e.klass === "arterial" ? colors.roadArterial : colors.road;
      ctx.lineWidth = STYLE.roadWidthPx[e.klass] * dpr * (e.isBridge ? 0.8 : 1);
      ctx.beginPath();
      ctx.moveTo(this.sx(a.x + ox), this.sy(a.y + oy));
      ctx.lineTo(this.sx(b.x + ox), this.sy(b.y + oy));
      ctx.stroke();
    }
  }

  /** Screen-space perpendicular offset (px) separating the two directions. */
  private edgeScreenOffset(_edgeId: number): number {
    const dpr = window.devicePixelRatio || 1;
    return STYLE.laneOffsetPx * dpr;
  }

  draw(sim: Simulation, traceAgentId: number | null): void {
    const { ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#14161a";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticLayer, 0, 0);

    // Signal states: a small two-arm marker per signalized junction.
    const { colors, signalDotPx } = STYLE;
    const s = signalDotPx * dpr;
    for (const node of this.net.nodes) {
      if (node.signal === null) continue;
      const x = this.sx(node.x);
      const y = this.sy(node.y);
      ctx.fillStyle = isApproachGreen(node.signal, 0, sim.t)
        ? colors.signalGreen
        : colors.signalRed;
      ctx.fillRect(x - s / 3, y - s * 1.6, (s / 1.5) | 0 || 1, s * 3.2);
      ctx.fillStyle = isApproachGreen(node.signal, 1, sim.t)
        ? colors.signalGreen
        : colors.signalRed;
      ctx.fillRect(x - s * 1.6, y - s / 3, s * 3.2, (s / 1.5) | 0 || 1);
    }

    // Traced agent's route under the vehicles.
    if (traceAgentId !== null) {
      const agent = sim.agents[traceAgentId];
      if (agent?.route) {
        ctx.strokeStyle = colors.traceRoute;
        ctx.lineWidth = 2.5 * dpr;
        ctx.globalAlpha = 0.65;
        ctx.beginPath();
        const first = sim.net.edges[agent.route[0]];
        ctx.moveTo(this.sx(this.net.nodes[first.from].x), this.sy(this.net.nodes[first.from].y));
        for (const eid of agent.route) {
          const e = sim.net.edges[eid];
          ctx.lineTo(this.sx(this.net.nodes[e.to].x), this.sy(this.net.nodes[e.to].y));
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Every vehicle, colored by v relative to its edge's speed limit.
    const v = STYLE.vehiclePx * dpr;
    const engine = sim.engine;
    engine.forEachActive((slot, edge) => {
      const a = this.net.nodes[edge.from];
      const b = this.net.nodes[edge.to];
      const f = engine.pos[slot] / edge.lengthM;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const off = (this.edgeScreenOffset(edge.id) + engine.laneOf[slot] * 2.2 * dpr) / this.scale;
      const x = this.sx(a.x + dx * f + (-dy / len) * off);
      const y = this.sy(a.y + dy * f + (dx / len) * off);
      ctx.fillStyle = rampColor(this.ramp, engine.vel[slot] / edge.vmax);
      ctx.fillRect(x - v / 2, y - v / 2, v, v);
    });

    // Ring around the traced vehicle.
    if (traceAgentId !== null) {
      const slot = sim.engine.slotOfAgent[traceAgentId] ?? -1;
      if (slot >= 0) {
        const edge = sim.net.edges[sim.engine.edgeOf[slot]];
        const a = this.net.nodes[edge.from];
        const b = this.net.nodes[edge.to];
        const f = sim.engine.pos[slot] / edge.lengthM;
        const x = this.sx(a.x + (b.x - a.x) * f);
        const y = this.sy(a.y + (b.y - a.y) * f);
        ctx.strokeStyle = colors.traceRoute;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
