import assert from "node:assert/strict";
import test from "node:test";
import { codexAccessFailure, continuedAfterLimit, LIMIT_CONTINUATION, limitResetAt, limitSignal, modelFamily, needsAuthenticationRecovery, needsLimitRecovery } from "./auth-recovery.ts";

const error = "Failed to authenticate: OAuth session expired and could not be refreshed";
const failed = { kind: "failed", error: { message: error } };
const completed = { kind: "completed" };

test("실패 코드와 성공 결과에 실린 실제 인증 오류를 감지한다", () => {
  assert.equal(needsAuthenticationRecovery(failed), true);
  assert.equal(needsAuthenticationRecovery({ kind: "failed", error: { message: "Claude run failed", code: "authentication_failed" } }), true);
  assert.equal(needsAuthenticationRecovery(completed, [{ type: "assistant_message", text: error }]), true);
  assert.equal(needsAuthenticationRecovery(completed, [{ type: "assistant_message", text: "Not logged in · Please run /login" }]), true);
});

test("CLI가 반환하는 401 인증 오류와 OAuth 철회 오류도 복구한다", () => {
  for (const message of [
    'API Error: 401 {"error":{"type":"authentication_error","message":"Invalid bearer token"}}',
    'API Error: 403 {"error":{"message":"OAuth token has been revoked"}}',
    "Invalid API key · Please run /login",
  ]) {
    assert.equal(needsAuthenticationRecovery({ kind: "failed", error: { message } }), true);
    assert.equal(needsAuthenticationRecovery(completed, [{ type: "assistant_message", text: message }]), true);
  }
  assert.equal(needsAuthenticationRecovery({ kind: "failed", error: { message: "API Error: 403 permission_error: model unavailable" } }), false);
  assert.equal(needsAuthenticationRecovery(completed, [{ type: "assistant_message", text: "API Error: 429 rate_limit_error" }]), false);
});

test("이전 턴 오류·사용자 인용·정상 설명·도구 결과는 인증 실패로 오인하지 않는다", () => {
  assert.equal(needsAuthenticationRecovery(completed, [{ type: "assistant_message", text: error }, { type: "user_message", text: "다시 확인" }]), false);
  assert.equal(needsAuthenticationRecovery(completed, [{ type: "assistant_message", text: error }, { type: "user_message", text: "다시 확인" }, { type: "assistant_message", text: "OK" }]), false);
  assert.equal(needsAuthenticationRecovery(completed, [{ type: "user_message", text: error }]), false);
  assert.equal(needsAuthenticationRecovery(completed, [{ type: "assistant_message", text: `오류는 다음과 같습니다: ${error}` }]), false);
  assert.equal(needsAuthenticationRecovery(completed, [{ type: "tool_call", text: error }]), false);
  assert.equal(needsAuthenticationRecovery({ kind: "canceled" }, [{ type: "assistant_message", text: error }]), false);
  assert.equal(needsAuthenticationRecovery({ kind: "failed", error: { message: "network unavailable" } }), false);
});

test("응답 텍스트로 온 CLI 한도 안내를 감지하고 한도를 설명하는 답변은 무시한다", () => {
  const notice = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Nov 10, 3pm (Asia/Seoul)";
  assert.equal(needsLimitRecovery(completed, [{ type: "assistant_message", text: notice }]), true);
  assert.equal(needsLimitRecovery({ kind: "failed", error: { message: notice } }), true);
  assert.equal(needsLimitRecovery(completed, [{ type: "assistant_message", text: "Claude usage limit reached|1793000000" }]), true);
  assert.equal(needsLimitRecovery(completed, [{ type: "assistant_message", text: "이 API는 rate limit이 있어 429를 처리해야 합니다." }]), false);
  assert.equal(needsLimitRecovery(completed, [{ type: "assistant_message", text: "The weekly limit reached by users is documented here." }]), false);
  assert.equal(needsLimitRecovery(completed, [{ type: "assistant_message", text: notice }, { type: "user_message", text: "continue" }]), false);
  assert.equal(needsLimitRecovery({ kind: "canceled" }, [{ type: "assistant_message", text: notice }]), false);
});

test("한도와 무관한 숫자·단어가 섞인 실패는 한도로 보지 않는다", () => {
  const failure = (message: string, code?: string) => needsLimitRecovery({ kind: "failed", error: { message, code } });
  for (const [message, code] of [
    ["Claude Code process exited with code 4294967295", "4294967295"],
    ["Claude Code process exited with code 429"],
    ["connect ECONNREFUSED 127.0.0.1:4290"],
    ["TypeError: Cannot read properties of undefined\n    at parse (file.ts:429:13)"],
    ["request to http://127.0.0.1:4293/v1 failed after 4290ms"],
    ["Context limit reached · /compact or /clear to continue"],
    ["Budget limit reached ($5.00 of $5.00); stopping background agents."],
    ["write failed: disk quota exceeded"],
    ["quota exceeded (os error 122)"],
    ["could not accelerate limited build"],
    ["unexpected quotation mark at line 3"],
  ] as const) assert.equal(failure(message, code), false, message);
  assert.equal(needsLimitRecovery(completed, [{ type: "assistant_message", text: "You've hit your fast limit" }]), false);
});

