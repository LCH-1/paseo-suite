const path = require("node:path"),
  fs = require("node:fs"),
  { build } = require("esbuild");
const root = path.resolve(process.argv[2] || "");
if (
  !root ||
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version !== "0.3.10"
)
  throw Error("Use the verified Settings Sync 0.3.10 source");
build({
  stdin: {
    contents: `export {ProviderCredentialSync} from ${JSON.stringify(path.join(root, "server/provider-credentials.ts"))};import {providerCredentialsSchema} from ${JSON.stringify(path.join(root, "shared/provider-credentials.ts"))};export const parseBundle=value=>providerCredentialsSchema.parse(value);`,
    resolveDir: root,
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["zod"],
  write: false,
  banner: {
    js: "// Generated from Paseo Nest Settings Sync 0.3.10 (526a374). Claude-only callers retain its CLI locks, journal and conditional writes.",
  },
})
  .then((result) => {
    let source = result.outputFiles[0].text;
    const insert = (before, after) => {
      if (source.split(before).length !== 2)
        throw Error("Verified credential restore contract changed");
      source = source.replace(before, after);
    };
    // Aster revalidates local ownership under the original CLI storage locks. The
    // default Settings Sync restore, journal, CAS writes and rollback stay intact.
    const credential = '        if (!unchanged && incoming.vendor === "claude") {';
    insert(
      credential,
      '        if (incoming.vendor === "claude") await options.beforeClaudeWrite?.(incoming);\n' +
        credential,
    );
    const registry =
      "          const previous = await readKnown2(file);\n          const registry =";
    insert(
      registry,
      "          const previous = await readKnown2(file);\n          await options.beforeClaudeRegistryWrite?.(incoming, previous?.raw ?? null);\n          const registry =",
    );
    fs.writeFileSync(path.join(__dirname, "credential-runtime.js"), source);
  })
  .catch(() => (process.exitCode = 1));
