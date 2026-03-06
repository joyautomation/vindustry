/**
 * Generic instrument entry point.
 *
 * Loads a profile YAML, registers with modbus-server, and bridges
 * physics engine values to Modbus registers.
 *
 * Environment variables:
 *   PROFILE          — Profile path relative to instruments/profiles/ (required)
 *   SOURCE_MODULE    — NATS source module ID (required)
 *   NATS_SERVERS     — NATS server URL(s) (default: nats://localhost:4222)
 *   PORT             — Modbus TCP port (default: 502)
 *   PHYSICS_PREFIX   — Physics engine topic prefix (default: SOURCE_MODULE)
 *   SUBSCRIBE_SUBJECT — NATS subject for modbus-server registration (default: modbus-server.subscribe)
 */

import { parse as parseYaml } from "@std/yaml";
import { resolve, dirname, fromFileUrl } from "@std/path";
import { startInstrument } from "./runtime.ts";
import type { InstrumentProfile } from "./types.ts";

const PROFILE = Deno.env.get("PROFILE");
const SOURCE_MODULE = Deno.env.get("SOURCE_MODULE");
const NATS_SERVERS = Deno.env.get("NATS_SERVERS") || "nats://localhost:4222";
const PORT = parseInt(Deno.env.get("PORT") || "502");
const PHYSICS_PREFIX = Deno.env.get("PHYSICS_PREFIX");
const SUBSCRIBE_SUBJECT = Deno.env.get("SUBSCRIBE_SUBJECT");

if (!PROFILE) {
  console.error("Error: PROFILE environment variable is required");
  console.error("  Example: PROFILE=flow-meters/siemens-sitrans-fm-mag8000");
  Deno.exit(1);
}

if (!SOURCE_MODULE) {
  console.error("Error: SOURCE_MODULE environment variable is required");
  console.error("  Example: SOURCE_MODULE=flow-meter");
  Deno.exit(1);
}

// Resolve profile path relative to instruments/profiles/
const instrumentsDir = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const profilePath = resolve(instrumentsDir, "profiles", `${PROFILE}.yaml`);

let profileContent: string;
try {
  profileContent = await Deno.readTextFile(profilePath);
} catch {
  console.error(`Error: Profile not found at ${profilePath}`);
  Deno.exit(1);
}

const profile = parseYaml(profileContent) as InstrumentProfile;

console.log("═══════════════════════════════════════════════════════════════");
console.log(`  ${profile.manufacturer} ${profile.model}`);
console.log(`  Vindustry Simulated Instrument`);
console.log("═══════════════════════════════════════════════════════════════");

const instance = await startInstrument({
  profile,
  sourceModuleId: SOURCE_MODULE,
  natsServers: NATS_SERVERS,
  port: PORT,
  physicsPrefix: PHYSICS_PREFIX,
  subscribeSubject: SUBSCRIBE_SUBJECT,
});

Deno.addSignalListener("SIGINT", async () => {
  await instance.stop();
  Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", async () => {
  await instance.stop();
  Deno.exit(0);
});
