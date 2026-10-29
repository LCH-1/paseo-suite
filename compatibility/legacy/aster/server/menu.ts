export const menuReplacements = [
  {
    before: "e.buildProviderSelectorProviders=function(o){return o.providerDefinitions.slice()",
    after: 'e.buildProviderSelectorProviders=function(o){return o.providerDefinitions.filter((v,i,a)=>!v.id.startsWith("claude-")||!a.some(p=>p.id==="claude")).slice()',
  },
  {
    before: "e.buildSelectableProviderSelectorProviders=function(o,n=!0){return(o??[]).filter(o=>o.enabled).slice()",
    after: 'e.buildSelectableProviderSelectorProviders=function(o,n=!0){return(o??[]).filter((v,i,a)=>v.enabled&&(!v.provider.startsWith("claude-")||!a.some(p=>p.provider==="claude"&&p.enabled))).slice()',
  },
];

export function patchClaudeMenu(bundle: string) {
  let result = bundle;
  for (const { before, after } of menuReplacements) {
    if (result.split(after).length === 2) continue;
    if (result.split(before).length !== 2) throw new Error("Paseo 메뉴 코드가 예상 버전과 다릅니다. 파일을 수정하지 않았습니다.");
    result = result.replace(before, after);
  }
  return result;
}

export function singleClaudePresentation<T extends { id: string; name: string; provider: string }>(
  profiles: T[],
  providers: Record<string, { label?: string; extends?: string; enabled?: boolean }>,
) {
  const claudeIds = new Set(Object.keys(providers).filter((id) => id === "claude" || providers[id].extends === "claude"));
  return {
    profiles: profiles.filter((profile) => !claudeIds.has(profile.provider)),
    labels: [...claudeIds].map((id) => ({ id, label: "Claude" })),
  };
}
