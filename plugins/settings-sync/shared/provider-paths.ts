export type ProviderMap = Record<string, Record<string, unknown>>;
export type ProjectionOptions = { home?: string };
export const HOME_PATH_PREFIX = "@paseo-home:";
export const PROFILE_PATH_PREFIX = "@paseo-profile:";
export const MACHINE_ENV_PREFIX = "@paseo-env:";
export const machineEnvironmentKeys: readonly string[] = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
];
export const vendorCommands: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  cursor: "cursor-agent",
  kimi: "kimi",
  kiro: "kiro-cli",
  trae: "trae-cli",
};
const profileKeys: Readonly<Record<string, readonly string[]>> = {
  claude: ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
  codex: ["CODEX_HOME"],
  cursor: ["APPDATA", "XDG_CONFIG_HOME"],
  pi: ["PI_CODING_AGENT_DIR"],
  opencode: ["XDG_DATA_HOME"],
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asProviders(value: unknown): ProviderMap {
  if (!object(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, entry]) =>
      object(entry) ? [[id, entry]] : [],
    ),
  );
}

export function providerFamily(
  id: string,
  providers: ProviderMap,
): string | null {
  const visited = new Set<string>();
  let current = id;
  while (!visited.has(current)) {
    visited.add(current);
    if (providers[current]?.extends === "acp") {
      const command = providers[current]?.command;
      return Array.isArray(command) &&
        typeof command[0] === "string" &&
        /^cursor-agent(?:\.(?:exe|cmd|bat|ps1))?$/i.test(
          command[0].replaceAll("\\", "/").split("/").at(-1)!,
        )
        ? "cursor"
        : null;
    }
    if (current in vendorCommands) return current;
    const parent = providers[current]?.extends;
    if (typeof parent !== "string") return null;
    current = parent;
  }
  return null;
}

export function profileEnvironmentKeys(
  family: string | null,
): readonly string[] {
  return family ? (profileKeys[family] ?? []) : [];
}

export function profileDirectorySuffix(
  family: string | null,
  key: string,
): string {
  return family === "cursor"
    ? key === "APPDATA"
      ? "roaming"
      : key === "XDG_CONFIG_HOME"
        ? "config"
        : ""
    : family === "opencode" && key === "XDG_DATA_HOME"
      ? "data"
      : "";
}

export function profilePathToken(providerId: string, key: string): string {
  return `${PROFILE_PATH_PREFIX}${encodeURIComponent(providerId)}:${key}`;
}

function slashes(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}
function windows(value: string) {
  return /^[a-z]:\//i.test(value) || value.startsWith("//");
}

export function isAbsolutePath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(value);
}

