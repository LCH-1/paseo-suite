const families = ["mythos", "fable", "opus", "sonnet", "haiku"];

/** Interleave each family's releases, keeping context variants in the same round. */
export function orderClaudeModels<T>(
  rows: T[],
  modelId: (row: T) => string,
): T[] {
  const entries = rows.map((row, index) => {
    const match = modelId(row).match(
      /^claude-(mythos|fable|opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i,
    );
    return {
      row,
      index,
      family: match?.[1].toLowerCase(),
      version: match ? Number(match[2]) * 100 + Number(match[3] ?? 0) : null,
    };
  });
  const releases = new Map(
    families.map((family) => [
      family,
      [
        ...new Set(
          entries
            .filter((entry) => entry.family === family)
            .map((entry) => entry.version!),
        ),
      ].sort((a, b) => b - a),
    ]),
  );
  const round = (entry: (typeof entries)[number]) =>
    entry.family
      ? releases.get(entry.family)!.indexOf(entry.version!)
      : Infinity;
  const sorted = [...entries].sort(
    (a, b) =>
      round(a) - round(b) ||
      families.indexOf(a.family!) - families.indexOf(b.family!) ||
      a.index - b.index,
  );
  return sorted.every((entry, index) => entry.index === index)
    ? rows
    : sorted.map((entry) => entry.row);
}

export function orderProviderModels<
  T extends {
    id: string;
    modelSelection: { kind: string; rows?: { modelId: string }[] };
  },
>(providers: T[]): T[] {
  let changed = false;
  const result = providers.map((provider) => {
    if (
      provider.id !== "claude" ||
      provider.modelSelection.kind !== "models" ||
      !provider.modelSelection.rows
    )
      return provider;
    const rows = orderClaudeModels(
      provider.modelSelection.rows,
      (row) => row.modelId,
    );
    if (rows === provider.modelSelection.rows) return provider;
    changed = true;
    return {
      ...provider,
      modelSelection: { ...provider.modelSelection, rows },
    };
  });
  return changed ? result : providers;
}
