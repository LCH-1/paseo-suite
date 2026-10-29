import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVendorCredential } from "../shared/provider-credentials";

test("Claude export keeps the issuing client and refresh expiry needed for renewal", () => {
  const oauth = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: 2_000_000_000_000, refreshTokenExpiresAt: 2_100_000_000_000, clientId: "synthetic-client", scopes: ["user:inference"], subscriptionTypeSource: "profile", subscriptionTypeVerifiedAt: 1_900_000_000_000, unrelated: "not-exported" };
  const actual = normalizeVendorCredential("claude", { claudeAiOauth: oauth });
  const { unrelated: _unrelated, ...expected } = oauth;
  assert.deepEqual(actual, { claudeAiOauth: expected });
});
