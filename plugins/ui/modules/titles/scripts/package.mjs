import { mkdir, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("dist", { recursive: true });
const output = resolve("dist", `${pkg.name}-${pkg.version}-dev.zip`);
const temporaryOutput = resolve("dist", `${pkg.name}-${pkg.version}-dev.tmp.zip`);
const files = [...pkg.files, "package.json", "tsconfig.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]
  .map((file) => file.replace(/\/+$/, ""));
const result = spawnSync("tar", ["-a", "-cf", temporaryOutput, ...files], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`tar failed (${result.status}). A ZIP-capable bsdtar is required.`);
await rename(temporaryOutput, output);
process.stdout.write(output + "\n");
