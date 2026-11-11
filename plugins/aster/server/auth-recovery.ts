const authenticationMessage = /^(?:Failed to authenticate:|OAuth session expired and could not be refreshed(?:[.!]|$)|Not logged in\s*[·-]\s*Please run \/login)/i;
const isAuthenticationMessage = (message: string) => authenticationMessage.test(message)
  || /^Invalid API key\s*[·-]\s*Please run \/login/i.test(message)
  || /^API Error:\s*40[13]\b/i.test(message) && /authentication_error|OAuth (?:access )?token.*(?:expired|revoked)|invalid (?:bearer|access) token/i.test(message);

// A status code counts only beside its own label or reason phrase: the same digits also sit in ports, line numbers and exit codes.
const httpStatus = (codes: string) =>
  String.raw`\b(?:status(?:[ _]?code)?|https?(?:\/[\d.]+)?|(?:api )?error(?:[ _]?code)?|(?<!\bexit(?:ed with)? )code)["']?\s*[:=(]?\s*["']?(?:${codes})\b(?!\.\d)|\b(?:${codes}) (?:unauthorized|payment required|forbidden|too many requests)\b`;
const limitWords = [
  String.raw`(?<![a-z])(?:rate|usage|spend)[ _.-]?limit`,
  // A full disk reports a quota too, and that says nothing about the account.
  String.raw`(?<![a-z])(?<!disk )quota(?:s|[ _-]?(?:exceeded|exhausted|limit))?(?![a-z])(?![^.\n]{0,20}\(os error)`,
];

// CLI notices for an exhausted account; anchored so a reply that merely discusses limits never matches.
const limitNotice = /^(?:(?:API )?Error:\s*)?(?:you(?:'|\u2019)ve (?:hit|reached) your\b(?! fast\b)[^\n]{0,60}\blimit\b|you(?:'|\u2019)re out of usage credits\b|(?:claude(?: code| ai)? )?usage limit reached\b|(?:session |weekly |monthly |opus |fable )?limit reached\b)/i;
const failedLimit = new RegExp(
  [
    ...limitWords,
    // Context, budget and tool limits end a turn without the account being out of quota.
    String.raw`(?<!\b(?:context|budget|token|turn|retry|subagent|nesting|export|size|recursion|depth|time|output|length) )\blimit reached\b`,
    httpStatus("429"),
  ].join("|"),
  "i",
);
const limitCode = /^(?:429|rate_limit(?:_error|_exceeded)?|usage_limit(?:_reached|_exceeded)?|insufficient_quota|quota_exceeded)$/i;

const codexAuthentication = new RegExp(
  [
    httpStatus("401"),
    String.raw`\b(?:unauthori[sz]ed|unauthenticated)\b`,
    String.raw`\bauthentication[ _](?:required|failed|failure|error|expired|token)\b`,
  ].join("|"),
  "i",
);
const codexAccess = new RegExp(
  [
    httpStatus("402|403|429"),
    ...limitWords,
    // Codex also names MCP event subscriptions; only an account's own subscription is an access failure.
    String.raw`\b(?:your|no|active|paid|valid|chatgpt|codex) subscription\b|\bsubscription[ _](?:required|inactive|expired|ended|cancell?ed|has|is)\b`,
    String.raw`\bbilling\b`,
  ].join("|"),
  "i",
);

/** Whether a failed Codex turn points at the account: its login, or its plan and limits. */
export function codexAccessFailure(message: string): "authentication" | "access" | null {
  if (codexAuthentication.test(message)) return "authentication";
  return codexAccess.test(message) ? "access" : null;
}

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// The CLI prints "3pm", "3:30pm" or "Nov 14, 1pm", adds the year only when it differs, and names the zone in parentheses.
const resetTime = new RegExp(
  String.raw`\bresets?(?: at)? (?:(?<month>${months.join("|")})[a-z]* (?<day>\d{1,2}),?(?: (?<year>\d{4}),?)?(?: at)? )?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?(?<meridiem>[ap])m\b(?: \((?<zone>[\w+/-]+)\))?`,
  "i",
);
const longestReset = 8 * 86_400_000;

function zoned(at: number, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(at).map((part) => [part.type, Number(part.value)]),
  );
  return { year: parts.year, month: parts.month - 1, day: parts.day, offset: Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000 };
}

