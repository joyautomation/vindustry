import {
  assertEquals,
  assertAlmostEquals,
} from "@std/assert";
import {
  tick,
  createInitialState,
  DEFAULT_CONFIG,
  type TankInputs,
} from "../src/simulation.ts";

const DT = 100; // 100ms tick

Deno.test("tank fills when pump runs and valve is closed", () => {
  const state = createInitialState(50);
  const inputs: TankInputs = { pumpSpeed: 100, valvePosition: 0 };

  const next = tick(state, inputs, DEFAULT_CONFIG, DT);

  // Level should increase
  assertEquals(next.tankLevel > state.tankLevel, true);
  // Inlet flow should be at max
  assertAlmostEquals(next.inletFlow, DEFAULT_CONFIG.maxPumpFlow, 0.01);
  // Outlet flow should be zero
  assertAlmostEquals(next.outletFlow, 0, 0.01);
});

Deno.test("tank drains when pump is off and valve is open", () => {
  const state = createInitialState(50);
  const inputs: TankInputs = { pumpSpeed: 0, valvePosition: 100 };

  const next = tick(state, inputs, DEFAULT_CONFIG, DT);

  // Level should decrease
  assertEquals(next.tankLevel < state.tankLevel, true);
  // Inlet flow should be zero
  assertAlmostEquals(next.inletFlow, 0, 0.01);
  // Outlet flow should be positive
  assertEquals(next.outletFlow > 0, true);
});

Deno.test("tank level clamps to 0", () => {
  const state = createInitialState(0.001);
  const inputs: TankInputs = { pumpSpeed: 0, valvePosition: 100 };

  // Run many ticks to force level below 0
  let current = state;
  for (let i = 0; i < 1000; i++) {
    current = tick(current, inputs, DEFAULT_CONFIG, DT);
  }

  assertEquals(current.tankLevel, 0);
});

Deno.test("tank level clamps to 100", () => {
  const state = createInitialState(99.999);
  const inputs: TankInputs = { pumpSpeed: 100, valvePosition: 0 };

  let current = state;
  for (let i = 0; i < 1000; i++) {
    current = tick(current, inputs, DEFAULT_CONFIG, DT);
  }

  assertEquals(current.tankLevel, 100);
});

Deno.test("outlet flow decreases as tank empties", () => {
  const inputs: TankInputs = { pumpSpeed: 0, valvePosition: 100 };

  const highLevel = tick(createInitialState(80), inputs, DEFAULT_CONFIG, DT);
  const lowLevel = tick(createInitialState(20), inputs, DEFAULT_CONFIG, DT);

  // Higher level → more head → more outlet flow
  assertEquals(highLevel.outletFlow > lowLevel.outletFlow, true);
});

Deno.test("pump speed of zero produces no flow or pressure", () => {
  const state = createInitialState(50);
  const inputs: TankInputs = { pumpSpeed: 0, valvePosition: 0 };

  const next = tick(state, inputs, DEFAULT_CONFIG, DT);

  assertAlmostEquals(next.inletFlow, 0, 0.01);
  assertAlmostEquals(next.pumpPressure, 0, 0.01);
});

Deno.test("inputs are clamped to 0-100 range", () => {
  const state = createInitialState(50);

  // Over-range inputs should be clamped
  const overRange = tick(
    state,
    { pumpSpeed: 200, valvePosition: -50 },
    DEFAULT_CONFIG,
    DT,
  );

  assertAlmostEquals(overRange.inletFlow, DEFAULT_CONFIG.maxPumpFlow, 0.01);
  assertAlmostEquals(overRange.outletFlow, 0, 0.01);
});

Deno.test("steady state: level stabilizes when inflow equals outflow", () => {
  // Find approximate steady state by running many iterations
  // pumpSpeed=40 → 200 GPM in, valvePosition=80 → 320*sqrt(L/100) out
  // Steady state: 200 = 320*sqrt(L/100) → L ≈ 39%
  let state = createInitialState(50);
  const inputs: TankInputs = { pumpSpeed: 40, valvePosition: 80 };

  for (let i = 0; i < 100_000; i++) {
    state = tick(state, inputs, DEFAULT_CONFIG, DT);
  }

  // At steady state, net flow should be near zero
  const netFlow = Math.abs(state.inletFlow - state.outletFlow);
  assertEquals(netFlow < 1, true, `Net flow ${netFlow} should be < 1 GPM`);
});
