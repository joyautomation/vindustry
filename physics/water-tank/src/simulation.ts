/**
 * Water Tank Physics Simulation
 *
 * Models a clearwell tank with an inlet pump and outlet valve.
 * Pure functions — no NATS or I/O dependencies.
 */

export type TankConfig = {
  /** Tank capacity in gallons */
  capacity: number;
  /** Max pump flow rate at 100% speed (GPM) */
  maxPumpFlow: number;
  /** Max valve flow rate at 100% open with full head (GPM) */
  maxValveFlow: number;
  /** Max pump discharge pressure at 0% flow (PSI) */
  maxPumpPressure: number;
};

export type TankState = {
  /** Tank level (0–100 %) */
  tankLevel: number;
  /** Current inlet flow rate (GPM) */
  inletFlow: number;
  /** Current outlet flow rate (GPM) */
  outletFlow: number;
  /** Pump discharge pressure (PSI) */
  pumpPressure: number;
};

export type TankInputs = {
  /** Pump speed command (0–100 %) */
  pumpSpeed: number;
  /** Outlet valve position (0–100 %) */
  valvePosition: number;
};

export const DEFAULT_CONFIG: TankConfig = {
  capacity: 10_000, // gallons
  maxPumpFlow: 500, // GPM
  maxValveFlow: 400, // GPM
  maxPumpPressure: 60, // PSI
};

export function createInitialState(initialLevel = 50): TankState {
  return {
    tankLevel: initialLevel,
    inletFlow: 0,
    outletFlow: 0,
    pumpPressure: 0,
  };
}

/**
 * Advance the simulation by one tick.
 *
 * @param state  Current tank state
 * @param inputs Actuator commands from PLC
 * @param config Tank parameters
 * @param dtMs   Time step in milliseconds
 * @returns      New tank state (does not mutate input)
 */
export function tick(
  state: TankState,
  inputs: TankInputs,
  config: TankConfig,
  dtMs: number,
): TankState {
  const pumpFraction = clamp(inputs.pumpSpeed, 0, 100) / 100;
  const valveFraction = clamp(inputs.valvePosition, 0, 100) / 100;

  // Inlet: pump produces flow proportional to speed
  const inletFlow = pumpFraction * config.maxPumpFlow;

  // Outlet: gravity-driven through valve — flow drops with sqrt of head
  const headFactor = state.tankLevel / 100;
  const outletFlow =
    valveFraction * config.maxValveFlow * Math.sqrt(Math.max(0, headFactor));

  // Pump pressure: dead-head pressure minus flow-dependent drop
  const pumpPressure =
    pumpFraction * config.maxPumpPressure * (1 - 0.3 * pumpFraction);

  // Tank level change: net flow over time step
  const netFlowGpm = inletFlow - outletFlow;
  const dtMinutes = dtMs / 60_000;
  const gallonsChanged = netFlowGpm * dtMinutes;
  const levelChange = (gallonsChanged / config.capacity) * 100;

  return {
    tankLevel: clamp(state.tankLevel + levelChange, 0, 100),
    inletFlow,
    outletFlow,
    pumpPressure,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
