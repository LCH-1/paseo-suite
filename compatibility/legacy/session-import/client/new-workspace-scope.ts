export interface NewWorkspaceImportScope {
  serverId: string;
  cwd: string | null;
}

// The screen already passes its selected project to its composer. Read that
// render's element props so each retained draft carries its own scope, without
// consulting another tab, route history, or a global "last project" cache.
export function readNewWorkspaceImportScope(element: unknown): NewWorkspaceImportScope | null {
  if (Array.isArray(element)) {
    for (const child of element) {
      const scope = readNewWorkspaceImportScope(child);
      if (scope) return scope;
    }
    return null;
  }
  if (!element || typeof element !== "object" || !("props" in element)) return null;
  const props = element.props as Record<string, unknown> | null;
  if (!props) return null;
  if ((props.submitButtonTestID === "workspace-create-submit" ||
      props.submitButtonTestID === "new-workspace-launch-submit") &&
      typeof props.serverId === "string" && typeof props.cwd === "string") {
    return { serverId: props.serverId, cwd: props.cwd.trim() || null };
  }
  return readNewWorkspaceImportScope(props.children);
}
