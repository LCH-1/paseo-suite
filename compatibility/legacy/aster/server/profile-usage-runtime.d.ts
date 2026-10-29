export const inputSchema: any;
export function discover(scope: any): Promise<any[]>;
export function fetchUsage(input: any): Promise<any>;
export function configuredClaudeProviders(): Promise<{id: string; env: Record<string,string>}[]>;
