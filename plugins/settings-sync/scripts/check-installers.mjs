import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = process.platform === "win32" ? "python" : "python3";
const child = spawn(python, [fileURLToPath(new URL("../tests/test_installers.py", import.meta.url))], { windowsHide: true, stdio: "inherit" });
child.on("error", () => { console.error("Installer tests require Python 3 and the platform's PowerShell or Bash."); process.exitCode = 1; });
child.on("close", (code) => { process.exitCode = code ?? 1; });
