/**
 * Vindustry Water Treatment PLC — Fieldbus Scenario
 *
 * A real tentacle-plc that reads from simulated field instruments via Modbus TCP.
 * Each instrument (flow meter, level sensor, VFD) runs in its own container
 * with its own IP address, just like real hardware.
 *
 * Sensor data flows through Modbus: instrument → tentacle-modbus scanner → NATS → PLC
 * Actuator commands flow through NATS bidirectional (v1 simplification)
 *
 * Environment variables:
 *   NATS_SERVERS       — NATS server URL(s) (default: nats://localhost:4222)
 *   PROJECT_ID         — PLC project ID (default: water-treatment)
 *   FLOW_METER_HOST    — Flow meter IP (default: 10.50.2.20)
 *   LEVEL_SENSOR_HOST  — Level sensor IP (default: 10.50.2.21)
 *   VFD_HOST           — VFD IP (default: 10.50.2.30)
 */

import {
  createPlc,
  createPlcLogger,
  modbusTag,
  type ModbusDevice,
  type PlcTask,
  type PlcVariableBooleanConfig,
  type PlcVariableNumberConfig,
} from "@tentacle/plc";

const log = createPlcLogger("water-treatment");

const PROJECT_ID = Deno.env.get("PROJECT_ID") || "water-treatment";
const FLOW_METER_HOST = Deno.env.get("FLOW_METER_HOST") || "10.50.2.20";
const LEVEL_SENSOR_HOST = Deno.env.get("LEVEL_SENSOR_HOST") || "10.50.2.21";
const VFD_HOST = Deno.env.get("VFD_HOST") || "10.50.2.30";

// =============================================================================
// Modbus Device Definitions (normally code-generated, hand-defined here)
// =============================================================================

// Siemens SITRANS F M MAG 8000 — Electromagnetic Flow Meter
// Register addresses per Siemens A5E03409989-AB (0-indexed: 4:3001 = address 3000)
const flowMeter = {
  id: "flow-meter",
  host: FLOW_METER_HOST,
  port: 502,
  unitId: 1,
  byteOrder: "ABCD",
  tags: {
    flowRate: {
      datatype: "number",
      address: 3002,
      functionCode: "holding",
      modbusDatatype: "float32",
      byteOrder: "ABCD",
    },
    velocity: {
      datatype: "number",
      address: 3000,
      functionCode: "holding",
      modbusDatatype: "float32",
      byteOrder: "ABCD",
    },
    totalizer1: {
      datatype: "number",
      address: 3017,
      functionCode: "holding",
      modbusDatatype: "float32",
      byteOrder: "ABCD",
    },
  },
} as const satisfies ModbusDevice;

// Endress+Hauser Levelflex FMP51 — Guided Wave Radar Level Transmitter
// Using ABCD register block (2000+) per BA01957FEN_0119
const levelSensor = {
  id: "level-sensor",
  host: LEVEL_SENSOR_HOST,
  port: 502,
  unitId: 1,
  byteOrder: "ABCD",
  tags: {
    level: {
      datatype: "number",
      address: 2002,
      functionCode: "holding",
      modbusDatatype: "float32",
      byteOrder: "ABCD",
    },
    distance: {
      datatype: "number",
      address: 2004,
      functionCode: "holding",
      modbusDatatype: "float32",
      byteOrder: "ABCD",
    },
  },
} as const satisfies ModbusDevice;

// ABB ACS580 — General Purpose VFD
// Register addresses per ABB 3AXD50000016097 Rev H
// INT16 values with FbEq32 scale factors (tentacle-modbus handles decoding)
const vfd = {
  id: "vfd",
  host: VFD_HOST,
  port: 502,
  unitId: 1,
  byteOrder: "ABCD",
  tags: {
    actualSpeed: {
      datatype: "number",
      address: 4,         // Fieldbus Act1 (default: motor speed)
      functionCode: "holding",
      modbusDatatype: "int16",
      byteOrder: "ABCD",
    },
    motorCurrent: {
      datatype: "number",
      address: 106,       // Parameter 01.07
      functionCode: "holding",
      modbusDatatype: "int16",
      byteOrder: "ABCD",
    },
    statusWord: {
      datatype: "number",
      address: 3,         // Fieldbus Status Word
      functionCode: "holding",
      modbusDatatype: "uint16",
      byteOrder: "ABCD",
    },
  },
} as const satisfies ModbusDevice;

