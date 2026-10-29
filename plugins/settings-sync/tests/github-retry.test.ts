import assert from "node:assert/strict";
import test from "node:test";
import { GitHubError, GitHubVault, GIST_DESCRIPTION, GIST_FILENAME } from "../server/github";

test("transient GET failures retry on a fresh connection without sending auth to raw Gists", async () => {
  let identity = 0, raw = 0;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/user")) {
      if (++identity === 1) return new Response("temporary", { status: 502 });
      assert.equal(new Headers(init?.headers).get("Connection"), "close");
      return Response.json({ login: "example" });
    }
    if (url.includes("/gists?")) return Response.json([{ id: "abc", public: false, description: GIST_DESCRIPTION, created_at: "2026-10-26T00:00:00Z", owner: { login: "example" }, files: { [GIST_FILENAME]: { filename: GIST_FILENAME } } }]);
    if (url.startsWith("https://gist.githubusercontent.com/")) {
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      if (++raw === 1) return new Response("temporary", { status: 503 });
      assert.equal(new Headers(init?.headers).get("Connection"), "close");
      return new Response("encrypted");
    }
    return Response.json({ public: false, owner: { login: "example" }, history: [{ version: "version" }], files: { [GIST_FILENAME]: { size: 1_100_000, truncated: true, raw_url: `https://gist.githubusercontent.com/example/abc/raw/version/${GIST_FILENAME}` } } });
  };
  assert.deepEqual(await new GitHubVault("synthetic", request).read(), { sha: "abc:version", raw: "encrypted" });
  assert.equal(identity, 2);
  assert.equal(raw, 2);
});

test("persistent GET failure is bounded and authentication failures do not retry", async () => {
  for (const status of [502, 401]) {
    let calls = 0;
    const vault = new GitHubVault("synthetic", async () => { calls++; return new Response("failure", { status }); });
    await assert.rejects(vault.verify(), (error: unknown) => error instanceof GitHubError && error.status === status);
    assert.equal(calls, status === 502 ? 3 : 1);
  }
});

test("ambiguous failed Gist creation never retries POST", async () => {
  let posts = 0;
  const vault = new GitHubVault("synthetic", async (input, init) => {
    if (String(input).endsWith("/user")) return Response.json({ login: "example" });
    if (init?.method === "POST") { posts++; return new Response("temporary", { status: 502 }); }
    return Response.json([]);
  });
  await assert.rejects(vault.write("encrypted", null), (error: unknown) => error instanceof GitHubError && error.status === 502);
  assert.equal(posts, 1);
});

test("production read recovery can use a fresh process while keeping request credentials scoped", async () => {
  let initial = 0, fresh = 0;
  const vault = new GitHubVault("synthetic", async () => { initial++; return new Response("temporary", { status: 502 }); }, async (url, init) => {
    fresh++;
    assert.equal(String(url), "https://api.github.com/user");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic");
    return Response.json({ login: "example" });
  });
  assert.equal(await vault.verify(), "example");
  assert.equal(initial, 1);
  assert.equal(fresh, 1);
});
