import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const compilerPath = process.argv[2];
if (!compilerPath) throw new Error("Pass the installed Paseo compiler.js path, running under Electron with ELECTRON_RUN_AS_NODE=1.");
const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)).href);
const root = process.cwd();
const result = await compilePlugin({
  client: resolve(root, "index.client.tsx"),
  server: resolve(root, "index.server.ts"),
});
process.stdout.write(JSON.stringify({ clientBytes: result.clientBundle.length, serverBytes: result.serverBundle.length }) + "\n");
