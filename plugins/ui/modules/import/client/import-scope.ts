export interface ImportWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

interface ImportWorkspace {
  workspaceDirectory: string;
}

export interface ImportScopeInput {
  serverId: string | null;
  cwd?: string | null;
  workspaceId?: string | null;
  activeWorkspace?: ImportWorkspaceSelection | null;
  selectedProject?: { serverId: string; cwd: string | null } | null;
  workspaces?: ReadonlyMap<string, ImportWorkspace>;
}

export function resolveImportScope(input: ImportScopeInput) {
  const cwd = input.cwd?.trim();
  if (cwd) return { cwd, workspaceId: input.workspaceId ?? null };
  if (input.selectedProject) {
    return {
      cwd: input.selectedProject.serverId === input.serverId ? input.selectedProject.cwd?.trim() || null : null,
      workspaceId: null,
    };
  }
  const active = input.activeWorkspace?.serverId === input.serverId ? input.activeWorkspace : null;
  const workspaceId = input.workspaceId ?? active?.workspaceId ?? null;
  const directory = workspaceId ? input.workspaces?.get(workspaceId)?.workspaceDirectory.trim() : null;
  return { cwd: directory || null, workspaceId };
}