export function portableHomePath(
  value: string,
  options: ProjectionOptions = {},
): string {
  if (
    value.startsWith(HOME_PATH_PREFIX) ||
    value.startsWith(PROFILE_PATH_PREFIX)
  )
    return value;
  if (!isAbsolutePath(value) || /[\r\n\u0000;]/.test(value)) return value;
  const normalized = slashes(value);
  const inferred = normalized.match(
    /^([a-z]:\/Users\/[^/]+|\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/i,
  )?.[1];
  const home = options.home ? slashes(options.home) : inferred;
  if (!home) return value;
  const insensitive = windows(home);
  const candidate = insensitive ? normalized.toLowerCase() : normalized;
  const prefix = insensitive ? home.toLowerCase() : home;
  if (candidate !== prefix && !candidate.startsWith(`${prefix}/`)) return value;
  const relative = normalized.slice(home.length).replace(/^\//, "");
  if (relative.split("/").some((part) => part === ".." || part === "."))
    return value;
  return `${HOME_PATH_PREFIX}${relative}`;
}

/** Aster owns this host-local transport; the embedded native command never travels to another OS. */
export function managedCodexCommand(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[1] !== "string" ||
    !/\/server\/codex-proxy\.mjs$/.test(slashes(value[1])) ||
    typeof value[2] !== "string"
  )
    return null;
  try {
    const original: unknown = JSON.parse(value[2]);
    return Array.isArray(original) &&
      original.length > 0 &&
      original.every((entry) => typeof entry === "string" && entry.length > 0)
      ? original
      : null;
  } catch {
    return null;
  }
}

export function standardVendorCommand(
  value: unknown,
  family: string | null,
): string[] | null {
  if (
    !family ||
    !Array.isArray(value) ||
    !value.length ||
    value.some((entry) => typeof entry !== "string")
  )
    return null;
  if (family === "codex" && managedCodexCommand(value)) return ["codex"];
  const command = vendorCommands[family];
  const first = slashes(value[0]);
  if (
    /^node(?:\.exe)?$/i.test(first.split("/").at(-1)!) &&
    typeof value[1] === "string"
  ) {
    const script = slashes(value[1]).toLowerCase();
    const npmEntrypoints: Readonly<Record<string, RegExp>> = {
      claude: /\/node_modules\/@anthropic-ai\/claude-code\/cli\.js$/,
      codex: /\/node_modules\/@openai\/codex\/bin\/codex\.js$/,
    };
    if (npmEntrypoints[family]?.test(script))
      return [command, ...value.slice(2)];
  }
  const base = first
    .split("/")
    .at(-1)!
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  if (base.toLowerCase() !== command.toLowerCase()) return null;
  if (first.includes("/")) {
    if (!isAbsolutePath(first)) return null;
    const directory = first.slice(0, first.lastIndexOf("/")).toLowerCase();
    const standard =
      /(?:\/\.local\/bin|\/\.npm-global\/bin|\/\.volta\/bin|\/\.asdf\/shims|\/scoop\/shims|\/appdata\/roaming\/npm|\/appdata\/local\/microsoft\/winget\/links|\/program files(?: \(x86\))?\/nodejs)$/.test(
        directory,
      ) ||
      /^(?:\/usr\/bin|\/usr\/local\/bin|\/opt\/homebrew\/bin)$/.test(
        directory,
      ) ||
      /\/\.nvm\/versions\/node\/v[^/]+\/bin$/.test(directory) ||
      (family === "claude" &&
        /\/node_modules\/@anthropic-ai\/claude-code\/bin$/.test(directory)) ||
      (family === "cursor" &&
        /\/appdata\/local\/cursor-agent$/.test(directory)) ||
      (family === "codex" &&
        /\/settings-sync\/tools\/codex-rust-v[0-9][a-z0-9._-]*-(?:win32|linux|darwin)-(?:x64|arm64)(?:\/[^/]+)*$/.test(
          directory,
        ));
    if (!standard) return null;
  }
  return [command, ...value.slice(1)];
}

export function projectProviders(
  value: unknown,
  options: ProjectionOptions = {},
): ProviderMap {
  const providers = asProviders(value);
  return Object.fromEntries(
    Object.entries(providers).map(([id, provider]) => {
      const family = providerFamily(id, providers);
      const command = standardVendorCommand(provider.command, family);
      const projected: Record<string, unknown> = {
        ...provider,
        ...(command
          ? {
              command: [
                command[0],
                ...command
                  .slice(1)
                  .map((entry) => portableHomePath(entry, options)),
              ],
            }
          : {}),
      };
      if (object(provider.env)) {
        const keys = profileEnvironmentKeys(family);
        projected.env = Object.fromEntries(
          Object.entries(provider.env).map(([key, entry]) => [
            key,
            typeof entry !== "string"
              ? entry
              : keys.includes(key)
                ? entry.startsWith(PROFILE_PATH_PREFIX)
                  ? entry
                  : profilePathToken(id, key)
                : machineEnvironmentKeys.includes(key.toUpperCase())
                  ? `${MACHINE_ENV_PREFIX}${key.toUpperCase()}`
                  : portableHomePath(entry, options),
          ]),
        );
      }
      return [id, projected];
    }),
  );
}
