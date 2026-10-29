import { importComponentSource, importContracts } from "./import-component";
import { resolveImportScope, type ImportScopeInput } from "./import-scope";
import { readNewWorkspaceImportScope } from "./new-workspace-scope";

export function parseImportPresentationModules(source: string) {
  const modules = source.split("\n");
  const candidates = modules.filter(line => /\b\w+\.ImportSessionSheet=/.test(line));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new Error("Session Import: 불러오기 모듈이 중복됩니다.");
  const signature = candidates[0].match(/},(\d+),\[([\d,]*)\]\);?$/);
  if (!signature) throw new Error("Session Import: 불러오기 모듈 계약을 확인할 수 없습니다.");
  const dependencies = signature[2].split(",").map(Number);
  if (dependencies.length !== 26) throw new Error("Session Import: 지원하지 않는 불러오기 모듈입니다.");
  const owner = (symbol: string, optional = false) => {
    const candidates = modules.filter(line => {
      const exported = line.match(/^__d\(function\(([^)]*)\)/)?.[1].split(",")[5]?.trim();
      if (!exported) return false;
      const name = exported.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^\\w$])${name}\\.${symbol}\\s*=`).test(line) ||
        new RegExp(`Object\\.defineProperty\\(${name},["']${symbol}["'],\\{[^}]*get:function\\(\\)\\{return [\\w$]+\\}\\}`).test(line);
    });
    if (optional && candidates.length === 0) return null;
    if (candidates.length !== 1) throw new Error(`Session Import: 불러오기 의존성을 확인할 수 없습니다: ${symbol}`);
    return Number(candidates[0].match(/},(\d+),\[/)![1]);
  };
  const navigation = owner("getLastWorkspaceSelection", true);
  const newWorkspace = owner("NewWorkspaceScreen", true);
  return { sheet: Number(signature[1]), dependencies, sessions: owner("useSessionStore")!, titles: owner("selectAgentTabSidebarLabel", true), ...(navigation === null ? {} : { navigation }), ...(newWorkspace === null ? {} : { newWorkspace }) };
}

export function installImportPresentation(ids: NonNullable<ReturnType<typeof parseImportPresentationModules>>, requireModule: (id: number) => any) {
  const sheet = requireModule(ids.sheet);
  const sessions = requireModule(ids.sessions);
  const titles = ids.titles === null ? null : requireModule(ids.titles);
  const imports = new Map<string, any>();
  for (const [name, [index, exports]] of Object.entries(importContracts)) {
    const module = requireModule(ids.dependencies[index]);
    if (!module || exports.some(name => module[name] === undefined)) throw new Error(`Session Import: 불러오기 런타임 계약 불일치: ${name}`);
    imports.set(name, module);
  }
  if (typeof sheet?.ImportSessionSheet !== "function" || typeof sessions?.useSessionStore?.getState !== "function" || (titles && typeof titles.selectAgentTabSidebarLabel !== "function")) throw new Error("Session Import: 불러오기 런타임을 확인할 수 없습니다.");
  imports.set("@/stores/session-store", sessions);
  const nativeRequire = (name: string) => {
    if (!imports.has(name)) throw new Error(`Session Import: 허용되지 않은 불러오기 의존성: ${name}`);
    return imports.get(name);
  };
  const module = { exports: {} as { ImportSessionSheet: (...args: any[]) => any } };
  new Function("require", "module", "exports", importComponentSource)(nativeRequire, module, module.exports);
  const originalSheet = sheet.ImportSessionSheet;
  const originalTitle = titles?.selectAgentTabSidebarLabel;
  const replacement = module.exports.ImportSessionSheet;
  const navigation = ids.navigation === undefined ? null : requireModule(ids.navigation);
  if (navigation && typeof navigation.getLastWorkspaceSelection !== "function") throw new Error("Session Import: 현재 프로젝트 경로를 확인할 수 없습니다.");
  const react = imports.get("react");
  const projectContext = react.createContext(null);
  const newWorkspace = ids.newWorkspace === undefined ? null : requireModule(ids.newWorkspace);
  const originalNewWorkspace = newWorkspace?.NewWorkspaceScreen;
  if (newWorkspace && typeof originalNewWorkspace !== "function") throw new Error("Session Import: 새 워크스페이스 화면을 확인할 수 없습니다.");
  const scopedNewWorkspace = (props: Record<string, unknown>) => {
    const rendered = originalNewWorkspace(props);
    return react.createElement(projectContext.Provider, { value: readNewWorkspaceImportScope(rendered) }, rendered);
  };
  const scopedSheet = (props: ImportScopeInput & Record<string, unknown>) => {
    const selectedProject = react.useContext(projectContext);
    const activeWorkspace = navigation?.getLastWorkspaceSelection() ?? null;
    const directory = sessions.useSessionStore((state: { sessions: Record<string, { workspaces: ImportScopeInput["workspaces"] }> }) => {
      const scope = resolveImportScope({ ...props, selectedProject, activeWorkspace, workspaces: props.serverId ? state.sessions[props.serverId]?.workspaces : undefined });
      return scope.cwd;
    });
    const scope = resolveImportScope({ ...props, selectedProject, activeWorkspace });
    return react.createElement(replacement, { ...props, cwd: directory, workspaceId: scope.workspaceId });
  };
  const wrappedTitle = (input: any) => {
    const label = originalTitle(input);
    const agent = input.session?.agents.get(input.context.agentId) ?? input.session?.agentDetails.get(input.context.agentId);
    if (!label || input.context.subagentId || !agent || !(agent.provider === "claude" || agent.provider?.startsWith("claude-")) || !agent.title?.trim() || agent.title.trim() === label) return label;
    const peers = [...input.session.agents.values()].some((peer: any) => peer.id !== agent.id && peer.workspaceId === agent.workspaceId);
    return peers ? `${label} · ${agent.title.trim()}` : label;
  };
  const restore = () => {
    if (sheet.ImportSessionSheet === scopedSheet) sheet.ImportSessionSheet = originalSheet;
    if (newWorkspace?.NewWorkspaceScreen === scopedNewWorkspace) newWorkspace.NewWorkspaceScreen = originalNewWorkspace;
    if (titles?.selectAgentTabSidebarLabel === wrappedTitle) titles.selectAgentTabSidebarLabel = originalTitle;
  };
  try {
    sheet.ImportSessionSheet = scopedSheet;
    if (newWorkspace) newWorkspace.NewWorkspaceScreen = scopedNewWorkspace;
    if (titles) titles.selectAgentTabSidebarLabel = wrappedTitle;
  } catch (error) { restore(); throw error; }
  return restore;
}
