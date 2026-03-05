/**
 * Generic instrument runtime.
 *
 * Loads a YAML profile, registers with tentacle-modbus-server, and bridges
 * physics engine values to Modbus registers with proper scaling and transforms.
 *
 * Long-running process: one per instrument container.
 */

import { connect, type NatsConnection } from "@nats-io/transport-deno";
import { createLogger, LogLevel } from "@joyautomation/coral";
import type {
  InstrumentProfile,
  RegisterDefinition,
  ModbusSubscribeRequest,
  ComputedState,
} from "./types.ts";

const log = createLogger("instrument", LogLevel.info);

export type InstrumentConfig = {
  profile: InstrumentProfile;
  sourceModuleId: string; // NATS identity (e.g., "flow-meter")
  natsServers: string;
  port?: number; // Modbus TCP port (default: 502)
  physicsPrefix?: string; // Physics engine topic prefix (default: sourceModuleId)
};

export type InstrumentInstance = {
  stop: () => Promise<void>;
};

/**
 * Build the modbus-server subscribe request from a profile.
 */
function buildSubscribeRequest(
  config: InstrumentConfig,
): ModbusSubscribeRequest {
  const { profile, sourceModuleId } = config;
  return {
    deviceId: sourceModuleId,
    port: config.port ?? 502,
    unitId: profile.modbus.unitId,
    subscriberId: sourceModuleId,
    sourceModuleId,
    tags: profile.modbus.registers.map((reg) => ({
      variableId: reg.name,
      address: reg.address,
      functionCode: reg.functionCode,
      datatype: reg.datatype,
      byteOrder: reg.byteOrder ?? profile.modbus.byteOrder,
      ...(reg.writable ? { writable: true } : {}),
    })),
  };
}

/**
 * Apply scaling: convert engineering value to raw register value.
 */
function applyScale(value: number, reg: RegisterDefinition): number {
  const offset = reg.offset ?? 0;
  const scale = reg.scale ?? 1;
  return (value + offset) * scale;
}

/**
 * Start the instrument runtime.
 */
export async function startInstrument(
  config: InstrumentConfig,
): Promise<InstrumentInstance> {
  const { profile, sourceModuleId, natsServers } = config;
  const physicsPrefix = config.physicsPrefix ?? sourceModuleId;
  const encoder = new TextEncoder();

  log.info(`Instrument: ${profile.manufacturer} ${profile.model}`);
  log.info(`Type: ${profile.type}, Protocol: ${profile.protocol}`);
  log.info(`Source module: ${sourceModuleId}`);

  // Connect to NATS
  const servers = natsServers.split(",").map((s) => s.trim());
  let nc: NatsConnection;
  while (true) {
    try {
      nc = await connect({ servers });
      log.info("Connected to NATS");
      break;
    } catch (err) {
      log.warn(`NATS connection failed: ${err}. Retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Register with modbus-server (retry until available)
  const subscribeReq = buildSubscribeRequest(config);
  while (true) {
    try {
      const response = await nc.request(
        "modbus-server.subscribe",
        encoder.encode(JSON.stringify(subscribeReq)),
        { timeout: 5000 },
      );
      const result = JSON.parse(response.string());
      if (result.success) {
        log.info(`Registered with modbus-server on port ${result.port}`);
        break;
      }
      log.warn(`Registration failed: ${JSON.stringify(result)}`);
    } catch {
      log.info("Modbus server not ready, retrying in 5s...");
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Computed state for totalizers, status words, etc.
  const computed: ComputedState = {
    accumulator: {},
    lastTick: Date.now(),
  };

  // Track latest physics values for computed registers
  const physicsValues: Record<string, number> = {};

  // Publish a register value to NATS (modbus-server picks this up)
  function publishRegister(name: string, value: number) {
    const msg = JSON.stringify({
      variableId: name,
      value,
      timestamp: Date.now(),
    });
    nc.publish(
      `${sourceModuleId}.data.${name}`,
      encoder.encode(msg),
    );
  }

  // Subscribe to physics engine topics for mapped registers
  const physicsRegisters = profile.modbus.registers.filter(
    (r) => r.physics && !r.writable,
  );

  const subscriptions: ReturnType<NatsConnection["subscribe"]>[] = [];

  for (const reg of physicsRegisters) {
    // Subscribe to the physics value using the physics variable name
    const topic = `${physicsPrefix}.data.${reg.physics}`;
    const sub = nc.subscribe(topic);
    subscriptions.push(sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const data = JSON.parse(msg.string());
          const raw =
            typeof data.value === "number"
              ? data.value
              : parseFloat(data.value);
          if (isNaN(raw)) continue;

          physicsValues[reg.physics!] = raw;
          const scaled = applyScale(raw, reg);
          publishRegister(reg.name, scaled);
        } catch {
          // Ignore malformed messages
        }
      }
    })();
  }

  // Publish default values for static registers
  for (const reg of profile.modbus.registers) {
    if (reg.default !== undefined && !reg.physics && !reg.computed) {
      publishRegister(reg.name, reg.default);
    }
  }

  // Computed register tick (for totalizers, status words, etc.)
  const computedRegisters = profile.modbus.registers.filter((r) => r.computed);
  let computedInterval: ReturnType<typeof setInterval> | undefined;

  if (computedRegisters.length > 0) {
    computedInterval = setInterval(() => {
      const now = Date.now();
      const dtMinutes = (now - computed.lastTick) / 60_000;
      computed.lastTick = now;

      for (const reg of computedRegisters) {
        if (reg.computed === "accumulate" && reg.physics) {
          const flowValue = physicsValues[reg.physics] ?? 0;
          computed.accumulator[reg.name] =
            (computed.accumulator[reg.name] ?? 0) + flowValue * dtMinutes;
          publishRegister(
            reg.name,
            applyScale(computed.accumulator[reg.name], reg),
          );
        } else if (reg.computed === "statusWord") {
          // Simulate a healthy, running instrument
          // ABB ACS580: bits 0-2 = ready, bit 8 = at setpoint, bit 9 = remote
          publishRegister(reg.name, reg.default ?? 0x0307);
        }
      }
    }, 1000);
  }

  // Handle write-backs (for writable registers like VFD speed command)
  const writableRegisters = profile.modbus.registers.filter((r) => r.writable);
  for (const reg of writableRegisters) {
    const topic = `${sourceModuleId}/${reg.name}`;
    const sub = nc.subscribe(topic);
    subscriptions.push(sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const raw = parseFloat(msg.string());
          if (isNaN(raw)) continue;

          // Reverse scale and forward to physics engine
          if (reg.physics) {
            const scale = reg.scale ?? 1;
            const offset = reg.offset ?? 0;
            const engineering = raw / scale - offset;
            const physicsTopic = `${physicsPrefix}/${reg.physics}`;
            nc.publish(physicsTopic, encoder.encode(String(engineering)));
          }
        } catch {
          // Ignore
        }
      }
    })();
  }

  log.info(
    `Bridging ${physicsRegisters.length} physics values, ` +
      `${computedRegisters.length} computed, ` +
      `${writableRegisters.length} writable`,
  );
  log.info("Instrument runtime running.");

  async function stop() {
    log.info("Shutting down...");
    if (computedInterval) clearInterval(computedInterval);
    for (const sub of subscriptions) sub.unsubscribe();
    await nc.drain();
    log.info("Shutdown complete");
  }

  return { stop };
}
