import assert from "node:assert/strict";
import test from "node:test";
import { needsAuthenticationRecovery } from "./auth-recovery.ts";

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
