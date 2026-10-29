import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { clientStateSchema } from "./model";
import { autoScopesSchema, autoScopesInputSchema, autoStatusSchema, LEGACY_CLIENT_ID } from "./automation";

const session = z.object({ sessionId: z.string().uuid() });
const clientIdentity = z.string().uuid().default(LEGACY_CLIENT_ID);
export const connectionStateSchema = session.extend({ login: z.string(), hasBackup: z.boolean(), createdAt: z.string().nullable() });
export type ConnectionState = z.infer<typeof connectionStateSchema>;
export const summarySchema = z.object({
  id: z.string().uuid(), createdAt: z.string(), device: z.string(), hosts: z.array(z.string()),
  preferences: z.array(z.string()), config: z.array(z.string()), providers: z.array(z.string()).default([]),
  authenticatedProviders: z.array(z.string()).default([]),
  plugins: z.array(z.object({ id: z.string(), enabled: z.boolean(), files: z.number(), settings: z.array(z.string()) })),
});
export type Summary = z.infer<typeof summarySchema>;
export const rpc = {
  diagnostics: defineRpc({ name: "sync.diagnostics", input: z.object({}), output: z.object({ platform: z.string(), defaultHome: z.boolean(), userHomeDigest: z.string(), directAuthenticatedProviders: z.array(z.string()), environmentAuthenticatedProviders: z.array(z.string()), providers: z.array(z.object({ vendor: z.string(), providerIds: z.array(z.string()), status: z.string(), store: z.string() })) }) }),
  startLogin: defineRpc({ name: "sync.login.start", input: z.object({ force: z.boolean().default(false) }), output: z.object({ flowId: z.string().uuid(), ready: z.boolean(), login: z.string().nullable(), code: z.string().nullable(), url: z.string().nullable(), expiresIn: z.number() }) }),
  pollLogin: defineRpc({ name: "sync.login.poll", input: z.object({ flowId: z.string().uuid() }), output: z.object({ ready: z.boolean(), login: z.string().nullable() }) }),
  cancelLogin: defineRpc({ name: "sync.login.cancel", input: z.object({ flowId: z.string().uuid() }), output: z.object({ ok: z.boolean() }) }),
  connect: defineRpc({ name: "sync.connect", input: z.object({
    flowId: z.string().uuid(), password: z.string().min(12).max(1024),
  }), output: connectionStateSchema }),
  resume: defineRpc({ name: "sync.resume", input: session, output: connectionStateSchema.nullable() }),
  disconnect: defineRpc({ name: "sync.disconnect", input: session, output: z.object({ ok: z.boolean() }) }),
  push: defineRpc({ name: "sync.push", input: session.extend({ client: clientStateSchema, scopes: autoScopesInputSchema.optional() }), output: z.object({ createdAt: z.string(), plugins: z.number(), hosts: z.number(), providers: z.number().default(0), authentications: z.number().default(0) }) }),
  preview: defineRpc({ name: "sync.preview", input: session.extend({ scopes: autoScopesInputSchema.optional() }), output: summarySchema }),
  restore: defineRpc({ name: "sync.restore", input: session.extend({ previewId: z.string().uuid(), plugins: z.boolean(), config: z.boolean(), scopes: autoScopesInputSchema.optional() }), output: z.object({ client: clientStateSchema, backupDirectory: z.string(), scopes: autoScopesSchema.optional() }) }),
  autoStatus: defineRpc({ name: "sync.auto.status", input: z.object({}), output: autoStatusSchema }),
  autoEnable: defineRpc({ name: "sync.auto.enable", input: session.extend({ scopes: autoScopesInputSchema, clientId: clientIdentity }), output: autoStatusSchema }),
  autoConfigure: defineRpc({ name: "sync.auto.configure", input: z.object({ clientId: clientIdentity, scopes: autoScopesInputSchema, client: clientStateSchema, takeover: z.object({ expectedOwnerClientId: z.string().uuid().nullable() }).optional() }), output: autoStatusSchema }),
  autoClaim: defineRpc({ name: "sync.auto.claim", input: z.object({ clientId: z.string().uuid() }), output: autoStatusSchema }),
  autoDisable: defineRpc({ name: "sync.auto.disable", input: z.object({}), output: autoStatusSchema }),
  autoTick: defineRpc({ name: "sync.auto.tick", input: z.object({ client: clientStateSchema, clientId: clientIdentity, force: z.enum(["local", "remote"]).optional() }), output: z.object({ status: autoStatusSchema, operation: z.object({ id: z.string().uuid(), client: clientStateSchema, scopes: autoScopesSchema.optional() }).nullable() }) }),
  autoAck: defineRpc({ name: "sync.auto.ack", input: z.object({ operationId: z.string().uuid(), client: clientStateSchema, clientId: clientIdentity }), output: autoStatusSchema }),
};
