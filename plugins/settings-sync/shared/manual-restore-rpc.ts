import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { rpc } from "./rpc";

export const restoreStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }), z.object({ state: z.literal("running") }),
  z.object({ state: z.literal("completed"), result: rpc.restore.output }),
  z.object({ state: z.literal("failed"), message: z.string() }),
]);
export type RestoreStatus = z.infer<typeof restoreStatusSchema>;
const lookup = z.object({ sessionId: z.string().uuid(), previewId: z.string().uuid() });
export const manualRpc = {
  restoreStart: defineRpc({ name: "sync.restore.start", input: rpc.restore.input, output: restoreStatusSchema }),
  restoreStatus: defineRpc({ name: "sync.restore.status", input: lookup, output: restoreStatusSchema }),
  restoreRelease: defineRpc({ name: "sync.restore.release", input: lookup, output: z.object({ ok: z.boolean() }) }),
};
