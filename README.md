# SimS — Emergent City Sandbox

A real-time, agent-based 3D city that runs day after day. Tens of thousands of
individual people plan their own day ("be at work by 08:23, ~8.5 h, maybe a
lunch errand, then home"), drive, walk or ride the tram toward jobs spread
across both banks of the river — and the city's rhythm **emerges**: a morning
rush hour, a softer evening peak, businesses lighting up as their workers
physically arrive, residential windows glowing after dark, platform crowds
swelling before 8 am, planes drifting overhead.

It is also a place to *live in*: shops, malls, a hospital, gas stations,
swimming pools, a casino and an amusement park (with a turning ferris wheel)
dot the map, an airport and a river port anchor the edges, and low-rise
villages ring the outskirts; every agent carries a bank balance, earns wages
for the hours they actually work, and spends it on errands and after-work
outings. Cargo ships glide the river, fires break out and draw strobing fire
engines and police, and an optional synthesized soundscape rises and falls
with the traffic. None of it bends The One Rule.

And then the city **learns**. Every night each agent reconciles what they
experienced with what they expected; over successive days the morning peak
visibly migrates earlier and commuters burned by the bridge queue shift onto
the tram — the documented real-world phenomena, reproduced purely from
individual memory.

![day — morning rush in 3D](docs/sandbox-day.png)
*Day 1, ~08:30 — red chains of queued cars spill back from the two bridges;
a teal tram crosses its own track beside the arterial bridge; CBD towers
north of the river. (Screenshots predate the Phase 5 redesign — the live city
is now larger and polycentric, with four bridges, an airport and a port.)*

![learning — day 5 charts](docs/learning-ghosts.png)
*Day 5 — faded ghosts of days 1–4 under today's bright line: the morning
peak has migrated earlier and tightened, purely from nightly self-revision.*

![night — the city at 21:30](docs/sandbox-night.png)
*21:36 — offices have gone dark (their workers left), homes glow warm
(their residents actually made it back). Nothing reads opening hours — light
follows people.*

## Run

```sh
pnpm install
pnpm dev          # 3D sandbox (Vite + three.js); orbit/zoom with the mouse
pnpm headless     # full seeded day in Node: timeline + calibration stats
pnpm headless --days 10   # multi-day learning run with the per-day proof table
pnpm headless --check     # determinism proof (two runs, hash compare)
pnpm lint         # Biome
```

URL params: `?seed=7` (new world), `?n=3000` (population), `?warp=8.25`
(fast-forward to 08:15 — hours may span days: `?warp=104.9` boots straight
into day 5 of the learned city), `?close=7.75` (auto-close the arterial
bridge). UI: play/pause, 1–600× speed, seed/agents restart (up to 200k),
**Trace random agent** (route line + beacon + live plan status — now also
home, balance and the day's errand/outing), **Sound** (opt-in synthesized
audio), **Trigger fire**, and the acceptance experiment buttons (below).

## The One Rule

**Nothing about traffic is a function of the time of day.** There is no
`if (hour === 17) makeTraffic()` anywhere. The clock shapes behaviour in
exactly one place: each agent's sampled daily plan (`sim/population.ts`,
distributions in `config.ts`). Compliant fixtures that read the clock without
encoding demand: signal cycles and the tram timetable (identical, periodic,
all 24 h — trams run empty at 3 am), the sun, ambient planes and river ships
(astronomy/decor), and metric timestamps. Day-to-day learning reads no clock
either — only each agent's own experienced vs expected commute. The Phase 4
additions keep the rule too: POIs and the per-agent economy are sampled from
their own dedicated streams (so the calibrated commute is bit-for-bit
untouched), and fires ignite as a **memoryless Poisson hazard at a constant
per-second rate** — risk that is flat across the day, coupled to nothing.
Audited: `sim/` contains no `Math.random`, no `Date.now`, no `Math.pow`, and
no time-of-day constants outside the plan distributions.

## How the day emerges

1. **Plans** (the only clock-coupled code): ~80% drive, ~12% prefer walking
   (and do, if home–work ≤ 1.7 km), ~8% work from home. Work starts cluster
   around 08:15; 15% of drivers plan a midday errand; everyone returns after
   their personal work duration. Trips CHAIN off real arrivals — a commute
   that congestion made 40 min late pushes that person's whole day.
2. **Geography**: homes weighted toward the larger south bank, jobs spread
   across BOTH banks (a north CBD plus south business/tech clusters, the
   airport and the port). The cross-river commuters that remain funnel onto a
   finite set of bridges, so the morning queue still forms there — but the
   polycentric land use keeps most trips local, which is what lets the city
   scale (see **Phase 5** below). *(Phases 1–3 used a single north CBD and two
   one-lane bridges — a deliberately tight bottleneck calibrated for N=5000;
   the numbers in the tables below were measured on that original city.)*
