/**
 * `vindustry down <vertical>` — Tear down a vertical's containers and networks.
 */

import * as incus from "../incus.ts";
import {
  type Topology,
  containerName,
  networkName,
} from "../topology.ts";

function log(msg: string) {
  console.log(`  ${msg}`);
}

export async function down(topology: Topology): Promise<void> {
  const { name, networks, containers } = topology;

  // Stop and delete containers (reverse order)
  const keys = Object.keys(containers).reverse();

  console.log("\nStopping and deleting containers...");
  for (const key of keys) {
    const cn = containerName(name, key);
    if (!(await incus.instanceExists(cn))) {
      log(`${cn}: not found, skipping`);
      continue;
    }
    await incus.deleteInstance(cn, { force: true });
    log(`${cn}: deleted`);
  }

  // Delete networks
  if (Object.keys(networks).length > 0) {
    console.log("\nDeleting networks...");
    for (const netKey of Object.keys(networks)) {
      const nn = networkName(name, netKey);
      if (!(await incus.networkExists(nn))) {
        log(`${nn}: not found, skipping`);
        continue;
      }
      await incus.networkDelete(nn);
      log(`${nn}: deleted`);
    }
  }

  console.log(`\nVertical "${name}" is down.\n`);
}
