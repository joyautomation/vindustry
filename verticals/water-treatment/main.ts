/**
 * Vindustry Water Treatment Vertical — Black-Box PLC Simulation
 *
 * A tentacle-plc program that simulates a complete water treatment clearwell:
 * physics, control logic, and alarms all run inside PLC tasks.
 *
 * The physics task (100ms) computes sensor values from actuator commands.
 * The control task (1s) adjusts pump speed based on level error.
 * The alarm task (1s) evaluates high/low level conditions.
 *
 * External software connects via Modbus TCP (through tentacle-modbus-server)
 * and sees what looks like a real PLC with a process attached.
 *
 * Environment variables:
 *   NATS_SERVERS — NATS server URL(s), comma-separated (default: nats://localhost:4222)
 *   PROJECT_ID   — PLC project ID (default: water-treatment)
 */

import {
  createPlc,
  createPlcLogger,
  type PlcTask,
  type PlcVariableBooleanConfig,
  type PlcVariableNumberConfig,
} from "@tentacle/plc";
import { connect } from "@nats-io/transport-deno";
import {
  tick,
  createInitialState,
  DEFAULT_CONFIG,
  type TankState,
} from "@vindustry/water-tank";

const log = createPlcLogger("water-treatment");

const PROJECT_ID = Deno.env.get("PROJECT_ID") || "water-treatment";

// =============================================================================
// Variables
// =============================================================================

const variables = {
  // ── Sensor values (computed by physics task) ────────────────────────────────

  tankLevel: {
    id: "tankLevel",
    description: "Clearwell tank level (%)",
    datatype: "number",
    default: 50,
    deadband: { value: 0.1, maxTime: 5000 },
  } satisfies PlcVariableNumberConfig,

  inletFlow: {
    id: "inletFlow",
    description: "Inlet flow rate (GPM)",
    datatype: "number",
    default: 0,
    deadband: { value: 0.5, maxTime: 5000 },
  } satisfies PlcVariableNumberConfig,

  outletFlow: {
    id: "outletFlow",
    description: "Outlet flow rate (GPM)",
    datatype: "number",
    default: 0,
    deadband: { value: 0.5, maxTime: 5000 },
  } satisfies PlcVariableNumberConfig,

  pumpPressure: {
    id: "pumpPressure",
    description: "Pump discharge pressure (PSI)",
    datatype: "number",
    default: 0,
    deadband: { value: 0.1, maxTime: 5000 },
  } satisfies PlcVariableNumberConfig,

  // ── Actuator outputs (control logic computes, Modbus can override) ─────────

  pumpSpeed: {
    id: "pumpSpeed",
    description: "Inlet pump speed command (%)",
    datatype: "number",
    default: 0,
    source: { bidirectional: true },
  } satisfies PlcVariableNumberConfig,

  valvePosition: {
    id: "valvePosition",
    description: "Outlet valve position command (%)",
    datatype: "number",
    default: 50,
    source: { bidirectional: true },
  } satisfies PlcVariableNumberConfig,

  // ── Setpoints (writable from SCADA/Modbus) ──────────────────────────────────

  levelSetpoint: {
    id: "levelSetpoint",
    description: "Tank level setpoint (%)",
    datatype: "number",
    default: 65,
    source: { bidirectional: true },
  } satisfies PlcVariableNumberConfig,

  // ── Alarms ──────────────────────────────────────────────────────────────────

  highLevelAlarm: {
    id: "highLevelAlarm",
    description: "High tank level alarm (>90%)",
    datatype: "boolean",
    default: false,
  } satisfies PlcVariableBooleanConfig,

  lowLevelAlarm: {
    id: "lowLevelAlarm",
    description: "Low tank level alarm (<10%)",
    datatype: "boolean",
    default: false,
  } satisfies PlcVariableBooleanConfig,
};

type Variables = typeof variables;

// =============================================================================
// Physics state (persists across task invocations via closure)
// =============================================================================

let physicsState: TankState = createInitialState(50);

// =============================================================================
// Tasks
// =============================================================================

const tasks: Record<string, PlcTask<Variables>> = {
  physicsTick: {
    name: "Physics Simulation",
    description:
      "Water tank ODE — computes sensor values from actuator commands at 100ms",
    scanRate: 100,
    program: (vars, updateVariable) => {
      physicsState = tick(
        physicsState,
        {
          pumpSpeed: vars.pumpSpeed.value as number,
          valvePosition: vars.valvePosition.value as number,
        },
        DEFAULT_CONFIG,
        100,
      );

      updateVariable(
        "tankLevel",
        Math.round(physicsState.tankLevel * 100) / 100,
      );
      updateVariable(
        "inletFlow",
        Math.round(physicsState.inletFlow * 100) / 100,
      );
      updateVariable(
        "outletFlow",
        Math.round(physicsState.outletFlow * 100) / 100,
      );
      updateVariable(
        "pumpPressure",
        Math.round(physicsState.pumpPressure * 100) / 100,
      );
    },
  },

  levelControl: {
    name: "Level Control",
    description:
      "Proportional level control — adjusts pump speed based on level error",
    scanRate: 1000,
    program: (vars, updateVariable) => {
      const error =
        (vars.levelSetpoint.value as number) -
        (vars.tankLevel.value as number);

      // Proportional control: Kp=2, bias=50%
      const pumpCommand = Math.max(0, Math.min(100, 50 + error * 2));
      updateVariable("pumpSpeed", Math.round(pumpCommand * 100) / 100);
    },
  },

  alarms: {
    name: "Alarm Logic",
    description: "Evaluate level alarms",
    scanRate: 1000,
    program: (vars, updateVariable) => {
      updateVariable(
        "highLevelAlarm",
        (vars.tankLevel.value as number) > 90,
      );
      updateVariable(
        "lowLevelAlarm",
        (vars.tankLevel.value as number) < 10,
      );
    },
  },
};

