import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  asProviders,
  HOME_PATH_PREFIX,
  PROFILE_PATH_PREFIX,
  MACHINE_ENV_PREFIX,
  machineEnvironmentKeys,
  isAbsolutePath,
  profileEnvironmentKeys,
  profileDirectorySuffix,
  profilePathToken,
  projectProviders,
  providerFamily,
  standardVendorCommand,
  managedCodexCommand,
  vendorCommands,
  type ProviderMap,
} from "../shared/provider-paths";

export { projectProviders } from "../shared/provider-paths";
export type MaterializeOptions = {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  profileDirectories?: Record<string, Record<string, string>>;
  resolveExecutable?: (name: string) => Promise<string | null>;
  exists?: (file: string) => Promise<boolean>;
};

async function exists(file: string) {
  try {
    await access(
      file,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return (await stat(file)).isFile();
  } catch (error) {
    if (
      ["ENOENT", "EACCES", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  }
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string) {
  return (
    environment[name] ??
    Object.entries(environment).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    )?.[1]
  );
}

export async function resolveInstalledExecutable(
  name: string,
  options: MaterializeOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const fileExists = options.exists ?? exists;
  const home = options.home ?? homedir();
  const paths = (environmentValue(environment, "PATH") ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((entry) => entry.replace(/^"|"$/g, ""));
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const extension =
    platform === "win32"
      ? /\.(?:exe|com|cmd|bat)$/i.test(name)
        ? [""]
        : [".exe", ".com", ".cmd", ".bat"]
      : [""];
  if (platform === "win32" && /\.ps1$/i.test(name)) return null;
  const standardPaths =
    platform === "win32"
      ? [
          join(home, ".local", "bin"),
          join(
            environmentValue(environment, "APPDATA") ??
              join(home, "AppData", "Roaming"),
            "npm",
          ),
          join(home, "AppData", "Local", "Microsoft", "WinGet", "Links"),
          ...(name === "cursor-agent"
            ? [
                join(
                  environmentValue(environment, "LOCALAPPDATA") ??
                    join(home, "AppData", "Local"),
                  "cursor-agent",
                ),
              ]
            : []),
        ]
      : [
          join(home, ".local", "bin"),
          join(home, ".npm-global", "bin"),
          "/usr/local/bin",
          "/usr/bin",
          "/opt/homebrew/bin",
        ];
  for (const directory of [...new Set([...paths, ...standardPaths])]) {
    for (const suffix of extension) {
      const candidate = join(directory, `${name}${suffix}`);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function materializeHome(
  value: string,
  home: string,
  platform: NodeJS.Platform,
) {
  if (!value.startsWith(HOME_PATH_PREFIX)) return value;
  const relative = value.slice(HOME_PATH_PREFIX.length);
  if (
    isAbsolutePath(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((entry) => entry === "." || entry === "..") ||
    /[:\u0000\r\n]/.test(relative)
  )
    throw new Error("동기화된 홈 경로가 올바르지 않습니다.");
  return (platform === "win32" ? path.win32.join : path.posix.join)(
    home,
    ...relative.split("/").filter(Boolean),
  );
}

export async function materializeProviders(
  value: unknown,
  current: unknown,
  options: MaterializeOptions = {},
): Promise<ProviderMap> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const incoming = projectProviders(value);
  const local = asProviders(current);
  const resolve =
    options.resolveExecutable ??
    ((name) => resolveInstalledExecutable(name, options));
  const fileExists = options.exists ?? exists;
  const result: ProviderMap = {};
  for (const [id, provider] of Object.entries(incoming)) {
    const family = providerFamily(id, incoming);
    const command = standardVendorCommand(provider.command, family);
    const localCommand = local[id]?.command;
    const customLocal =
      Array.isArray(localCommand) &&
      localCommand.length &&
      !standardVendorCommand(localCommand, providerFamily(id, local));
    if (provider.enabled !== false && command && customLocal)
      throw new Error(
        `프로바이더 ${id}의 현재 기기 전용 실행 명령을 자동으로 교체할 수 없습니다.`,
      );
    const next = { ...provider };
    if (provider.enabled !== false && command) {
      const binary = vendorCommands[family!];
      const installed = await resolve(binary);
      if (!installed)
        throw new Error(
          `프로바이더 ${id}에 필요한 ${binary} CLI를 이 기기에 설치하세요.`,
        );
      const args = command
        .slice(1)
        .map((entry) => materializeHome(entry, home, platform));
      next.command =
        family === "codex" && managedCodexCommand(localCommand)
          ? localCommand
          : standardVendorCommand([installed, ...args], family)
            ? [installed, ...args]
            : [command[0], ...args];
    } else if (
      provider.enabled !== false &&
      Array.isArray(provider.command) &&
      typeof provider.command[0] === "string"
    ) {
      const executable = provider.command[0];
      const found = isAbsolutePath(executable)
        ? await fileExists(executable)
        : await resolve(executable);
      if (!found)
        throw new Error(
          `프로바이더 ${id}의 사용자 지정 실행 명령을 이 기기에서 찾을 수 없습니다.`,
        );
    }
    if (
      provider.env &&
      typeof provider.env === "object" &&
      !Array.isArray(provider.env)
    ) {
      const keys = profileEnvironmentKeys(family);
      next.env = Object.fromEntries(
        Object.entries(provider.env).map(([key, entry]) => {
          if (typeof entry !== "string") return [key, entry];
          if (entry.startsWith(MACHINE_ENV_PREFIX)) {
            const name = key.toUpperCase();
            if (
              !machineEnvironmentKeys.includes(name) ||
              entry !== `${MACHINE_ENV_PREFIX}${name}`
            )
              throw new Error(
                `프로바이더 ${id}의 기기별 환경변수 참조가 올바르지 않습니다.`,
              );
            const localEnv = local[id]?.env;
            const localValue =
              localEnv &&
              typeof localEnv === "object" &&
              !Array.isArray(localEnv)
                ? Object.entries(localEnv).find(
                    ([name]) => name.toUpperCase() === key.toUpperCase(),
                  )?.[1]
                : undefined;
            const environment = options.env ?? process.env;
            const join =
              platform === "win32" ? path.win32.join : path.posix.join;
            const fallback: Record<string, string> = {
              HOME: home,
              USERPROFILE: home,
              PATH: "",
              PATHEXT: platform === "win32" ? ".COM;.EXE;.BAT;.CMD" : "",
              APPDATA:
                platform === "win32"
                  ? join(home, "AppData", "Roaming")
                  : join(home, ".config"),
              LOCALAPPDATA:
                platform === "win32"
                  ? join(home, "AppData", "Local")
                  : join(home, ".local", "share"),
              TEMP:
                platform === process.platform
                  ? tmpdir()
                  : platform === "win32"
                    ? join(home, "AppData", "Local", "Temp")
                    : "/tmp",
              TMP:
                platform === process.platform
                  ? tmpdir()
                  : platform === "win32"
                    ? join(home, "AppData", "Local", "Temp")
                    : "/tmp",
            };
            return [
              key,
              typeof localValue === "string" &&
              !localValue.startsWith(MACHINE_ENV_PREFIX)
                ? localValue
                : (environmentValue(environment, name) ?? fallback[name]),
            ];
          }
          if (entry.startsWith(PROFILE_PATH_PREFIX)) {
            if (
              !/^[a-z][a-z0-9-]*$/.test(id) ||
              !keys.includes(key) ||
              entry !== profilePathToken(id, key)
            )
              throw new Error(
                `프로바이더 ${id}의 동기화된 프로필 경로가 올바르지 않습니다.`,
              );
            const localEnv = local[id]?.env;
            const localValue =
              localEnv &&
              typeof localEnv === "object" &&
              !Array.isArray(localEnv)
                ? (localEnv as Record<string, unknown>)[key]
                : undefined;
            const existing =
              typeof localValue === "string" &&
              !localValue.startsWith(PROFILE_PATH_PREFIX)
                ? localValue
                : undefined;
            const directory =
              options.profileDirectories?.[id]?.[key] ??
              existing ??
              (platform === "win32" ? path.win32.join : path.posix.join)(
                home,
                ".paseo",
                "settings-sync",
                "provider-profiles",
                id,
                profileDirectorySuffix(family, key),
              );
            return [key, directory];
          }
          return [key, materializeHome(entry, home, platform)];
        }),
      );
    }
    result[id] = next;
  }
  return result;
}
