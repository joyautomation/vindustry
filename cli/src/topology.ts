/**
 * Topology YAML parser and types.
 *
 * Each vertical defines a topology.yaml that describes the containers,
 * networks, and services needed to run the simulation.
 */

import { parse as parseYaml } from "@std/yaml";
import { resolve } from "@std/path";

// =============================================================================
// Types
// =============================================================================

export type TopologyNetwork = {
  ipv4: string;
  description?: string;
};

export type ContainerSource =
  | string // Relative path within vindustry repo (e.g., "verticals/water-treatment")
  | {
      repo: string;
      path: string;
      git: string; // Git clone URL (used when no local override in .vindustry.yaml)
      ref?: string; // Branch or tag (default: "main")
    };

export type ContainerNetworkConfig = {
  name: string;
  ipv4: string;
};

export type ContainerService = {
  run: string;
  working_directory?: string;
  env?: Record<string, string>;
  after?: string;
};

export type TopologyContainer = {
  image: string;
  network?: ContainerNetworkConfig;
  depends_on?: string[];
  setup?: string[];
  sources?: ContainerSource[];
  services?: Record<string, ContainerService>;
};

export type Topology = {
  name: string;
  description?: string;
  networks: Record<string, TopologyNetwork>;
  containers: Record<string, TopologyContainer>;
};

export type RepoConfig = {
  repos?: Record<string, string>;
};

// =============================================================================
// Container naming — prefix with "vind-{shortName}-" to avoid collisions
// =============================================================================

const VERTICAL_SHORT_NAMES: Record<string, string> = {
  "water-treatment": "wt",
  "water-treatment-fieldbus": "wtf",
};

function shortName(verticalName: string): string {
  return VERTICAL_SHORT_NAMES[verticalName] ?? verticalName.slice(0, 4);
}

export function containerName(
  verticalName: string,
  container: string,
): string {
  return `vind-${shortName(verticalName)}-${container}`;
}

export function networkName(
  verticalName: string,
  network: string,
): string {
  return `vind-${shortName(verticalName)}-${network}`;
}

// =============================================================================
// Parsing
// =============================================================================

export async function loadTopology(verticalPath: string): Promise<Topology> {
  const yamlPath = resolve(verticalPath, "topology.yaml");
  const content = await Deno.readTextFile(yamlPath);
  const raw = parseYaml(content) as Topology;

  if (!raw.name) throw new Error(`topology.yaml missing 'name' field`);
  if (!raw.containers || Object.keys(raw.containers).length === 0) {
    throw new Error(`topology.yaml has no containers defined`);
  }
  raw.networks ??= {};

  return raw;
}

export async function loadRepoConfig(
  vindustryRoot: string,
): Promise<RepoConfig> {
  const configPath = resolve(vindustryRoot, ".vindustry.yaml");
  try {
    const content = await Deno.readTextFile(configPath);
    return (parseYaml(content) as RepoConfig) ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolve a container's source path to an absolute local directory,
 * or null if no local override exists (caller should git clone instead).
 */
export function resolveSourcePath(
  source: ContainerSource,
  vindustryRoot: string,
  repoConfig: RepoConfig,
): string | null {
  if (typeof source === "string") {
    return resolve(vindustryRoot, source);
  }
  const repoPath = repoConfig.repos?.[source.repo];
  if (!repoPath) {
    return null; // No local override — caller should git clone
  }
  return resolve(repoPath, source.path);
}

/**
 * Sort containers by dependency order (topological sort).
 */
export function sortContainers(
  containers: Record<string, TopologyContainer>,
): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular dependency detected involving "${name}"`);
    }
    visiting.add(name);
    const deps = containers[name]?.depends_on ?? [];
    for (const dep of deps) {
      if (!containers[dep]) {
        throw new Error(
          `Container "${name}" depends on unknown container "${dep}"`,
        );
      }
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const name of Object.keys(containers)) {
    visit(name);
  }
  return sorted;
}

/**
 * Sort services within a container by `after` dependencies.
 */
export function sortServices(
  services: Record<string, ContainerService>,
): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular service dependency involving "${name}"`);
    }
    visiting.add(name);
    const after = services[name]?.after;
    if (after) {
      if (!services[after]) {
        throw new Error(
          `Service "${name}" depends on unknown service "${after}"`,
        );
      }
      visit(after);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const name of Object.keys(services)) {
    visit(name);
  }
  return sorted;
}
