/**
 * Physics Engine — Water Treatment Fieldbus Scenario
 *
 * The "world simulator" that connects all simulated instruments.
 * Runs the water tank ODE and publishes sensor values to per-instrument
 * NATS topics. Instrument containers (running tentacle-modbus-server)
 * pick these up and serve them via Modbus TCP.
 *
 * Data flow:
 *   VFD (Modbus write) → modbus-server → NATS → here → NATS → instrument modbus-servers → Modbus TCP → PLC
 *
 * Environment variables:
 *   NATS_SERVERS   — NATS server URL(s) (default: nats://localhost:4222)
 *   PLC_PROJECT_ID — PLC project ID for subscribing to commands (default: water-treatment)
 *   TICK_MS        — Simulation tick rate in ms (default: 100)
 *   INITIAL_LEVEL  — Initial tank level % (default: 50)
 */

import { connect, type NatsConnection } from "@nats-io/transport-deno";
import { createLogger, LogLevel } from "@joyautomation/coral";
import {
  tick,
  createInitialState,
  DEFAULT_CONFIG,
  type TankState,
  type TankInputs,
} from "@vindustry/water-tank";

const log = createLogger("physics-engine", LogLevel.info);

const NATS_SERVERS = Deno.env.get("NATS_SERVERS") || "nats://localhost:4222";
const PLC_PROJECT_ID = Deno.env.get("PLC_PROJECT_ID") || "water-treatment";
const TICK_MS = parseInt(Deno.env.get("TICK_MS") || "100");
const INITIAL_LEVEL = parseInt(Deno.env.get("INITIAL_LEVEL") || "50");

// Instrument source module IDs — must match the registration configs
const INSTRUMENTS = {
  flowMeter: "flow-meter",
  levelSensor: "level-sensor",
  vfd: "vfd",
} as const;

async function connectToNats(): Promise<NatsConnection> {
  const servers = NATS_SERVERS.split(",").map((s) => s.trim());
  while (true) {
    try {
      log.info(`Connecting to NATS at ${NATS_SERVERS}...`);
      const nc = await connect({ servers });
      log.info("Connected to NATS");
      return nc;
    } catch (err) {
      log.warn(`NATS connection failed: ${err}. Retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/**
 * Publish a value as a PlcDataMessage to a NATS topic.
 * This format is what tentacle-modbus-server subscribes to.
 */
function publishInstrumentValue(
  nc: NatsConnection,
  encoder: TextEncoder,
  sourceModuleId: string,
  variableId: string,
  value: number,
) {
  const msg = JSON.stringify({
    variableId,
    value,
    timestamp: Date.now(),
  });
  nc.publish(`${sourceModuleId}.data.${variableId}`, encoder.encode(msg));
}

async function main() {
  log.info("═══════════════════════════════════════════════════════════════");
  log.info("        Vindustry Physics Engine (Fieldbus)");
  log.info("═══════════════════════════════════════════════════════════════");

  const nc = await connectToNats();
  const encoder = new TextEncoder();

  let state: TankState = createInitialState(INITIAL_LEVEL);
  const inputs: TankInputs = { pumpSpeed: 0, valvePosition: 50 };

  // Subscribe to PLC actuator outputs
  // The PLC publishes to plc.data.{projectId}.{variableId} with PlcDataMessage
  const pumpSpeedSub = nc.subscribe(`plc.data.${PLC_PROJECT_ID}.pumpSpeed`);
  const valvePosSub = nc.subscribe(`plc.data.${PLC_PROJECT_ID}.valvePosition`);

  const processActuator = async (
    sub: ReturnType<NatsConnection["subscribe"]>,
    field: keyof TankInputs,
  ) => {
    for await (const msg of sub) {
      try {
        const data = JSON.parse(msg.string());
        const value =
          typeof data.value === "number" ? data.value : parseFloat(data.value);
        if (!isNaN(value)) {
          inputs[field] = value;
        }
      } catch {
        // Ignore malformed messages
      }
    }
  };

  processActuator(pumpSpeedSub, "pumpSpeed");
  processActuator(valvePosSub, "valvePosition");

  // Also subscribe to VFD write-backs (when PLC writes speed via Modbus → modbus-server → NATS)
  const vfdWriteSub = nc.subscribe(`${INSTRUMENTS.vfd}/speedCommand`);
  (async () => {
    for await (const msg of vfdWriteSub) {
      try {
        const value = parseFloat(msg.string());
        if (!isNaN(value)) {
          inputs.pumpSpeed = value;
        }
      } catch {
        // Ignore
      }
    }
  })();

  // Deadband filtering for sensor publishing
  const lastPublished: Record<string, number> = {};
  const DEADBAND = 0.05;

  function shouldPublish(key: string, value: number): boolean {
    if (!(key in lastPublished)) return true;
    return Math.abs(value - lastPublished[key]) > DEADBAND;
  }

  function publishIfChanged(
    sourceModuleId: string,
    variableId: string,
    value: number,
  ) {
    const key = `${sourceModuleId}.${variableId}`;
    const rounded = Math.round(value * 100) / 100;
    if (!shouldPublish(key, rounded)) return;
    lastPublished[key] = rounded;
    publishInstrumentValue(nc, encoder, sourceModuleId, variableId, rounded);
  }

  // Simulation loop
  const interval = setInterval(() => {
    state = tick(state, inputs, DEFAULT_CONFIG, TICK_MS);

    // ── Flow meter (Siemens MAG 8000) ──────────────────────────────────────
    publishIfChanged(INSTRUMENTS.flowMeter, "flowRate", state.inletFlow);
    publishIfChanged(INSTRUMENTS.flowMeter, "velocity", state.inletFlow * 0.4); // Simplified: GPM → mm/s
    publishIfChanged(INSTRUMENTS.flowMeter, "flowRatePercent", (state.inletFlow / DEFAULT_CONFIG.maxPumpFlow) * 100);

    // ── Level sensor (E+H FMP51) ───────────────────────────────────────────
    publishIfChanged(INSTRUMENTS.levelSensor, "level", state.tankLevel);
    publishIfChanged(INSTRUMENTS.levelSensor, "distance", (100 - state.tankLevel) * 30); // % → mm from top

    // ── VFD (ABB ACS580) ───────────────────────────────────────────────────
    const nominalRPM = 1500; // Typical 4-pole motor at 50Hz
    const actualRPM = (inputs.pumpSpeed / 100) * nominalRPM;
    const actualHz = (inputs.pumpSpeed / 100) * 50;
    publishIfChanged(INSTRUMENTS.vfd, "actualSpeed", actualRPM);
    publishIfChanged(INSTRUMENTS.vfd, "actualFrequency", actualHz);
    publishIfChanged(INSTRUMENTS.vfd, "motorCurrent", inputs.pumpSpeed * 0.15); // Simplified
    publishIfChanged(INSTRUMENTS.vfd, "motorTorque", inputs.pumpSpeed * 0.8);   // Simplified
  }, TICK_MS);

  log.info(`Simulation running at ${TICK_MS}ms tick rate`);
  log.info(`Subscribing to PLC outputs: ${PLC_PROJECT_ID}.data.*`);
  log.info(
    `Publishing to instruments: ${Object.values(INSTRUMENTS).join(", ")}`,
  );

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(interval);
    pumpSpeedSub.unsubscribe();
    valvePosSub.unsubscribe();
    vfdWriteSub.unsubscribe();
    await nc.drain();
    log.info("Shutdown complete");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  log.info("");
  log.info("Physics engine running. Press Ctrl+C to stop.");
  log.info("");
}

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  Deno.exit(1);
});