3. **Microscopic physics** (`sim/traffic/idm.ts`): every vehicle runs the
   Intelligent Driver Model; queues, stop-and-go waves and **spillback**
   (full edges refuse entry, jams grow backwards) follow from gap dynamics.
4. **Reaction, not scripting** (`sim/routing.ts`): every edge keeps an EMA of
   travel times real vehicles just measured; drivers route on those observed
   costs at departure, stuck vehicles re-plan (≤3×). Jams repel newcomers —
   congestion spreads across parallels and dissolves from the edges. This
   negative feedback cut p90 delay from 32 min (Phase 1 static routes) to
   ~7 min at identical demand.
5. **The visible city follows the people**: a business "opens" (brightens)
   the moment its node's `workersAt` goes positive; home windows at night
   scale with `residentsAt`. Both counters are maintained purely by actual
   arrivals/departures.

## Acceptance experiments — proving it's emergent (buttons in the UI)

The original single-CBD / two-one-lane-bridge city (Phases 1–3, N=5000):

| experiment | result (seed 42, N = 5000) | proves |
|---|---|---|
| baseline | am peak 442 active, min 4.6 km/h; pm peak 94, min 16 km/h | the two peaks exist |
| **Flatten schedules** (`--flatten`) | peaks collapse to ~33; never below 18 km/h | peaks come from schedule overlap, not any time-based code |
| **Close bridge** at 07:45 (`--close`) | arterial-bridge flow → 0; local bridge jumps to its 15 /min ceiling; 1059 active at 0.9 km/h; p90 64 min | congestion re-routes spatially and intensifies on parallels |
| **+50% agents** (`--boost 1.5`) | am peak 1386, pm 578; evening also collapses (3.5 km/h) | congestion is coupled to road capacity, nonlinearly |

The same experiments on the **Phase 5 polycentric city** (seed 42, default
N=14000) — the relief is visible, but the proofs still hold:

| experiment | result (seed 42, N = 14000) | proves |
|---|---|---|
| baseline | am peak 481 active @ 08:02, min 18.6 km/h; clears by 09:00 | a peak still emerges, but the spread jobs + 4 two-lane bridges keep it flowing |
| **Flatten schedules** | am peak collapses to ~110, peak/mean 4.96 → 3.52 | the peak is still pure schedule overlap, not any clock code |
| **Close bridge** | one arterial bridge → 0; queue +20% as flow reroutes onto the other three | congestion re-routes spatially even with spare capacity |
| **+50% agents** (≈21k) | am peak 946, min 16.2 km/h; still drains | headroom — heavy load is absorbed; full gridlock only near ~30k |

Demand→capacity coupling (baseline morning): N=2000 → bridges underloaded,
p90 2.9 min; N=3000 → at capacity, brief saturation; N=5000 → v/c > 1,
collapse. 2.5× the population, ~19× the p90 delay.

## Day-to-day learning (Phase 3) — the city teaches itself

Nightly, ~45% of agents revise: `expectedCommute ← EMA(experienced)`, the
lateness buffer grows asymmetrically (being late hurts more than being
early), and commuters near the tram line pick tomorrow's mode from their own
two learned expectations (× a personal comfort affinity). Measured over 10
days (seed 42, `pnpm headless --days 10`):

| day | am peak | min speed | mean depart | mean late | p90 delay | tram share |
|----:|--------:|----------:|------------:|----------:|----------:|-----------:|
| 1 | 520 @ 08:30 | 3.6 km/h | 07:54 | 3.2 min | 14.6 min | 0.0 % |
| 4 | 511 @ 08:14 | 4.0 km/h | 07:51 | 2.1 min | 14.6 min | 3.6 % |
| 7 | 461 @ 08:08 | 4.4 km/h | 07:49 | 0.9 min | 14.2 min | 6.5 % |
| 10 | 383 @ 08:00 | 5.9 km/h | 07:48 | 0.3 min | 11.8 min | 7.4 % |

The peak migrates **30 minutes earlier and shrinks 26%**, lateness collapses
toward zero, and the tram's mode share grows monotonically from nothing —
two relief valves (when to leave, what to ride) opened by nothing but
individual experience. The ghost charts in the UI show it live.

*Note (Phase 5):* this table is the original N=5000 single-CBD city, where the
bridges saturated and there was real pain to learn from. The polycentric
redesign deliberately relieves that pressure, so at the default N=14000 the
commute is near free-flow (p90 ≈ 2.5 min) and the nightly revision sits mostly
idle — there is nothing to correct. The learning machinery is unchanged; it
re-engages, with the same peak-migration and tram-adoption behaviour, once you
load the city back to the knee of its capacity (push N toward ~26–30k via
repeated **+50% agents**).