test("경계를 좁혀도 실제 한도 실패는 계속 감지한다", () => {
  const failure = (message: string, code?: string) => needsLimitRecovery({ kind: "failed", error: { message, code } });
  for (const [message, code] of [
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}'],
    ["Request failed with status code 429"],
    ["HTTP 429"],
    ["429 Too Many Requests"],
    ['{"error":{"code":429,"message":"Resource exhausted"}}'],
    ["Claude run failed", "429"],
    ["Claude run failed", "rate_limit_error"],
    ["insufficient_quota"],
    ["You exceeded your current quota, please check your plan and billing details."],
    ["Claude usage limit reached"],
    ["Rate limited. Please try again later."],
    ["monthly spend limit exceeded"],
    ["You've hit your weekly limit · resets Nov 14, 1pm (Asia/Seoul)"],
    ["You've hit your 5-hour limit · resets 3pm (Asia/Seoul) · progress saved"],
  ] as const) assert.equal(failure(message, code), true, message);
  assert.equal(needsLimitRecovery(completed, [{ type: "assistant_message", text: "You're out of usage credits · resets 3pm (Asia/Seoul)" }]), true);
  assert.equal(needsLimitRecovery(completed, [{ type: "assistant_message", text: "You've reached your Fable limit. Fable requires usage credits." }]), true);
});

test("한도 안내에서 초기화 시각과 모델 계열을 읽는다", () => {
  const at = Date.UTC(2026, 10, 10, 5, 0); // 14:00 in Asia/Seoul
  const minute = 60_000;
  assert.equal(limitResetAt("You've hit your 5-hour limit · resets 3pm (Asia/Seoul)", at), Date.UTC(2026, 10, 10, 6, 0) + minute);
  assert.equal(limitResetAt("You've hit your 5-hour limit · resets 3:30pm (Asia/Seoul)", at), Date.UTC(2026, 10, 10, 6, 30) + minute);
  // A time already past today means tomorrow: the CLI drops the date only within a day.
  assert.equal(limitResetAt("You've hit your limit · resets 1pm (Asia/Seoul)", at), Date.UTC(2026, 10, 11, 4, 0) + minute);
  assert.equal(limitResetAt("You've hit your weekly limit · resets Nov 14, 1pm (Asia/Seoul)", at), Date.UTC(2026, 10, 14, 4, 0) + minute);
  assert.equal(limitResetAt("You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your weekly limit resets Nov 12, 12am (Asia/Seoul)", at), Date.UTC(2026, 10, 11, 15, 0) + minute);
  assert.equal(limitResetAt("You've hit your weekly limit · resets Nov 14, 9:15am (America/New_York)", at), Date.UTC(2026, 10, 14, 14, 15) + minute);
  assert.equal(limitResetAt("You've hit your weekly limit · resets Jul 3, 9am (America/New_York)", Date.UTC(2026, 6, 1)), Date.UTC(2026, 6, 3, 13, 0) + minute);
  assert.equal(limitResetAt("You've hit your weekly limit · resets Jan 2, 2027, 1pm (Asia/Seoul)", Date.UTC(2026, 11, 30)), Date.UTC(2027, 0, 2, 4, 0) + minute);
  assert.equal(limitResetAt("You've hit your limit · resets 3pm", at, "Asia/Seoul"), Date.UTC(2026, 10, 10, 6, 0) + minute);
  assert.equal(limitResetAt(`Claude usage limit reached|${Math.floor(at / 1000) + 3600}`, at), at + 3_600_000);
  for (const unusable of [
    "You've hit your weekly limit",
    "You've hit your weekly limit · resets Nov 9, 1pm (Asia/Seoul)",
    "You've hit your weekly limit · resets Dec 25, 1pm (Asia/Seoul)",
    "You've hit your weekly limit · resets 3pm (Not/AZone)",
    "You've hit your weekly limit · resets 13pm (Asia/Seoul)",
    // Printed moments before it passed: this is not tomorrow's reset.
    "You've hit your 5-hour limit · resets 1:55pm (Asia/Seoul)",
    `Claude usage limit reached|${Math.floor(at / 1000) - 60}`,
  ]) assert.equal(limitResetAt(unusable, at), null, unusable);

  const weekly = limitSignal(completed, [{ type: "assistant_message", text: "You've hit your weekly limit · resets Nov 14, 1pm (Asia/Seoul)" }], at);
  assert.deepEqual(weekly, { resetsAt: Date.UTC(2026, 10, 14, 4, 0) + minute, family: null, period: "weekly" });
  assert.equal(limitSignal(completed, [{ type: "assistant_message", text: "You've hit your Opus limit · resets Nov 14, 1pm (Asia/Seoul)" }], at)?.family, "opus");
  assert.equal(limitSignal(completed, [{ type: "assistant_message", text: "You've reached your Fable limit. Fable requires usage credits." }], at)?.family, "fable");
  assert.deepEqual(limitSignal({ kind: "failed", error: { message: "API Error: 429 rate_limit_error" } }, [], at), { resetsAt: null, family: null, period: null });
  assert.equal(limitSignal(completed, [{ type: "assistant_message", text: "작업을 마쳤습니다." }], at), null);
  assert.equal(modelFamily("claude-opus-4-8[1m]"), "opus");
  assert.equal(modelFamily("default"), null);
  assert.equal(modelFamily(null), null);
});

