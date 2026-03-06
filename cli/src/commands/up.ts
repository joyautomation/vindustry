/**
 * `vindustry up <vertical>` — Bring up a vertical's containers.
 *
 * 1. Create networks (skip if exists)
 * 2. Launch containers in dependency order
 * 3. Wait for systemd ready
 * 4. Deploy sources
 * 5. Run setup commands
 * 6. Create and start systemd services
 */

import { basename } from "@std/path";
import * as incus from "../incus.ts";
import {
  type Topology,
  type RepoConfig,
  type ContainerSource,
  containerName,
  networkName,
  sortContainers,
  sortServices,
  resolveSourcePath,
} from "../topology.ts";

function log(msg: string) {
  console.log(`  ${msg}`);
}

function header(msg: string) {
  console.log(`\n${msg}`);
}

export async function up(
  topology: Topology,
  vindustryRoot: string,
  repoConfig: RepoConfig,
): Promise<void> {
  const { name, networks, containers } = topology;

  // ── Networks ──────────────────────────────────────────────────────────────
  if (Object.keys(networks).length > 0) {
    header("Creating networks...");
    for (const [netKey, netConfig] of Object.entries(networks)) {
      const nn = networkName(name, netKey);
      if (await incus.networkExists(nn)) {
        log(`${nn}: already exists, skipping`);
      } else {
        await incus.networkCreate({
          name: nn,
          ipv4: netConfig.ipv4,
          description: netConfig.description,
        });
        log(`${nn}: created (${netConfig.ipv4})`);
      }
    }
  }

  // ── Containers (in dependency order) ──────────────────────────────────────
  const order = sortContainers(containers);

  header("Launching containers...");
  for (const key of order) {
    const container = containers[key];
    const cn = containerName(name, key);

    if (await incus.instanceExists(cn)) {
      log(`${cn}: already exists, skipping`);
      continue;
    }

    const networkOpt = container.network
      ? networkName(name, container.network.name)
      : undefined;

    await incus.launch(cn, container.image, { network: networkOpt });

    if (container.network?.ipv4) {
      await incus.setDeviceNicAddress(cn, "eth0", container.network.ipv4);
      await incus.restart(cn);
    }

    log(
      `${cn}: launched${container.network?.ipv4 ? ` (${container.network.ipv4})` : ""}`,
    );
  }

  // ── Wait for ready ────────────────────────────────────────────────────────
  header("Waiting for containers to be ready...");
  await Promise.all(
    order.map(async (key) => {
      const cn = containerName(name, key);
      await incus.waitForReady(cn);
      log(`${cn}: ready`);
    }),
  );

  // ── Deploy sources ────────────────────────────────────────────────────────
  header("Deploying sources...");
  for (const key of order) {
    const container = containers[key];
    const cn = containerName(name, key);

    if (!container.sources || container.sources.length === 0) continue;

    let hasVindustrySource = false;

    for (const source of container.sources) {
      if (typeof source === "string") {
        // Vindustry-internal: deploy full workspace (needed for Deno workspace resolution)
        if (!hasVindustrySource) {
          hasVindustrySource = true;
          await deployVindustryWorkspace(cn, vindustryRoot);
          log(`${cn}: vindustry workspace deployed`);
        }
      } else {
        // External repo — try local override first, fall back to git clone
        const localPath = resolveSourcePath(source, vindustryRoot, repoConfig);
        const remotePath = `/opt/vindustry/`;

        if (localPath) {
          await incus.exec(cn, ["mkdir", "-p", remotePath]);
          await incus.filePush(cn, localPath + "/", remotePath, {
            recursive: true,
            createDirs: true,
          });
          log(`${cn}: ${source.path} deployed from local path`);
        } else {
          // Git clone into the container
          const ref = source.ref ?? "main";
          const cloneDir = `/tmp/vindustry-clone-${source.repo}`;
          log(`${cn}: cloning ${source.git} (${ref})...`);
          await incus.exec(cn, [
            "git", "clone", "--depth", "1", "--branch", ref,
            source.git, cloneDir,
          ]);
          // Copy the needed subdirectory (or whole repo if path is ".")
          const srcDir = source.path === "." ? cloneDir : `${cloneDir}/${source.path}`;
          const destName = source.path === "." ? source.repo : basename(source.path);
          await incus.exec(cn, ["mkdir", "-p", remotePath]);
          await incus.exec(cn, [
            "cp", "-r", srcDir, `${remotePath}${destName}`,
          ]);
          // Clean up clone
          await incus.exec(cn, ["rm", "-rf", cloneDir]);
          log(`${cn}: ${source.path} deployed from git`);
        }
      }
    }
  }

  // ── Setup commands ────────────────────────────────────────────────────────
  header("Running setup...");
  for (const key of order) {
    const container = containers[key];
    const cn = containerName(name, key);

    if (!container.setup || container.setup.length === 0) {
      log(`${cn}: no setup needed`);
      continue;
    }

    for (const cmd of container.setup) {
      log(`${cn}: $ ${cmd}`);
      await incus.exec(cn, ["bash", "-c", cmd]);
    }
    log(`${cn}: setup complete`);
  }

  // ── Start services ────────────────────────────────────────────────────────
  header("Starting services...");
  for (const key of order) {
    const container = containers[key];
    const cn = containerName(name, key);

    if (!container.services) continue;

    const serviceOrder = sortServices(container.services);

    for (const svcKey of serviceOrder) {
      const svc = container.services[svcKey];
      const serviceName = `vindustry-${svcKey}`;
      const workDir = svc.working_directory ?? "/root";

      // Write .env file if env vars are specified
      if (svc.env) {
        const envContent = Object.entries(svc.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n");
        await incus.exec(cn, ["mkdir", "-p", workDir]);
        await incus.exec(cn, [
          "bash",
          "-c",
          `cat > ${workDir}/.env << 'ENVEOF'\n${envContent}\nENVEOF`,
        ]);
      }

      // Build systemd unit
      const lines = [
        "[Unit]",
        `Description=Vindustry ${svcKey}`,
        "After=network.target",
      ];
      if (svc.after) {
        lines.push(`After=vindustry-${svc.after}.service`);
        lines.push(`Requires=vindustry-${svc.after}.service`);
      }
      lines.push(
        "",
        "[Service]",
        "Type=simple",
      );
      if (svc.env) {
        lines.push(`EnvironmentFile=${workDir}/.env`);
      }
      lines.push(
        `WorkingDirectory=${workDir}`,
        `ExecStart=${svc.run}`,
        "Restart=on-failure",
        "RestartSec=3",
        "Environment=HOME=/root",
        "Environment=PATH=/root/.deno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
      );

      const unitFile = lines.join("\n");
      await incus.exec(cn, [
        "bash",
        "-c",
        `cat > /etc/systemd/system/${serviceName}.service << 'UNIT'\n${unitFile}\nUNIT`,
      ]);
      await incus.exec(cn, ["systemctl", "daemon-reload"]);
      await incus.exec(cn, ["systemctl", "enable", "--now", serviceName]);
      log(`${cn}: ${serviceName} started`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  header("Vertical is up!\n");
  const instances = await incus.getInstanceList();
  const prefix = containerName(name, "");
  for (const inst of instances) {
    if (inst.name.startsWith(prefix)) {
      const ips = inst.ipv4.length > 0 ? inst.ipv4.join(", ") : "pending";
      console.log(
        `  ${inst.name.padEnd(30)} ${inst.status.padEnd(10)} ${ips}`,
      );
    }
  }
  console.log("");
}

/**
 * Deploy the full vindustry workspace into a container at /opt/vindustry/workspace.
 * This preserves Deno workspace member resolution.
 */
async function deployVindustryWorkspace(
  cn: string,
  vindustryRoot: string,
): Promise<void> {
  const remoteRoot = "/opt/vindustry/workspace";
  await incus.exec(cn, ["mkdir", "-p", remoteRoot]);

  // Push root deno.json
  const rootDeno = `${vindustryRoot}/deno.json`;
  try {
    await Deno.stat(rootDeno);
    await incus.filePush(cn, rootDeno, `${remoteRoot}/deno.json`, {
      createDirs: true,
    });
  } catch {
    // No root deno.json
  }

  // Push each workspace member
  const rootConfig = JSON.parse(
    await Deno.readTextFile(`${vindustryRoot}/deno.json`),
  );
  for (const member of rootConfig.workspace ?? []) {
    const memberPath = `${vindustryRoot}/${member}`;
    const memberParent = member.includes("/")
      ? `${remoteRoot}/${member.split("/").slice(0, -1).join("/")}/`
      : `${remoteRoot}/`;
    try {
      await Deno.stat(memberPath);
      await incus.exec(cn, ["mkdir", "-p", memberParent]);
      await incus.filePush(cn, memberPath + "/", memberParent, {
        recursive: true,
        createDirs: true,
      });
    } catch {
      // Member doesn't exist, skip
    }
  }
}