// =============================================================================
// Modbus Server Registration
// =============================================================================

/**
 * Register variables with tentacle-modbus-server for external access.
 * Uses its own NATS connection since tentacle-plc doesn't expose the internal one.
 * Retries until the modbus server is available.
 */
async function registerModbusServer(
  natsServers: string,
  projectId: string,
): Promise<void> {
  const encoder = new TextEncoder();

  const modbusConfig = {
    deviceId: "water-treatment-plc",
    port: 5020, // Non-privileged port for development
    unitId: 1,
    subscriberId: projectId,
    sourceModuleId: projectId,
    tags: [
      // Sensor values — read-only holding registers (float32 = 2 registers each)
      {
        variableId: "tankLevel",
        address: 0,
        functionCode: "holding",
        datatype: "float32",
      },
      {
        variableId: "inletFlow",
        address: 2,
        functionCode: "holding",
        datatype: "float32",
      },
      {
        variableId: "outletFlow",
        address: 4,
        functionCode: "holding",
        datatype: "float32",
      },
      {
        variableId: "pumpPressure",
        address: 6,
        functionCode: "holding",
        datatype: "float32",
      },
      // Actuator outputs — writable holding registers
      {
        variableId: "pumpSpeed",
        address: 8,
        functionCode: "holding",
        datatype: "float32",
        writable: true,
      },
      {
        variableId: "valvePosition",
        address: 10,
        functionCode: "holding",
        datatype: "float32",
        writable: true,
      },
      // Setpoint — writable
      {
        variableId: "levelSetpoint",
        address: 12,
        functionCode: "holding",
        datatype: "float32",
        writable: true,
      },
      // Alarms — read-only coils
      {
        variableId: "highLevelAlarm",
        address: 0,
        functionCode: "coil",
        datatype: "boolean",
      },
      {
        variableId: "lowLevelAlarm",
        address: 1,
        functionCode: "coil",
        datatype: "boolean",
      },
    ],
  };

  const retryModbusRegistration = async () => {
    const nc = await connect({ servers: natsServers });
    while (true) {
      try {
        const response = await nc.request(
          "modbus-server.subscribe",
          encoder.encode(JSON.stringify(modbusConfig)),
          { timeout: 5000 },
        );
        const result = JSON.parse(response.string());
        if (result.success) {
          log.info(`Modbus server registered on port ${result.port}`);
          await nc.drain();
          return;
        }
        log.warn(
          `Modbus server registration failed: ${JSON.stringify(result)}`,
        );
      } catch {
        log.info("Modbus server not available yet, retrying in 10s...");
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  };

  // Fire-and-forget: retry in the background so PLC starts immediately
  retryModbusRegistration();
}

// =============================================================================
// Run
// =============================================================================

async function main() {
  log.info("═══════════════════════════════════════════════════════════════");
  log.info("        Vindustry Water Treatment PLC");
  log.info("═══════════════════════════════════════════════════════════════");

  const natsServers =
    Deno.env.get("NATS_SERVERS") || "nats://localhost:4222";
  log.info(`NATS Servers: ${natsServers}`);
  log.info(`Project ID:   ${PROJECT_ID}`);

  const plc = await createPlc({
    projectId: PROJECT_ID,
    variables,
    tasks,
    nats: { servers: natsServers },
  });

  // Register with modbus server (non-blocking, retries in background)
  registerModbusServer(natsServers, PROJECT_ID);

  Deno.addSignalListener("SIGINT", async () => {
    log.info("Shutting down...");
    await plc.stop();
    Deno.exit(0);
  });

  Deno.addSignalListener("SIGTERM", async () => {
    log.info("Shutting down...");
    await plc.stop();
    Deno.exit(0);
  });

  log.info("");
  log.info("Water treatment PLC running. Press Ctrl+C to stop.");
  log.info("  Physics:  100ms scan rate");
  log.info("  Control:  1000ms scan rate");
  log.info("  Alarms:   1000ms scan rate");
  log.info("");
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(`Fatal error: ${err}`);
    Deno.exit(1);
  });
}
