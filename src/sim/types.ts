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
  /** Grid column of the bridge this edge belongs to; −1 for non-bridges. */
  bridgeCol: number;
  /** 0 = vertical (NS street), 1 = horizontal (EW street). */
  axis: 0 | 1;
  freeFlowS: number;
  /** Live closure flag (scenario: "close a road"). Cars only; sidewalks stay open. */
  closed: boolean;
}

export interface Network {
  nodes: NetNode[];
  edges: NetEdge[];
  cols: number;
  rows: number;
}

export type AgentMode = "car" | "walk" | "wfh";

export type TripKind = "toWork" | "toErrand" | "errandReturn" | "toHome";

export interface ErrandPlan {
  /** Planned departure from work (s of day). */
  departS: number;
  dwellS: number;
  node: number;
}

export interface Agent {
  id: number;
  home: number;
  work: number;
  mode: AgentMode;
  /** Desired arrival time at work (s of day) — sampled from the plan mixture. */
  workStartS: number;
  workDurS: number;
  bufferS: number;
  /** Planned first departure: workStart − expected travel − buffer. */
  departS: number;
  /** Expected (free-flow) travel time of the morning leg, set during planning. */
  freeFlowS: number;
  errand: ErrandPlan | null;
  /** IDM heterogeneity. */
  v0mul: number;
  T: number;
  /** Walking pace (m/s) for walk-mode agents. */
  walkSpeed: number;
  /** Route-choice taste: multiplier on arterial edge costs. */
  affinity: number;
  /** Most recently dispatched route (display/trace only). */
  route: Int32Array | null;
  /** Synthetic measurement trips (headless probes) skip day-chaining. */
  probe?: boolean;
}

/** A planned leg, sitting in the scheduler's event heap. */
export interface TripEvent {
  timeS: number;
  seq: number;
  agentId: number;
  kind: TripKind;
  from: number;
  to: number;
}

/** A routed car leg waiting in a driveway queue for road space. */
export interface SpawnRequest {
  agentId: number;
  kind: TripKind;
  from: number;
  to: number;
  route: Int32Array;
  freeFlowS: number;
  plannedS: number;
}

export interface TripArrival {
  agentId: number;
  kind: TripKind;
  mode: AgentMode;
  plannedDepartS: number;
  arriveS: number;
  freeFlowS: number;
  dest: number;
}
