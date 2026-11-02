import fs from "node:fs/promises";
import path from "node:path";

function readModules(source) {
  const modules = [];
  for (const [index, line] of source.split("\n").entries()) {
    const match = line.match(/},(\d+),(\[[^\]]*\])\);?$/);
    if (match)
      modules.push({
        id: Number(match[1]),
        dependencies: JSON.parse(match[2]),
        line,
        index,
      });
  }
  return modules;
}

function exportsSymbol(module, symbol) {
  return (
    module.line.includes(`"${symbol}"`) ||
    module.line.includes(`'${symbol}'`) ||
    module.line.includes(`.${symbol}=`)
  );
}

function findNavigation(source) {
  const modules = readModules(source);
  const native = modules.filter((module) =>
    ["NavigationContainer", "createStaticNavigation", "LocaleDirContext"].every(
      (symbol) => exportsSymbol(module, symbol),
    ),
  );
  const core = modules.filter((module) =>
    ["BaseNavigationContainer", "NavigationContext", "useNavigation"].every(
      (symbol) => exportsSymbol(module, symbol),
    ),
  );
  if (!native.length || !core.length)
    throw Error(
      "React Navigation modules were not identified; refusing an unchecked bundle",
    );
  return { modules, native, core };
}

export function assertNavigationContext(source) {
  const { native, core } = findNavigation(source);
  if (native.length !== 1 || core.length !== 1)
    throw Error(
      `Duplicate React Navigation contexts: native=${native.length}, core=${core.length}`,
    );
}

export function repairNavigationContext(source) {
  const { modules, native, core } = findNavigation(source);
  if (native.length === 1 && core.length === 1) return { source, aliases: [] };
  const router = modules.filter(
    (module) =>
      module.line.includes("Invalid parent path") &&
      exportsSymbol(module, "useNavigation"),
  );
  if (router.length !== 1)
    throw Error("Expo Router navigation owner is ambiguous");
  const owner = native.filter((module) =>
    router[0].dependencies.includes(module.id),
  );
  if (owner.length !== 1)
    throw Error("Expo Router native dependency is ambiguous");
  const coreOwner = core.filter((module) =>
    owner[0].dependencies.includes(module.id),
  );
  if (coreOwner.length !== 1)
    throw Error("Expo Router core dependency is ambiguous");
  const aliases = [];
  const lines = source.split("\n");
  for (const [group, canonical] of [
    [native, owner[0]],
    [core, coreOwner[0]],
  ]) {
    for (const module of group) {
      if (module.id === canonical.id) continue;
      const definitions = /Object\.defineProperty\([^,]+,["']([^"']+)["']/g;
      const names = (line) =>
        [...line.matchAll(definitions)].map((match) => match[1]).sort();
      if (
        JSON.stringify(names(module.line)) !==
        JSON.stringify(names(canonical.line))
      )
        throw Error(
          "Navigation export contracts differ; refusing to alias incompatible versions",
        );
      lines[module.index] =
        `__d(function(g,r,i,a,m,e,d){m.exports=r(d[0])},${module.id},[${canonical.id}]);`;
      aliases.push({ from: module.id, to: canonical.id });
    }
  }
  const repaired = lines.join("\n");
  assertNavigationContext(repaired);
  return { source: repaired, aliases };
}

export async function assertAppNavigationContext(appDist) {
  const html = await fs.readFile(path.join(appDist, "index.html"), "utf8");
  const scripts = [
    ...html.matchAll(/src=["']([^"']*\/index-[a-f0-9]+\.js)["']/g),
  ];
  if (scripts.length !== 1) throw Error("App entry bundle is ambiguous");
  const bundle = path.resolve(appDist, scripts[0][1].replace(/^\//, ""));
  if (!bundle.startsWith(path.resolve(appDist) + path.sep))
    throw Error("App bundle escapes app-dist");
  assertNavigationContext(await fs.readFile(bundle, "utf8"));
}
