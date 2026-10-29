import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const suiteSettings = defineSettings({
  id: "suite-sync", scope: "host", version: 1,
  schema: z.object({ backup: z.boolean().default(true), relay: z.boolean().default(true) }),
});
export const suiteMethods = settingsRpc(suiteSettings.id);
