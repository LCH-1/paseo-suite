import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const moduleIds = [
  "tabs",
  "hosts",
  "import",
  "titles",
  "terminal",
] as const;
export type ModuleId = (typeof moduleIds)[number];
export const settings = defineSettings({
  id: "paseo-ui",
  scope: "host",
  version: 1,
  schema: z.object({
    modules: z
      .object({
        tabs: z.boolean().default(true),
        hosts: z.boolean().default(true),
        import: z.boolean().default(true),
        titles: z.boolean().default(true),
        terminal: z.boolean().default(true),
      })
      .default({
        tabs: true,
        hosts: true,
        import: true,
        titles: true,
        terminal: true,
      }),
  }),
});
export const methods = settingsRpc(settings.id);
export type UiSettings = z.output<typeof settings.schema>;
