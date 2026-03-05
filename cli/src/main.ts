/**
 * Vindustry CLI — Deploy and manage virtual industrial systems.
 *
 * Usage:
 *   vindustry up <vertical>        Launch a vertical
 *   vindustry down <vertical>      Tear down a vertical
 *   vindustry status <vertical>    Show container status
 */

import { resolve, dirname, fromFileUrl } from "@std/path";
import { loadTopology, loadRepoConfig } from "./topology.ts";
import { up } from "./commands/up.ts";
import { down } from "./commands/down.ts";
import { status } from "./commands/status.ts";

const USAGE = `
vindustry — Deploy and manage virtual industrial systems

Usage:
  vindustry up <vertical>        Launch a vertical's containers
  vindustry down <vertical>      Tear down a vertical
  vindustry status <vertical>    Show container status

Examples:
  vindustry up water-treatment
  vindustry down water-treatment
  vindustry status water-treatment
`.trim();

function findVindustryRoot(): string {
  // Walk up from CWD looking for root deno.json with "workspace" key
  let dir = Deno.cwd();
  while (true) {
    try {
      const content = Deno.readTextFileSync(resolve(dir, "deno.json"));
      const json = JSON.parse(content);
      if (json.workspace) return dir;
    } catch {
      // Not found, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume we're in the cli/ directory
  return resolve(Deno.cwd(), "..");
}

function resolveVerticalPath(vindustryRoot: string, vertical: string): string {
  // Try verticals/<name> first, then check if it's a direct path
  const verticalDir = resolve(vindustryRoot, "verticals", vertical);
  try {
    Deno.statSync(resolve(verticalDir, "topology.yaml"));
    return verticalDir;
  } catch {
    throw new Error(
      `Vertical "${vertical}" not found. Expected topology.yaml at ${verticalDir}/topology.yaml`,
    );
  }
}

async function main() {
  const args = Deno.args;

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    Deno.exit(0);
  }

  const command = args[0];
  const vertical = args[1];

  if (!vertical) {
    console.error(`Error: missing <vertical> argument\n`);
    console.log(USAGE);
    Deno.exit(1);
  }

  const vindustryRoot = findVindustryRoot();
  const verticalPath = resolveVerticalPath(vindustryRoot, vertical);
  const topology = await loadTopology(verticalPath);
  const repoConfig = await loadRepoConfig(vindustryRoot);

  switch (command) {
    case "up":
      console.log(`Bringing up "${topology.name}"...`);
      await up(topology, vindustryRoot, repoConfig);
      break;

    case "down":
      console.log(`Tearing down "${topology.name}"...`);
      await down(topology);
      break;

    case "status":
      await status(topology);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      Deno.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  Deno.exit(1);
});
