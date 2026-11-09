import { readMetroModules } from "./metro-module-ids.mjs";

// Unistyles gives View and Text separate Metro modules. A transplanted row must
// use the View import, even when the surrounding title uses the Text import.
export function repairSidebarActivityView(source) {
  const modules = readMetroModules(source);
  const panels = modules.filter((module) =>
    module.line.includes(".SidebarActivityPanel="),
  );
  if (panels.length !== 1) throw Error("Sidebar activity module is ambiguous");
  const panel = panels[0];
  if (!Array.isArray(panel.dependencies))
    throw Error("Sidebar activity dependencies are unsupported");
  const byId = new Map(modules.map((module) => [module.id, module]));
  const imports = panel.dependencies.map((id, index) => ({
    id,
    line: byId.get(id)?.line ?? "",
    alias: panel.line.match(
      new RegExp(`(?:^|[^\\w$])([\\w$]+)=[\\w$]+\\([\\w$]+\\[${index}\\]\\)`),
    )?.[1],
  }));
  const exportsComponent = (module, name) =>
    new RegExp(`Object\\.defineProperty\\([^,]+,["']${name}["'],`).test(
      module.line,
    );
  const owners = imports.filter((module) => exportsComponent(module, "View"));
  if (owners.length !== 1 || !owners[0].alias)
    throw Error("Sidebar View import is ambiguous");
  const matches = [
    ...panel.line.matchAll(/([\w$]+)\.View,\{style:[\w$]+\.tabNameRow,/g),
  ];
  if (matches.length !== 1 || !panel.line.includes(".SidebarProviderIcon"))
    throw Error("Sidebar provider row is ambiguous");
  const match = matches[0];
  const view = owners[0];
  if (match[1] === view.alias)
    return { source, changed: false, panelId: panel.id, viewModuleId: view.id };
  const previous = imports.find((module) => module.alias === match[1]);
  if (
    !previous ||
    !exportsComponent(previous, "Text") ||
    exportsComponent(previous, "View")
  )
    throw Error("Unexpected sidebar row component owner");
  const lines = source.split("\n");
  lines[panel.index] = panel.line.replace(
    match[0],
    match[0].replace(`${match[1]}.View`, `${view.alias}.View`),
  );
  return {
    source: lines.join("\n"),
    changed: true,
    panelId: panel.id,
    viewModuleId: view.id,
  };
}
