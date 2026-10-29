import { defaultCommand, runPaseo } from "./paseo";
import { createLocalPluginConnection } from "./legacy-credential-rpc";

/** Keep explicit custom commands; the local default uses the same API as the UI. */
export function hostUsageReader(
  home: string,
  connect = createLocalPluginConnection,
  run = runPaseo,
): typeof runPaseo {
  return async (command, args, signal, timeout = 18000) => {
    const local = defaultCommand();
    const key = (file: string) =>
      process.platform === "win32"
        ? file.replaceAll("\\", "/").toLowerCase()
        : file;
    if (
      args[0] !== "usage" ||
      key(command.file) !== key(local.file) ||
      JSON.stringify(command.args) !== JSON.stringify(local.args)
    )
      return run(command, args, signal, timeout);
    signal.throwIfAborted();
    const client = await connect(home);
    const abort = () => client.close();
    const timer = setTimeout(abort, timeout);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.connect();
      if (!client.listUsageReports)
        throw Error("Paseo usage API is not available");
      const result = await client.listUsageReports({
        forceRefresh: args.includes("--refresh"),
      });
      signal.throwIfAborted();
      return JSON.stringify(result.reports);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      client.close();
    }
  };
}
