import { mkdir, readFile, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await mkdir(path.join(root, "dist"), { recursive: true });
const name = `host-order-${pkg.version}`;
const temporary = path.join(root, "dist", `${name}.tmp.zip`);
const output = path.join(root, "dist", `${name}.zip`);
const files = ["package.json", "tsconfig.json", ...pkg.files].map((file) => file.replace(/\/+$/, ""));
const result = spawnSync("tar", ["-a", "-cf", temporary, ...files], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`tar failed (${result.status})`);
await rename(temporary, output);
console.log(output);
