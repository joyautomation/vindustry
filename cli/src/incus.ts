/**
 * Typed wrapper around the `incus` CLI.
 *
 * Uses Deno.Command to shell out to incus — reliable, zero deps,
 * handles auth/socket automatically. Subprocess overhead (~50-100ms)
 * is negligible for container orchestration operations.
 */

const decoder = new TextDecoder();

export class IncusError extends Error {
  constructor(
    public readonly command: string[],
    public readonly stderr: string,
    public readonly code: number,
  ) {
    super(`incus ${command.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
    this.name = "IncusError";
  }
}

async function run(
  args: string[],
  options?: { allowFailure?: boolean },
): Promise<string> {
  const command = new Deno.Command("incus", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = decoder.decode(stdout).trim();
  const err = decoder.decode(stderr).trim();

  if (code !== 0 && !options?.allowFailure) {
    throw new IncusError(args, err, code);
  }
  return out;
}

async function query<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const args = ["query", "--request", method, path];
  if (body !== undefined) {
    args.splice(3, 0, "--data", JSON.stringify(body));
  }
  const result = await run(args);
  return result ? JSON.parse(result) as T : undefined as unknown as T;
}

// =============================================================================
// Networks
// =============================================================================

export type NetworkConfig = {
  name: string;
  ipv4: string;
  description?: string;
};

export async function networkCreate(config: NetworkConfig): Promise<void> {
  await run([
    "network", "create", config.name,
    `ipv4.address=${config.ipv4.replace(/\.0\//, ".1/")}`,
    "ipv4.nat=true",
    "ipv6.address=none",
    ...(config.description
      ? ["--description", config.description]
      : []),
  ]);
}

export async function networkDelete(name: string): Promise<void> {
  await run(["network", "delete", name]);
}

export async function networkExists(name: string): Promise<boolean> {
  const result = await run(["network", "show", name], { allowFailure: true });
  return result !== "";
}

export async function networkList(): Promise<string[]> {
  const result = await query<string[]>("GET", "/1.0/networks?recursion=0");
  return result.map((url: string) => url.split("/").pop()!);
}

// =============================================================================
// Instances
// =============================================================================

export type InstanceState = "Running" | "Stopped" | "Error" | string;

export type InstanceInfo = {
  name: string;
  status: InstanceState;
  ipv4: string[];
  type: string;
};

export async function launch(
  name: string,
  image: string,
  options?: {
    network?: string;
    profile?: string;
    config?: Record<string, string>;
  },
): Promise<void> {
  const args = ["launch", image, name];
  if (options?.network) {
    args.push("--network", options.network);
  }
  if (options?.profile) {
    args.push("--profile", options.profile);
  }
  if (options?.config) {
    for (const [key, value] of Object.entries(options.config)) {
      args.push("--config", `${key}=${value}`);
    }
  }
  await run(args);
}

export async function start(name: string): Promise<void> {
  await run(["start", name]);
}

export async function restart(name: string): Promise<void> {
  await run(["restart", name]);
}

export async function stop(name: string): Promise<void> {
  await run(["stop", name], { allowFailure: true });
}

export async function deleteInstance(
  name: string,
  options?: { force?: boolean },
): Promise<void> {
  const args = ["delete", name];
  if (options?.force) args.push("--force");
  await run(args);
}

export async function instanceExists(name: string): Promise<boolean> {
  const result = await run(["info", name], { allowFailure: true });
  return result !== "";
}

export async function exec(
  name: string,
  command: string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  const args = ["exec", name];
  if (options?.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("--env", `${key}=${value}`);
    }
  }
  args.push("--");
  args.push(...command);
  return await run(args);
}

export async function filePush(
  name: string,
  localPath: string,
  remotePath: string,
  options?: { recursive?: boolean; createDirs?: boolean },
): Promise<void> {
  const args = ["file", "push", localPath, `${name}${remotePath}`];
  if (options?.recursive) args.push("-r");
  if (options?.createDirs) args.push("-p");
  await run(args);
}

export async function setDeviceNicAddress(
  name: string,
  device: string,
  ipv4Address: string,
): Promise<void> {
  await run([
    "config", "device", "set", name, device,
    `ipv4.address=${ipv4Address}`,
  ]);
}

export async function getInstanceList(
  filter?: string,
): Promise<InstanceInfo[]> {
  const result = await run([
    "list", "--format", "json",
    ...(filter ? [filter] : []),
  ]);
  if (!result) return [];
  const instances = JSON.parse(result) as Array<{
    name: string;
    status: string;
    type: string;
    state?: {
      network?: Record<
        string,
        { addresses?: Array<{ family: string; address: string }> }
      >;
    };
  }>;
  return instances.map((inst) => {
    const ipv4: string[] = [];
    if (inst.state?.network) {
      for (const nic of Object.values(inst.state.network)) {
        for (const addr of nic.addresses ?? []) {
          if (addr.family === "inet" && addr.address !== "127.0.0.1") {
            ipv4.push(addr.address);
          }
        }
      }
    }
    return {
      name: inst.name,
      status: inst.status,
      type: inst.type,
      ipv4,
    };
  });
}

export async function waitForReady(
  name: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await exec(name, ["systemctl", "is-system-running"]);
      const state = result.trim();
      if (state === "running" || state === "degraded") return;
    } catch {
      // Container not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Container ${name} did not become ready within ${timeoutMs}ms`);
}