// =============================================================================
// Variables
// =============================================================================

const variables = {
  // ── Sensor inputs (from instruments via Modbus TCP) ────────────────────────

  inletFlow: {
    id: "inletFlow",
    description: "Inlet flow rate from flow meter (GPM)",
    datatype: "number",
    default: 0,
    source: modbusTag(flowMeter, "flowRate", { scanRate: 500 }),
  } satisfies PlcVariableNumberConfig,

  tankLevel: {
    id: "tankLevel",
    description: "Tank level from level sensor (%)",
    datatype: "number",
    default: 50,
    source: modbusTag(levelSensor, "level", { scanRate: 500 }),
  } satisfies PlcVariableNumberConfig,

  pumpActualSpeed: {
    id: "pumpActualSpeed",
    description: "Actual pump speed from ABB ACS580 (raw INT16, scale 100=1RPM)",
    datatype: "number",
    default: 0,
    source: modbusTag(vfd, "actualSpeed", { scanRate: 500 }),
  } satisfies PlcVariableNumberConfig,

  motorCurrent: {
    id: "motorCurrent",
    description: "Motor current from ABB ACS580 (raw INT16, scale 100=1A)",
    datatype: "number",
    default: 0,
    source: modbusTag(vfd, "motorCurrent", { scanRate: 1000 }),
  } satisfies PlcVariableNumberConfig,

  vfdStatusWord: {
    id: "vfdStatusWord",
    description: "ABB ACS580 status word (bit-packed UINT16)",
    datatype: "number",
    default: 0,
    source: modbusTag(vfd, "statusWord", { scanRate: 1000 }),
  } satisfies PlcVariableNumberConfig,

  // ── Actuator outputs (PLC computes, bidirectional for now) ─────────────────

  pumpSpeed: {
    id: "pumpSpeed",
    description: "Pump speed command (%)",
    datatype: "number",
    default: 0,
    source: { bidirectional: true },
  } satisfies PlcVariableNumberConfig,

  valvePosition: {
    id: "valvePosition",
    description: "Outlet valve position (%)",
    datatype: "number",
    default: 50,
    source: { bidirectional: true },
  } satisfies PlcVariableNumberConfig,

  // ── Setpoints ──────────────────────────────────────────────────────────────

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
// Tasks
// =============================================================================

const tasks: Record<string, PlcTask<Variables>> = {
  levelControl: {
    name: "Level Control",
    description: "Proportional level control — adjusts pump speed based on level error",
    scanRate: 1000,
    program: (vars, updateVariable) => {
      const error =
        (vars.levelSetpoint.value as number) -
        (vars.tankLevel.value as number);

      const pumpCommand = Math.max(0, Math.min(100, 50 + error * 2));
      updateVariable("pumpSpeed", Math.round(pumpCommand * 100) / 100);
    },
  },

  alarms: {
    name: "Alarm Logic",
    description: "Evaluate level alarms",
    scanRate: 1000,
    program: (vars, updateVariable) => {
      updateVariable("highLevelAlarm", (vars.tankLevel.value as number) > 90);
      updateVariable("lowLevelAlarm", (vars.tankLevel.value as number) < 10);
    },
  },
};

// =============================================================================
// Run
// =============================================================================

async function main() {
  log.info("═══════════════════════════════════════════════════════════════");
  log.info("        Vindustry Water Treatment PLC (Fieldbus)");
  log.info("═══════════════════════════════════════════════════════════════");

  const natsServers = Deno.env.get("NATS_SERVERS") || "nats://localhost:4222";
  log.info(`NATS Servers:  ${natsServers}`);
  log.info(`Project ID:    ${PROJECT_ID}`);
  log.info(`Flow Meter:    ${FLOW_METER_HOST}:502`);
  log.info(`Level Sensor:  ${LEVEL_SENSOR_HOST}:502`);
  log.info(`VFD:           ${VFD_HOST}:502`);

  const plc = await createPlc({
    projectId: PROJECT_ID,
    variables,
    tasks,
    nats: { servers: natsServers },
  });

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
  log.info("PLC running. Reading instruments via Modbus TCP.");
  log.info("");
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(`Fatal error: ${err}`);
    Deno.exit(1);
  });
}
