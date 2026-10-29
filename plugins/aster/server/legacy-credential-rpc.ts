import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

export function localWebsocketTarget(listen: string) {
  const target = new URL(
    listen.includes("://") ? listen.replace(/^tcp:/, "ws:") : `ws://${listen}`,
  );
  if (
    target.protocol !== "ws:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !Number(target.port) ||
    !["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(
      target.hostname,
    )
  ) {
    throw new Error("Aster 구버전 호환 연결은 로컬 TCP 호스트만 사용합니다.");
  }
  if (target.hostname === "0.0.0.0") target.hostname = "127.0.0.1";
  if (target.hostname === "[::]") target.hostname = "[::1]";
  target.pathname = "/ws";
  return target.href;
}
export interface Connection {
  connect(): Promise<void>;
  close(): void;
  invokePluginRpc(id: string, method: string, input: unknown): Promise<unknown>;
  listUsageReports?(options: {
    forceRefresh?: boolean;
  }): Promise<{ reports: unknown[] }>;
}
export async function createLocalPluginConnection(
  home: string,
): Promise<Connection> {
  const lock = z
    .object({ listen: z.string() })
    .parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")));
  const url = localWebsocketTarget(lock.listen);
  return new DaemonClient({
    url,
    clientId: `paseo-suite-compat-${randomUUID()}`,
    clientType: "cli",
    appVersion: "0.12.0",
    reconnect: { enabled: false },
    connectTimeoutMs: 5000,
    suppressSendErrors: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    localCredential: async () => {
      const file = join(home, "local-credential");
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
        throw new Error("Invalid local credential path");
      return (await readFile(file, "utf8")).trim();
    },
  });
}

// COMPAT(legacyAsterCredentialRpc): added in Suite 1.0; remove after supported
// clients all negotiate Settings Sync endpoints, no earlier than 2027-03-01.
export function registerLegacyCredentialRpc(
  server: PluginServerContext,
  home: string,
  create = createLocalPluginConnection,
) {
  let stopped = false;
  const active = new Set<Connection>();
  for (const operation of ["status", "export", "receive"]) {
    server.handle(
      defineRpc({
        name: `aster.credentials.${operation}`,
        input: z.unknown(),
        output: z.unknown(),
      }),
      async (input) => {
        if (stopped) throw new Error("Aster 호환 연결이 해제되었습니다.");
        const client = await create(home);
        if (stopped) {
          client.close();
          throw new Error("Aster 호환 연결이 해제되었습니다.");
        }
        active.add(client);
        const timer = setTimeout(() => client.close(), 10000);
        try {
          await client.connect();
          if (stopped) throw new Error("Aster 호환 연결이 해제되었습니다.");
          return await client.invokePluginRpc(
            "settings-sync",
            `sync.credentials.${operation}.request`,
            input,
          );
        } finally {
          clearTimeout(timer);
          active.delete(client);
          client.close();
        }
      },
    );
  }
  return () => {
    stopped = true;
    for (const client of active) client.close();
    active.clear();
  };
}
