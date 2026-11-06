import assert from "node:assert/strict";
import test from "node:test";
import { needsAuthenticationRecovery, needsLimitRecovery } from "./auth-recovery.ts";

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
