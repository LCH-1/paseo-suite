import { z } from "zod";
import type { Account } from "./accounts";
import { createLocalPluginConnection } from "./legacy-credential-rpc";

const profile = z.object({
  account: z.object({
    uuid: z.string(),
    email: z.string().optional(),
    has_claude_pro: z.boolean().optional(),
    has_claude_max: z.boolean().optional(),
  }),
  organization: z.object({
    uuid: z.string(),
    organization_type: z.string().optional(),
    subscription_status: z.string().nullish(),
    claude_code_trial_ends_at: z.string().nullish(),
  }),
});
const result = z.object({
  version: z.literal(1),
  profiles: z.array(
    z.union([
      z.object({
        providerId: z.string(),
        status: z.literal("ready"),
        profile,
        identity: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      z.object({
        providerId: z.string(),
        status: z.union([z.number(), z.enum(["missing", "unknown"])]),
      }),
    ]),
  ),
});
export type CoreProfiles = z.output<typeof result>["profiles"];
export type ReadProfiles = (
  ids: string[],
  signal: AbortSignal,
) => Promise<CoreProfiles | null>;

export function matchesAccount(
  account: Account,
  value: z.output<typeof profile>,
) {
  const organization = account.identity?.split("|")[0];
  return Boolean(
    account.email &&
      value.account.email &&
      account.email.toLowerCase() === value.account.email.toLowerCase() &&
      (!organization || organization === value.organization.uuid),
  );
}

export function coreProfileReader(
  home: string,
  connect = createLocalPluginConnection,
): ReadProfiles {
  return async (providerIds, signal) => {
    signal.throwIfAborted();
    const client = await connect(home);
    const abort = () => client.close();
    const timer = setTimeout(abort, 20000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.connect();
      const value = await client.invokePluginRpc(
        "claude-usage-source",
        "claude.profiles.read.request",
        { providerIds },
      );
      signal.throwIfAborted();
      return result.parse(value).profiles;
    } catch (error) {
      signal.throwIfAborted();
      // COMPAT(preSuiteCore): old hosts explicitly lack this endpoint. A network
      // or malformed response never starts a second credential-reading path.
      if (
        error instanceof Error &&
        /Plugin claude-usage-source does not contribute RPC claude\.profiles\.read\.request/.test(
          error.message,
        )
      )
        return null;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      client.close();
    }
  };
}
