/**
 * `vindustry status [vertical]` — Show running state of containers.
 */

import * as incus from "../incus.ts";
import { type Topology, containerName } from "../topology.ts";

export async function status(topology: Topology): Promise<void> {
  const { name, containers } = topology;

  console.log(`\nVertical: ${name}\n`);
  console.log(
    `  ${"CONTAINER".padEnd(30)} ${"STATUS".padEnd(10)} ${"IP ADDRESSES"}`,
  );
  console.log(`  ${"─".repeat(30)} ${"─".repeat(10)} ${"─".repeat(20)}`);

  const instances = await incus.getInstanceList();
  const instanceMap = new Map(instances.map((i) => [i.name, i]));

  for (const key of Object.keys(containers)) {
    const cn = containerName(name, key);
    const inst = instanceMap.get(cn);

    if (!inst) {
      console.log(`  ${cn.padEnd(30)} ${"NOT FOUND".padEnd(10)} -`);
      continue;
    }

    const ips = inst.ipv4.length > 0 ? inst.ipv4.join(", ") : "-";
    console.log(`  ${cn.padEnd(30)} ${inst.status.padEnd(10)} ${ips}`);
  }
  console.log("");
}
