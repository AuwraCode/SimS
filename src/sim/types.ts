export type RoadClass = "arterial" | "local";

/** Phase A = vertical (north-south) approaches green; B = horizontal. */
export interface Signal {
  cycleS: number;
  offsetS: number;
  /** Green duration per phase; phase A occupies [0, green), B [cycle/2, cycle/2+green). */
  greenS: number;
}

export interface NetNode {
  id: number;
  col: number;
  row: number;
  x: number;
  y: number;
  /** True for the CBD side of the river. */
  north: boolean;
  homeW: number;
  jobW: number;
  signal: Signal | null;
  outEdges: number[];
  inEdges: number[];
}

export interface NetEdge {
  id: number;
  from: number;
  to: number;
  lengthM: number;
  lanes: number;
  /** Speed limit (m/s). */
  vmax: number;
  klass: RoadClass;
  isBridge: boolean;
  /** 0 = vertical (NS street), 1 = horizontal (EW street). */
  axis: 0 | 1;
  freeFlowS: number;
}

export interface Network {
  nodes: NetNode[];
  edges: NetEdge[];
  cols: number;
  rows: number;
}

export type AgentMode = "car" | "offroad";

export interface Agent {
  id: number;
  home: number;
  work: number;
  mode: AgentMode;
  /** Desired arrival time at work (s of day) — sampled from the plan mixture. */
  workStartS: number;
  workDurS: number;
  bufferS: number;
  /** Planned departure: workStart − freeFlow(route) − buffer. */
  departS: number;
  /** Free-flow travel time along the chosen route (s). */
  freeFlowS: number;
  /** IDM heterogeneity. */
  v0mul: number;
  T: number;
  /** Edge-id path home→work (null for offroad agents). */
  route: Int32Array | null;
}