## City life (Phase 4) — a place to live, not just commute

A land-use layer and a per-agent economy turn the commuter sandbox into a
small living city, **without touching a single commute number** — everything
new is sampled from dedicated rng streams (`sim/places.ts`) so the morning
peak stays bit-for-bit identical (am peak 515 @ 08:28, both before and after).

- **Points of interest** scatter across the grid: ~38 shops, malls, a
  hospital, gas stations, swimming pools, an amusement park, a casino, and the
  fire/police stations emergencies dispatch from. Each is a recognisable 3D
  landmark (a turning ferris wheel, a shimmering pool, neon-trimmed casinos, a
  red-cross hospital, canopied gas stations…).
- **Money**: every agent opens with a bank balance and an hourly wage, banks
  pay for the hours they *actually* worked (congestion that shortens the day
  costs them), and spends it — midday errands now visit a real shop/mall/gas
  station, and ~22% of drivers take an **after-work outing** to a pool, park,
  mall or casino before heading home. A casino visit gambles the stake on a
  stateless per-(agent, day) hash. Money is pure flavour: it never feeds back
  into routing, so the peaks are untouched, yet it is fully deterministic and
  folded into the state fingerprint.
- **Emergencies**: fires ignite as a constant-rate Poisson hazard (a dedicated
  stream — no clock coupling); the nearest fire station and police dispatch
  responders that route to the scene at a hot speed, work it, and return. They
  ride the roads but not the microscopic engine, so the calibrated traffic is
  preserved. Trigger one yourself with the **Trigger fire** button.
- **Ships & sound**: cargo ships cross the river on periodic loops (the
  waterborne twin of the planes), and an opt-in Web Audio soundscape (traffic
  rumble scaled by moving cars, a day/night pad, sirens during emergencies,
  the odd horn) layers on top — all synthesized, no asset files.
- **More agents**: the population ceiling is 200k (restart / +50% / boost);
  the instanced renderer and walker pool scale with it.

The richer 3D city also gains pitched roofs on houses, rooftop plant on
towers, instanced trees and streetlights that warm up after dusk.

## Scaling up (Phase 5) — a bigger, polycentric city

The original city was a deliberately tight bottleneck (one north CBD, two
one-lane bridges) — perfect for *showing* emergent gridlock at N=5000, but it
seized into permanent jam well before 20k because every commute chased the
same place across the same two bridges. Phase 5 reworks the geography so
demand scales:

- **Bigger grid** (18×13, was 12×9) with the river lower so the north bank is
  larger.
- **Polycentric employment**: a smaller north CBD plus a south-west business
  district, a south-east tech park, secondary north centres, and the airport
  and port — so most south residents now work *south* of the river. Cross-river
  demand drops sharply; nobody-funnels-to-one-place.
- **Bigger roads**: four two-lane bridges (was two one-lane) on wide arterial
  avenues. The *close-a-bridge* experiment now shuts one so traffic reroutes
  onto the parallels instead of severing the banks.
- **Airport & port** as land-use *districts* (`node.district`) with bespoke
  landmarks (runway + terminal + control tower; quay + gantry cranes + a
  docked freighter), and **satellite villages** on the outskirts — low-rise
  homes whose residents commute in.

Result (seed 42): the default **N=14000** fills the larger city to a clear,
flowing morning peak; **N=20000** is a busy rush hour (~12–18 km/h) that still
drains where the old layout permanently gridlocked; only around **~30k** does
it finally seize. The trade for this headroom is that the morning commute at
the default is near free-flow, so the Phase 3 learning response is idle until
the city is loaded back toward capacity (see the note above).

## Module map

