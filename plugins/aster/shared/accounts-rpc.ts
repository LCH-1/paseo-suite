import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const family = z.enum(["claude", "codex"]);
export const accountsRpc = {
  status: defineRpc({
    name: "aster.accounts.status.request",
    input: z.object({}),
    output: z.object({
      accounts: z.array(
        z.object({
          id: z.string(),
          base: family,
          label: z.string(),
          status: z.string(),
        }),
      ),
      workspaces: z.array(z.object({ id: z.string(), label: z.string() })),
      flows: z.array(
        z.object({
          id: z.string(),
          base: family,
          workspaceId: z.string(),
          status: z.string(),
        }),
      ),
    }),
  }),
  add: defineRpc({
    name: "aster.accounts.add.request",
    input: z.object({ base: family, workspaceId: z.string().min(1) }),
    output: z.object({ id: z.string(), workspaceId: z.string() }),
  }),
  policy: defineRpc({
    name: "aster.providers.configure.request",
    input: z.object({}),
    output: z.object({ changed: z.array(z.string()) }),
  }),
};
