import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  enabled: z.boolean().default(true),
});

export const settings = defineSettings({
  id: "sidebar-title-sync",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

export const settingsMethods = settingsRpc(settings.id);
export type TitleSyncSettings = z.output<typeof settingsSchema>;
