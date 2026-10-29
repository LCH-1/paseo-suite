import path from "node:path";
import type { PluginBackup } from "../shared/model";

export function portablePlugin(plugin: PluginBackup): PluginBackup {
  const files = { ...plugin.files };
  for (const [file, encoded] of Object.entries(files)) {
    if (!/\.[cm]?tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
    const target = file.startsWith("client/") || /^index\.client\./.test(file) ? "client" : file.startsWith("server/") || /^index\.server\./.test(file) ? "server" : null;
    if (!target) continue;
    const source = Buffer.from(encoded, "base64").toString("utf8");
    const expression = /^import\s+type\s*\{([^}]+)\}\s*from\s*["']@getpaseo\/client["'];?/gm;
    const matches = [...source.matchAll(expression)];
    if (!matches.length) continue;
    if (matches.some((match) => match[1].split(",").filter((item) => item.trim()).some((item) => !/^(PaseoApi|PaseoAgent)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.test(item.trim())))) throw new Error(`${plugin.id}: 지원하지 않는 Paseo client 타입을 사용합니다. 배포 가능한 플러그인으로 업데이트하세요.`);
    const declaration = `${target}/paseo-sync-types.d.ts`;
    const sdk = target === "client" ? 'ReturnType<typeof import("@getpaseo/plugin/client").getPaseoClient>' : 'import("@getpaseo/plugin/server").PluginHandlerContext["paseo"]';
    const adapter = `export type PaseoApi = ${sdk};\nexport type PaseoAgent = import("@getpaseo/protocol/messages").AgentSnapshotPayload;\n`;
    if (files[declaration] && Buffer.from(files[declaration], "base64").toString("utf8") !== adapter) throw new Error(`${plugin.id}: 이식 타입 파일이 이미 존재합니다.`);
    files[declaration] = Buffer.from(adapter).toString("base64");
    const relative = path.posix.relative(path.posix.dirname(file), declaration);
    const specifier = relative.startsWith(".") ? relative : `./${relative}`;
    const replaced = source.replace(expression, (_match, bindings: string) => `import type {${bindings}} from ${JSON.stringify(specifier)};`);
    files[file] = Buffer.from(replaced).toString("base64");
  }
  return { ...plugin, files };
}