test("모델 계열은 모델 ID의 claude-<계열> 부분에서 읽고 별칭은 알려진 계열 이름으로 읽는다", () => {
  assert.equal(modelFamily("claude-fable-5-2"), "fable");
  assert.equal(modelFamily("us.anthropic.claude-opus-4-1-20250805-v1:0"), "opus");
  assert.equal(modelFamily("claude-3-5-sonnet-20241022"), "sonnet");
  assert.equal(modelFamily("claude-omelette-1"), "omelette");
  assert.equal(modelFamily("Fable"), "fable");
  assert.equal(modelFamily("fable[1m]"), "fable");
  assert.equal(modelFamily(""), null);
});

test("Codex 실패는 계정 문제일 때만 접근 실패로 분류한다", () => {
  for (const message of [
    "unexpected status 401 Unauthorized: token expired",
    "chatgpt authentication required to read rate limits",
    "Authentication failed for the current account",
  ]) assert.equal(codexAccessFailure(message), "authentication", message);
  for (const message of [
    "exceeded retry limit, last status: 429 Too Many Requests",
    "unexpected status 403 Forbidden",
    "unexpected status 402 Payment Required",
    "Quota exceeded. Check your plan and billing details.",
    "Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.",
    "You've hit your usage limit. Try again in 3 days.",
    "rate limit exceeded: slow down",
    "error code: usage_limit_reached",
    "Your subscription has expired",
    "no active subscription for this account",
    "billing hard limit reached",
  ]) assert.equal(codexAccessFailure(message), "access", message);
  for (const message of [
    "codex process exited with code 4294967295",
    "error sending request for url (http://127.0.0.1:4010/v1/responses)",
    "stream disconnected before completion: line 429 column 3",
    "listening on 0.0.0.0:14293 failed",
    "MCP event subscription 'build' was not reserved before startup",
    "MCP event subscription authentication changed during startup",
    "failed to acknowledge subscription: transport closed",
    "subscription consumer lagged behind its notifications",
    "quota exceeded (os error 122)",
    "context window exceeded",
    "Codex turn failed",
  ]) assert.equal(codexAccessFailure(message), null, message);
});

test("이어가기 메시지로 시작한 턴은 다시 이어가지 않는다", () => {
  assert.equal(continuedAfterLimit([{ type: "user_message", text: "원래 요청" }, { type: "assistant_message", text: "You've hit your weekly limit" }]), false);
  assert.equal(continuedAfterLimit([{ type: "user_message", text: "원래 요청" }, { type: "user_message", text: LIMIT_CONTINUATION }, { type: "assistant_message", text: "You've hit your weekly limit" }]), true);
  assert.equal(continuedAfterLimit([{ type: "user_message", text: LIMIT_CONTINUATION }, { type: "assistant_message", text: "완료" }, { type: "user_message", text: "다음 요청" }]), false);
  assert.equal(continuedAfterLimit([]), false);
});

test("한도 안내가 가리키는 창을 5시간(세션)·주간으로 구분하고 모델 이름과 따로 읽는다", () => {
  const at = Date.UTC(2026, 10, 10, 5, 0);
  const notice = (text: string) => limitSignal(completed, [{ type: "assistant_message", text }], at);
  assert.deepEqual(notice("You've hit your 5-hour limit · resets 3pm (Asia/Seoul)"), { resetsAt: Date.UTC(2026, 10, 10, 6, 0) + 60_000, family: null, period: "five_hour" });
  assert.equal(notice("You've hit your five-hour limit")?.period, "five_hour");
  assert.equal(notice("Session limit reached ∙ resets 3pm (Asia/Seoul)")?.period, "five_hour");
  assert.equal(notice("You've hit your weekly limit · resets Nov 14, 1pm (Asia/Seoul)")?.period, "weekly");
  assert.deepEqual(notice("You've hit your weekly Opus limit · resets Nov 14, 1pm (Asia/Seoul)"), { resetsAt: Date.UTC(2026, 10, 14, 4, 0) + 60_000, family: "opus", period: "weekly" });
  assert.deepEqual(notice("You've hit your Fable limit · resets Nov 14, 1pm (Asia/Seoul)"), { resetsAt: Date.UTC(2026, 10, 14, 4, 0) + 60_000, family: "fable", period: null });
  const usage = notice("Claude usage limit reached. Your limit will reset at 3pm (Asia/Seoul).");
  assert.deepEqual(usage, { resetsAt: Date.UTC(2026, 10, 10, 6, 0) + 60_000, family: null, period: null });
});
