export function profileDiscovery(discover: (scope: any) => Promise<any[]>, providers: () => Promise<{ id: string; env: Record<string, string> }[]>) {
  return async (scope: any) => {
    if (scope.kind === "session") return discover(scope);
    const configured = (await providers()).filter(provider => provider.id === "claude" || provider.id.startsWith("claude-"));
    const accounts = [];
    for (const provider of configured) {
      try {
        accounts.push(...await discover({ kind: "session", agentId: "aster-profile-usage", provider: provider.id, env: { ...process.env, ...provider.env } }));
      } catch {
        console.warn("[aster] Claude 프로필 사용량 조회를 보류했습니다. 다른 계정은 계속 확인합니다.");
      }
    }
    return [...new Map(accounts.map(account => [account.key, account])).values()];
  };
}
