import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import contributeBackup from "./runtime.js";
import { atomicWrite } from "./files";
import { paseoHome } from "./environment";
import { registerCredentialSharing } from "./relay/credential-sharing";
import { suiteSettings } from "../shared/suite-settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(suiteSettings);
  const enabled = async (id: "backup" | "relay") => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    return state.values[id];
  };
  const backup = contributeBackup({ ...server,
    handle: (contract, handler) => server.handle(contract, async (input, context) => {
      if (!await enabled("backup")) throw new Error("Settings Sync: 설정 백업이 비활성화되어 있습니다.");
      return handler(input, context);
    }),
  });
  const relay = registerCredentialSharing(server, paseoHome(),
    () => atomicWrite(path.join(paseoHome(), "settings-sync", "credential-revision"), randomUUID()),
    () => enabled("relay"));
  return async () => {
    relay.reverse().forEach((cleanup) => cleanup());
    await backup();
  };
}