```
src/config.ts               every tunable; the only time-of-day numbers are
                            the plan distributions
src/sim/rng.ts              mulberry32 + named sub-streams; full determinism
src/sim/network.ts          procedural polycentric city: 18×13 grid, river,
                            4 two-lane bridges, CBD/hubs + districts (airport,
                            port, villages)
src/sim/population.ts       agents & daily plans (THE only clock-coupled code)
src/sim/places.ts           POIs (own stream) + per-agent economy/outings layer
src/sim/routing.ts          Router: per-edge EMA of observed times + Dijkstra;
                            per-agent taste noise (anti-herding)
src/sim/traffic/idm.ts      IDM + ballistic integrator (stop-within-step)
src/sim/traffic/junction.ts periodic signal phase evaluation
src/sim/traffic/engine.ts   SoA vehicle pool, lane FIFOs, spillback as leader
                            selection, amber-commit, FCFS priority, closures,
                            stuck re-planning, edge-traversal observations
src/sim/walkers.ts          sidewalk pedestrians (plans without road load)
src/sim/transit.ts          tram line: closed-form periodic timetable +
                            rider state machine (walk → wait → ride → walk)
src/sim/learning.ts         nightly self-revision: expectations, buffers,
                            mode choice — from each agent's OWN experience
src/sim/scheduler.ts        event-heap multi-day choreography: trip chains +
                            building occupancy (workersAt / residentsAt)
src/sim/metrics.ts          per-minute series; per-kind trip delays
src/sim/emergency.ts        Poisson fire hazard + fire/police dispatch (own
                            stream; responders ride roads, not the engine)
src/sim/sim.ts              framework-agnostic façade (probes, closures,
                            midnight rollover, hash)
src/audio.ts                opt-in Web Audio soundscape (synthesized; render-side)
src/render3d/               three.js sandbox: city (roofs, trees, streetlights),
                            POI landmarks, airport + port (landmarks3d),
                            instanced cars/pedestrians, tram + platform crowds,
                            signals, planes, ships, fires + strobing
                            responders, day/night sky
src/render/charts.ts        dependency-free 24h charts with multi-day ghosts
scripts/headless.ts         Node runner: calibration, probes, experiments,
                            --days learning table, determinism hashes
```

## Determinism

Same seed ⇒ identical day, bit-for-bit: all randomness flows through named
mulberry32 streams, iteration orders are fixed, the event heap breaks ties by
sequence number, and `pnpm headless --check` compares FNV-1a hashes over the
full dynamic state of two runs. UI-side randomness (which agent to trace)
deliberately uses `Math.random` — it must not touch sim streams.

## Status & roadmap

- **Phase 1 (done)**: morning-commute MVP, calibrated bridges, 2D view.
- **Phase 2 (done)**: full day (returns + errands + evening peak),
  congestion-aware re-routing, walkers, acceptance experiments, and the 3D
  sandbox (buildings, occupancy lighting, day/night, planes).
- **Phase 3 (done)**: multi-day simulation with day-to-day learning (peak
  spreading) and a tram line with emergent mode choice. The spec's optional
  OSM import was deliberately left out — the procedurally calibrated city is
  this project's controlled experiment; swapping in a real map is a natural
  future extension of `sim/network.ts` alone.
- **Phase 4 (done)**: a living city — POIs (shops, malls, hospital, gas,
  pools, amusement park, casino), a per-agent economy (wages + errand/outing
  spending), fires with fire/police response, river ships, a synthesized
  soundscape, and a 200k-agent ceiling. All layered without disturbing the
  calibrated commute (separate streams; morning peak unchanged).
- **Phase 5 (done)**: a bigger, polycentric city that scales — 18×13 grid,
  jobs spread across both banks, four two-lane bridges, airport/port districts
  with landmarks, and satellite villages. Fixes the permanent gridlock past
  ~8k by de-funnelling demand; runs a busy-but-clearing rush hour at 20k.

## Assumptions & known simplifications

- The river + bridges are the structural bottleneck; Phase 5 widened it to
  four two-lane bridges and spread jobs across both banks, so the default is
  now N = 14000 and the city only fully gridlocks near ~30k. Airport, port and
  villages are rectangular land-use districts; villages are corner low-rise
  residential, not detached off-grid hamlets.
- Lanes are independent FIFOs chosen at entry; no mid-edge lane changes, no
  protected left turns; junctions are zero-length with a 7 m/s corner cap.
- Signals only at arterial junctions and bridgeheads; local×local crossings
  use deterministic first-come-first-served priority.
- Errands are driver-only (tram days skip the shop run); walkers and riders
  ignore road closures (sidewalks and the tram's right-of-way stay open).
- The tram has unlimited capacity and never interacts with car traffic (own
  right-of-way); riders board the next scheduled departure — platform
  crowding is visual, not a constraint (a future squeeze point if desired).
- Learning uses the morning leg only; errand timing and work targets are
  fixed traits. Mode choice exists where both walk legs are ≤ 600 m of a stop.
- Night driving averages ≈ 0.5× free-flow — the cost of signals on an empty
  network (infrastructure baseline), not congestion.
- Building lights are render-side reads of occupancy counters; planes and
  ships are periodic decoration; arrival releases road capacity instantly.
- Emergency vehicles route on the road network but do NOT enter the
  microscopic engine — they never block cars (sirens parting traffic is
  unmodelled), the deliberate price of keeping the calibrated traffic and the
  acceptance experiments bit-for-bit intact.
- Money is flavour only: it never gates a trip or feeds routing, so it cannot
  change the emergent peaks; it is deterministic and in the state hash.
- Errands now target a real POI (shop/mall/gas) and ~22% of drivers add an
  after-work outing; these reshape midday/evening background traffic but not
  the morning peak (they happen after it). POIs may visually overlap a
  building since both sit in the same block.
