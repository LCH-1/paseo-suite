// Lazy chunks reserve IDs in dependency maps before their factories are loaded.
// Allocating from registered factories alone can replace an unrelated lazy import.
export function readMetroModules(source) {
  const modules = [];
  for (const [index, line] of source.split("\n").entries()) {
    const match = line.match(/},(\d+),(\[[^\n]*\]|\{[^\n]*\})\);?\r?$/);
    if (!match) continue;
    modules.push({
      id: Number(match[1]),
      dependencies: JSON.parse(match[2]),
      line,
      index,
    });
  }
  return modules;
}

export function allocateMetroModuleId(source) {
  const modules = readMetroModules(source);
  if (!modules.length) throw Error("Metro module registrations were not found");
  let maximum = -1;
  const reserve = (id) => {
    if (!Number.isSafeInteger(id) || id < 0)
      throw Error("Invalid Metro module ID");
    maximum = Math.max(maximum, id);
  };
  for (const module of modules) {
    reserve(module.id);
    for (const [key, value] of Object.entries(module.dependencies)) {
      if (key === "paths") {
        for (const id of Object.keys(value)) reserve(Number(id));
      } else reserve(value);
    }
  }
  if (!Number.isSafeInteger(maximum + 1))
    throw Error("Metro module ID space is exhausted");
  return maximum + 1;
}
