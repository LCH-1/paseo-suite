import { contributeMenu } from "./client/contribute-menu";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeAccounts } from "./client/accounts";

export default function contribute(client?: PluginClientContext) {
  const accounts = client ? contributeAccounts(client) : () => {};
  const menu = contributeMenu();
  return () => {
    menu();
    accounts();
  };
}
