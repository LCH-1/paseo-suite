import fs from "node:fs/promises";
import path from "node:path";

export async function buildUsageModules(appDist) {
  const file = new URL(
    "../plugins/ui/client/usage-modules.json",
    import.meta.url,
  );
  const ids = JSON.parse(await fs.readFile(file, "utf8"));
  const html = await fs.readFile(path.join(appDist, "index.html"), "utf8");
  const script = html.match(/src="([^"\n]*\/index-([a-f0-9]+)\.js)"/);
  if (!script) throw new Error("Paseo app bundle not found");
  const bundle = await fs.readFile(
    path.join(appDist, script[1].replace(/^\//, "")),
    "utf8",
  );
  const moduleId = (symbol) => {
    const lines = bundle
      .split("\n")
      .filter(
        (line) =>
          line.includes(`.${symbol}=`) ||
          new RegExp(`Object\\.defineProperty\\([^,]+,["']${symbol}["'],`).test(
            line,
          ),
      );
    if (lines.length !== 1)
      throw new Error(`Ambiguous usage module: ${symbol}`);
    const id = lines[0].match(/},(\d+),\[[^\]]*\]\);?$/)?.[1];
    if (!id) throw new Error(`Usage module ID missing: ${symbol}`);
    return Number(id);
  };
  ids[script[2]] = {
    queryClient: moduleId("queryClient"),
    sessions: moduleId("normalizeWorkspaceDescriptor"),
  };
  await fs.writeFile(file, JSON.stringify(ids, null, 2) + "\n");
}
