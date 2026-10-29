const authenticationMessage = /^(?:Failed to authenticate:|OAuth session expired and could not be refreshed(?:[.!]|$)|Not logged in\s*[·-]\s*Please run \/login)/i;
const isAuthenticationMessage = (message: string) => authenticationMessage.test(message)
  || /^Invalid API key\s*[·-]\s*Please run \/login/i.test(message)
  || /^API Error:\s*40[13]\b/i.test(message) && /authentication_error|OAuth (?:access )?token.*(?:expired|revoked)|invalid (?:bearer|access) token/i.test(message);

export function needsAuthenticationRecovery(
  outcome: { kind: string; error?: { message: string; code?: string } },
  timeline: readonly { type: string; text?: string }[] = [],
) {
  if (outcome.kind === "canceled") return false;
  if (outcome.kind === "failed" && outcome.error && (
    isAuthenticationMessage(outcome.error.message.trim()) ||
    /^(?:authentication_failed|invalid_authentication|unauthorized)$/i.test(outcome.error.code ?? "")
  )) return true;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.type === "user_message") return false;
    if (item.type === "assistant_message") return isAuthenticationMessage(item.text?.trim() ?? "");
  }
  return false;
}
