import type { PluginServerContext } from "@getpaseo/plugin/server";
import { rpc } from "../shared/rpc";
import { manualRpc } from "../shared/manual-restore-rpc";
import { SyncService } from "./service";
import { AutoSync } from "./automation";
import { providerDiagnostics } from "./diagnostics";
import { AutoSyncRpc } from "./auto-rpc";

export default function contribute(server: PluginServerContext) {
  const service = new SyncService();
  const automation = new AutoSync();
  const autoRpc = new AutoSyncRpc(() => service.serial(() => automation.status()));
  server.handle(rpc.diagnostics, (_input, { paseo }) => providerDiagnostics(paseo));
  server.handle(rpc.startLogin, ({ force }) => service.serial(() => service.start(force)));
  server.handle(rpc.pollLogin, ({ flowId }) => service.serial(() => service.poll(flowId)));
  server.handle(rpc.cancelLogin, ({ flowId }) => service.serial(async () => service.cancel(flowId)));
  server.handle(rpc.connect, (input) => service.serial(() => service.connect(input)));
  server.handle(rpc.resume, ({ sessionId }) => service.serial(() => service.resume(sessionId)));
  server.handle(rpc.disconnect, ({ sessionId }) => service.serial(async () => service.disconnect(sessionId)));
  server.handle(rpc.push, ({ sessionId, client, scopes }, { paseo }) => service.serial(() => service.push(sessionId, client, paseo, scopes)));
  server.handle(rpc.preview, ({ sessionId, scopes }, { paseo }) => service.serial(() => service.preview(sessionId, paseo, scopes)));
  server.handle(rpc.restore, (input, { paseo }) => service.restore(input, paseo));
  server.handle(manualRpc.restoreStart, async (input, { paseo }) => service.startRestore(input, paseo));
  server.handle(manualRpc.restoreStatus, async ({ sessionId, previewId }) => service.restoreStatus(sessionId, previewId));
  server.handle(manualRpc.restoreRelease, async ({ sessionId, previewId }) => service.releaseRestore(sessionId, previewId));
  server.handle(rpc.autoStatus, () => autoRpc.status());
  server.handle(rpc.autoEnable, ({ sessionId, scopes, clientId }) => service.serial(async () => {
    const status = await automation.enable(service.authorizeAutomation(sessionId), scopes, clientId);
    service.disconnect(sessionId);
    return status;
  }));
  server.handle(rpc.autoClaim, ({ clientId }) => service.serial(() => automation.claim(clientId)));
  server.handle(rpc.autoConfigure, ({ scopes, client, clientId, takeover }, { paseo }) => service.serial(() => automation.configure(scopes, client, paseo, clientId, takeover)));
  server.handle(rpc.autoDisable, () => service.serial(() => automation.disable()));
  server.handle(rpc.autoTick, ({ client, force, clientId }, { paseo }) => autoRpc.tick(clientId, () => service.serial(() => automation.tick(client, paseo, force, clientId)), !!force));
  server.handle(rpc.autoAck, ({ operationId, client, clientId }, { paseo }) => service.serial(() => automation.acknowledge(operationId, client, paseo, clientId)));
  return () => service.dispose().finally(() => automation.dispose());
}
