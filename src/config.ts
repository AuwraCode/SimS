/**
 * Every tunable number in the simulation lives here. Nothing in sim/ may
 * hardcode a magic constant — and, per The One Rule, nothing anywhere may make
 * traffic a function of the clock. The ONLY time-of-day numbers below are the
 * agents' plan distributions (population.startMix etc.).
 *
 * Units: internally everything is SI — meters, seconds, m/s. Helpers below
 * convert from human units (km/h, minutes, hh:mm) at config-definition time.
 */

const kmh = (v: number): number => v / 3.6;
const minutes = (m: number): number => m * 60;
const hm = (h: number, m = 0): number => h * 3600 + m * 60;

export const config = {
  /** Master seed. Every run is fully reproducible from this one number. */
  seed: 42,

  sim: {
    /** Fixed simulation timestep (s). Render framerate is decoupled. */
    dt: 0.5,
    /** Upper bound on sim steps per animation frame (slow tabs lose speed, never accuracy). */
    maxStepsPerFrame: 60,
    /** Default sim-seconds per real second. */
    defaultSpeedMultiplier: 60,
    minSpeedMultiplier: 1,
    maxSpeedMultiplier: 600,
    /** Simulation covers one day, 00:00–24:00. */
    dayEndS: 24 * 3600,
  },

  /**
   * Intelligent Driver Model parameters. These shape car-following dynamics;
   * congestion emerges when many vehicles with these dynamics share an edge.
   */
  idm: {
    /** Max acceleration (m/s²). 1.5 gives crisp urban queue discharge. */
    a: 1.5,
    /** Comfortable deceleration (m/s²). */
    b: 2.0,
    /** Standstill minimum gap (m). */
    s0: 2.0,
    /** Safe time headway range (s) — sampled per driver (heterogeneity). */
    TMin: 1.2,
    TMax: 1.6,
    /** Vehicle length (m). Jam spacing = s0 + length ≈ 6.5 m/veh ≈ 154 veh/km/lane. */
    vehicleLength: 4.5,
    /** Per-driver desired-speed multiplier ~ N(1, sigma), clamped. */
    v0Sigma: 0.08,
    v0MulMin: 0.8,
    v0MulMax: 1.25,
    /** Hard floor on commanded deceleration (m/s²) — numerical safety. */
    accelFloor: -9,
    /** Approach speed cap when the next route edge turns a corner (m/s)… */
    turnSpeed: 7,
    /** …applied within this distance of the edge end (m). */
    turnZone: 12,
  },

  /**
   * Fixed-cycle, two-phase signals (phase A = north-south green, B = east-west).
   * A periodic fixture: the same plan runs all 24 h, so signals cannot encode
   * rush hour. Offsets are randomized per junction at worldgen.
   */
  signals: {
    cycleS: 60,
    /** Dead time after each green (all-red clearance). green = cycle/2 − lost. */
    lostTimeS: 4,
  },

  /** Unsignalized (local×local) junctions: first-come-first-served. */
  priority: {
    /** A lane head within this distance of the stop line joins the FCFS queue (m). */
    stopZoneM: 25,
  },

  /**
   * Procedural city: a grid split by a river. The small north side holds the
   * CBD (jobs), the large south side is residential (homes). Only 2 bridges
   * cross — geography, not the clock, is what concentrates the morning flow.
   *
   * Rows are numbered north→south (row 0 = top of screen).
   */
  network: {
    cols: 12,
    rows: 9,
    spacingM: 140,
    /** Cosmetic node jitter (m); keeps the grid from looking sterile. */
    jitterM: 12,
    /** River lies between these two rows; no vertical edges cross elsewhere. */
    riverNorthRow: 2,
    riverSouthRow: 3,
    /** Columns that carry a bridge. Bridge spans are ALWAYS 1 lane/direction — the calibrated bottleneck. */
    bridgeCols: [3, 8],
    /** Streets along these lines are arterials (2 lanes/dir, fast). */
    arterialCols: [3, 7],
    arterialRows: [1, 6],
    speeds: {
      arterial: kmh(60),
      local: kmh(35),
    },
    lanesPerClass: {
      arterial: 2,
      local: 1,
    },
    /** CBD block (inclusive col/row ranges, north side). */
    cbd: { col0: 4, col1: 6, row0: 0, row1: 2 },
    /** Secondary commercial hubs: single high-job nodes. */
    hubs: [
      { col: 10, row: 1, jobW: 15 },
      { col: 1, row: 7, jobW: 25 },
    ],
    /**
     * Land-use weights → sampling distributions for homes and jobs.
     * Resulting shares (derived, not enforced): ~90% of homes south of the
     * river, ~78% of south residents' jobs north of it.
     */
    weights: {
      cbd: { home: 0.5, job: 30 },
      north: { home: 3, job: 2 },
      south: { home: 10, job: 1 },
    },
  },

  /**
   * Population & daily plans — THE ONLY clock-coupled numbers in the project.
   * Calibration identity (peak demand on the bridges, veh/min):
   *   peak ≈ 1.1 · N · driverShare · southHomeShare · crossJobShare · mainMixWeight / (2.507 · σ_main_min)
   *        ≈ 1.1 · N · 0.8 · 0.9 · 0.78 · 0.7 / (2.507 · 25)  ≈  0.0077 · N
   * Two 1-lane bridges discharge ≈ 35–45 veh/min through signalized heads, so
   * N = 5000 puts peak v/c at ≈ 0.9–1.1: the morning flow exceeds bridge
   * capacity for ~45 min and queues MUST form — purely from plan overlap.
   */
  population: {
    N: 5000,
    /** Mode mixture: wfh stays home, walk-preferrers walk when the trip is short enough, the rest drive. */
    modes: { wfh: 0.08, walkPref: 0.12 },
    walk: {
      /** Walk-preferrers whose home→work path is longer than this drive instead. */
      maxDistM: 1700,
      speedMin: 1.15,
      speedMax: 1.6,
    },
    /** Work start time ~ mixture of gaussians (the early / main / flexible-late workforce). */
    startMix: [
      { w: 0.15, mu: hm(6, 0), sigma: minutes(30) },
      { w: 0.7, mu: hm(8, 15), sigma: minutes(25) },
      { w: 0.15, mu: hm(9, 30), sigma: minutes(60) },
    ],
    startClampS: [hm(3, 30), hm(13, 0)] as [number, number],
    /** Work duration; clamped so workStart + duration ≤ latestEnd (everyone is home before 24:00). */
    workDur: { mu: hm(8, 30), sigma: minutes(35), min: hm(4), max: hm(11) },
    latestEndS: hm(22, 30),
    /** Midday errand: share of drivers who pop out of work to a shop and back. */
    errand: {
      share: 0.15,
      afterMinS: hm(3, 0),
      afterMaxS: hm(5, 30),
      dwellMinS: minutes(15),
      dwellMaxS: minutes(45),
      /** Errand only happens if there is at least this much workday left after it. */
      minRemainderS: hm(1, 30),
    },
    /** Personal arrival buffer: depart = workStart − freeFlowTime − buffer. */
    buffer: { mu: minutes(8), sigma: minutes(4), min: 60, max: minutes(25) },
    /** Minimum dwell before the next leg when a late arrival overruns the plan. */
    chainGapS: minutes(12),
    /** Per-agent multiplier on arterial edge costs ~ N(1, sigma) — route-choice heterogeneity. */
    arterialAffinitySigma: 0.1,
    arterialAffinityClamp: [0.7, 1.4] as [number, number],
    /** Per-(agent,edge) cost noise amplitude for tie-breaking among equal grid paths. */
    tieNoise: 0.02,
  },

  /**
   * Land use beyond homes & jobs (Phase 4). Points of interest are scattered
   * procedurally at worldgen from a DEDICATED rng stream, and agents VISIT them
   * as part of their sampled plan (midday errands + after-work outings). Adding
   * this layer therefore leaves the calibrated commute streams — and every
   * morning-peak number in the README — bit-for-bit untouched. Nothing here
   * reads the clock.
   *
   * Per kind: how many to place, in which `zone`, whether it is an after-work
   * `leisure` destination, and the money a visit costs (uniform range; a casino
   * gambles the stake instead of spending it).
   */
  places: {
    kinds: {
      shop: { count: 38, zone: "any", leisure: false, cost: [8, 45] },
      gas: { count: 10, zone: "arterial", leisure: false, cost: [40, 95] },
      mall: { count: 5, zone: "commercial", leisure: true, cost: [30, 220] },
      hospital: { count: 3, zone: "any", leisure: false, cost: [0, 0] },
      pool: { count: 5, zone: "south", leisure: true, cost: [10, 32] },
      park: { count: 4, zone: "south", leisure: true, cost: [15, 65] },
      casino: { count: 3, zone: "north", leisure: true, cost: [60, 420] },
      fireStation: { count: 4, zone: "any", leisure: false, cost: [0, 0] },
      police: { count: 4, zone: "any", leisure: false, cost: [0, 0] },
    } as Record<string, { count: number; zone: string; leisure: boolean; cost: [number, number] }>,
    /** Share of (non-wfh) agents who take an after-work outing to a leisure POI. */
    outingShare: 0.22,
    /** Outing dwell range (s). */
    outingDwellS: [minutes(40), minutes(150)] as [number, number],
  },

  /**
   * Per-agent economy (Phase 4). Pure flavour layered on top of the traffic —
   * money never feeds back into routing or demand, so it cannot affect the
   * emergent peaks. It is fully deterministic all the same: balances and wages
   * are sampled from the economy stream, earnings derive from hours ACTUALLY
   * worked, and a casino visit's win/loss is a stateless hash of (agent, day).
   */
  economy: {
    /** Opening bank balance ~ uniform. */
    startBalance: [200, 4200] as [number, number],
    /** Hourly wage ~ N(mu, sigma) clamped. */
    wage: { mu: 27, sigma: 11, min: 9, max: 85 },
    /** Work-from-home agents earn this flat pay every simulated day. */
    wfhDailyPay: [110, 270] as [number, number],
    /** Casino: win probability, and the multiple of the stake won on a win. */
    casino: { winProb: 0.46, winMult: 1.9 },
  },

  /**
   * Congestion-aware routing (Phase 2). Drivers route at departure on
   * OBSERVED edge travel times (exponential averages of what real vehicles
   * just experienced), decaying back to free flow as observations go stale.
   * This is drivers reacting to traffic — traffic never reacts to the clock.
   */
  routing: {
    /** EMA gain for each new edge-traversal observation. */
    emaAlpha: 0.35,
    /** Staleness decay back toward free flow (time constant, s). */
    decayTauS: 600,
    /** A vehicle stopped this long re-plans its remaining route… */
    stuckRerouteS: 240,
    /** …at most this many times per leg. */
    maxReroutes: 3,
  },

  /** Acceptance-experiment switches (set via UI buttons / headless flags). */
  scenario: {
    /** Replace the work-start mixture with uniform across the day → peaks must vanish. */
    flattenSchedules: false,
    flattenRangeS: [hm(4, 0), hm(14, 0)] as [number, number],
  },

  /**
   * Day-to-day learning (Phase 3). Each midnight every agent reconciles what
   * they EXPERIENCED with what they EXPECTED — and only that. Over days the
   * morning peak spreads earlier as people leave sooner to beat the jam they
   * personally sat in; the system relaxes toward a quasi-equilibrium. This is
   * the documented real-world phenomenon, reproduced from individual memory,
   * never from any global rule.
   */
  learning: {
    /**
     * Share of agents who actually revise their plan on a given night.
     * If EVERYONE reacted to yesterday simultaneously the system oscillates
     * (good day → all relax → bad day → all overcorrect); partial nightly
     * revision is the classic, behaviorally honest damper.
     */
    reviseShare: 0.45,
    /** EMA gain on experienced door-to-desk commute time. */
    lambda: 0.35,
    /** Arrived late → grow the personal buffer by this fraction of the lateness. */
    lateBufferGain: 0.3,
    /** Being early is tolerated up to this slack… */
    earlySlackS: minutes(20),
    /** …beyond it, the buffer decays by this fraction of the excess earliness. */
    earlyBufferDecay: 0.08,
    bufferClampS: [60, minutes(40)] as [number, number],
  },

  metrics: {
    /** Sampling cadence for the time-series charts (sim seconds). */
    sampleEveryS: 60,
    /** A vehicle below this speed counts as stopped (m/s). */
    stoppedSpeed: 0.1,
    /** Stopped longer than this (s) counts as "stuck" — gridlock telemetry. */
    stuckThresholdS: 300,
  },

  /**
   * Public transit (Phase 3): one tram line on its own right-of-way, an
   * L from the southern residential spine over the river into the CBD.
   * The timetable is a periodic fixture (like signals); WHO rides is learned.
   */
  transit: {
    headwayS: 300,
    dwellS: 25,
    speed: kmh(45),
    path: [
      { col: 3, row: 8 },
      { col: 3, row: 7 },
      { col: 3, row: 6 },
      { col: 3, row: 5 },
      { col: 3, row: 4 },
      { col: 3, row: 3 },
      { col: 3, row: 2 },
      { col: 3, row: 1 },
      { col: 4, row: 1 },
      { col: 5, row: 1 },
      { col: 6, row: 1 },
      { col: 7, row: 1 },
    ],
    stops: [
      { col: 3, row: 8 },
      { col: 3, row: 6 },
      { col: 3, row: 4 },
      { col: 3, row: 3 },
      { col: 3, row: 2 },
      { col: 3, row: 1 },
      { col: 5, row: 1 },
      { col: 7, row: 1 },
    ],
    /** Transit is an option when both walk legs are within this distance. */
    maxAccessM: 600,
    /** Per-agent comfort multiplier on transit cost ~ N(mu, sigma) — most prefer the car. */
    affinity: { mu: 1.25, sigma: 0.2, clamp: [0.85, 1.8] as [number, number] },
    /** Nightly relaxation of the UNUSED mode's expectation toward its baseline. */
    unusedModeRelax: 0.12,
  },

  /** Ambient sky traffic — pure decoration on periodic loops (no demand coupling). */
  ambient: {
    planes: 3,
    planeAltitudeM: 420,
    planeSpeedMs: 80,
  },

  render: {
    chartLine: "#4fa3ff",
    chartLine2: "#ffc44f",
    chartLine3: "#ff7b6b",
    chartGrid: "#262b33",
    chartCursor: "#8b93a3",
    /** 3D scene palette & building generation. */
    three: {
      skyDay: 0x87b5e8,
      skyNight: 0x070b14,
      ground: 0x1d2b20,
      groundNorth: 0x232e33,
      river: 0x1d4a6e,
      roadLocal: 0x32363f,
      roadArterial: 0x3d424e,
      buildingsPerNode: [2, 4] as [number, number],
      heights: {
        cbd: [45, 130] as [number, number],
        hub: [22, 55] as [number, number],
        northRes: [10, 26] as [number, number],
        southRes: [6, 16] as [number, number],
      },
      sunriseH: 5.5,
      sunsetH: 20.5,
      /** Greenery & street furniture (Phase 4) — all instanced for high N. */
      trees: { count: 320, foliage: 0x2f6b3a, trunk: 0x5b4632 },
      streetlight: { pole: 0x4a525e, lamp: 0xffe6a6 },
      /** Per-POI-kind palette (Phase 4). */
      poi: {
        shop: 0xb56a4a,
        gas: 0xdbe2ea,
        gasSign: 0xff5a3c,
        mall: 0x8a8f9c,
        mallSign: 0x6fd3ff,
        hospital: 0xeef2f6,
        hospitalCross: 0xe23b3b,
        pool: 0x2aa6d6,
        poolDeck: 0xd9c7a3,
        park: 0xd24b8c,
        parkRim: 0xffd23f,
        casino: 0x161019,
        casinoNeon: 0xff3da6,
        fireStation: 0xc23a2c,
        police: 0x274b8f,
        emergencyLight: 0xff4040,
      },
    },
  },
};

export type SimsConfig = typeof config;

export interface ConfigOverrides {
  seed?: number;
  n?: number;
  flatten?: boolean;
}

/** Deep clone so UI restarts can override (seed, N, scenario) without mutating defaults. */
export function cloneConfig(overrides?: ConfigOverrides): SimsConfig {
  const c = structuredClone(config);
  if (overrides?.seed !== undefined) c.seed = overrides.seed;
  if (overrides?.n !== undefined) c.population.N = overrides.n;
  if (overrides?.flatten !== undefined) c.scenario.flattenSchedules = overrides.flatten;
  return c;
}
