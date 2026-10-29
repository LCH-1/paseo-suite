import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const core = path.resolve(
  process.env.PASEO_CORE_ROOT ?? path.join(root, "../paseo-core"),
);
const require = createRequire(path.join(core, "package.json"));
const result = spawnSync(
  process.execPath,
  [
    require.resolve("electron-builder/cli.js"),
    "--projectDir",
    path.join(core, "packages/desktop"),
    "--config",
    path.join(root, "tools/electron-builder.cjs"),
    "--win",
    "--x64",
    "--publish",
    "never",
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    env: { ...process.env, PASEO_CORE_ROOT: core },
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