/** When the limit named in a CLI notice lifts, or null when the notice gives no usable time. */
export function limitResetAt(text: string, now: number, localZone = Intl.DateTimeFormat().resolvedOptions().timeZone): number | null {
  const within = (at: number) => (at > now && at - now <= longestReset ? at : null);
  const epoch = /\blimit reached\|(\d{10})\b/i.exec(text);
  if (epoch) return within(Number(epoch[1]) * 1000);
  const match = resetTime.exec(text)?.groups;
  if (!match) return null;
  const hour = Number(match.hour), minute = Number(match.minute ?? 0), zone = match.zone ?? localZone;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  try {
    const today = zoned(now, zone);
    const at = (year: number, month: number, day: number) => {
      const wall = Date.UTC(year, month, day, (hour % 12) + (match.meridiem.toLowerCase() === "p" ? 12 : 0), minute);
      // The printed time drops the seconds, so the limit can lift up to a minute later.
      return wall - zoned(wall - zoned(wall, zone).offset, zone).offset + 60_000;
    };
    if (match.month) return within(at(match.year ? Number(match.year) : today.year, months.indexOf(match.month.toLowerCase()), Number(match.day)));
    const first = at(today.year, today.month, today.day);
    if (first > now) return within(first);
    // A time that passed moments ago far more likely just lifted than names the same time tomorrow.
    return now - first < 10 * 60_000 ? null : within(at(today.year, today.month, today.day + 1));
  } catch {
    return null;
  }
}

export interface LimitSignal {
  /** When the CLI says the limit lifts. */
  resetsAt: number | null;
  /** The model family the limit names, when it is not the whole account's. */
  family: string | null;
}

function describeLimit(text: string, now: number): LimitSignal {
  const line = text.split("\n", 1)[0].slice(0, 400);
  return { resetsAt: limitResetAt(line, now), family: modelFamily(/\b(?:opus|sonnet|haiku|fable)\b(?=[^\n·|]{0,20}\blimit\b)/i.exec(line)?.[0]) };
}

/** The family a model ID belongs to (`claude-<family>-…`), or the known family an alias names. */
export function modelFamily(model: string | null | undefined) {
  const id = (model ?? "").trim().toLowerCase();
  return /(?:^|[^a-z])claude-([a-z]+)(?![a-z])/.exec(id)?.[1] ?? /opus|sonnet|haiku|fable/.exec(id)?.[0] ?? null;
}

/** The limit a turn ran into, or null when the turn did not end on one. */
export function limitSignal(
  outcome: { kind: string; error?: { message: string; code?: string } },
  timeline: readonly { type: string; text?: string }[] = [],
  now = Date.now(),
): LimitSignal | null {
  if (outcome.kind === "canceled") return null;
  if (outcome.kind === "failed" && outcome.error) {
    const message = outcome.error.message.trim();
    if (limitNotice.test(message) || failedLimit.test(message) || limitCode.test(outcome.error.code ?? ""))
      return describeLimit(message, now);
  }
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item.type === "user_message") return null;
    if (item.type === "assistant_message") {
      const text = item.text?.trim() ?? "";
      return limitNotice.test(text) ? describeLimit(text, now) : null;
    }
  }
  return null;
}

export function needsLimitRecovery(
  outcome: { kind: string; error?: { message: string; code?: string } },
  timeline: readonly { type: string; text?: string }[] = [],
) {
  return limitSignal(outcome, timeline) !== null;
}

const continuationTag = "[Aster 자동 이어가기]";
/** Sent once after a limit moved the session to another account, and only when the user opted in. */
export const LIMIT_CONTINUATION = `${continuationTag} 이전 턴이 계정 사용 한도로 중단되어 다른 계정으로 전환했습니다. 원래 요청과 이미 완료된 작업을 검토한 뒤, 완료된 작업은 반복하지 말고 남은 작업만 이어서 진행하세요.`;

/** Whether the turn that just ended was itself started by the continuation message. */
export function continuedAfterLimit(timeline: readonly { type: string; text?: string }[]) {
  for (let index = timeline.length - 1; index >= 0; index--)
    if (timeline[index].type === "user_message") return timeline[index].text?.includes(continuationTag) === true;
  return false;
}

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
