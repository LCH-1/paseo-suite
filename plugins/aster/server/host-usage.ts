import { defaultCommand, runPaseo } from "./paseo";
import { localDaemon } from "./local-daemon";

/** Keep explicit custom commands; the local default uses the same API as the UI. */
export function hostUsageReader(
  home: string,
  daemon = localDaemon(home),
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
    const result = await daemon.use(
      async (client) => {
        if (!client.listUsageReports)
          throw Error("Paseo usage API is not available");
        return client.listUsageReports({
          forceRefresh: args.includes("--refresh"),
        });
      },
      { signal, timeoutMs: timeout },
    );
    signal.throwIfAborted();
    return JSON.stringify(result.reports);
  };
}
