import assert from "node:assert/strict";
import test from "node:test";
import { GitHubVault, GIST_DESCRIPTION, GIST_FILENAME, REVISION_FILENAME } from "../server/github";

function fixture(revision: Record<string, unknown>, rawRevision = '{"version":1,"parents":[]}') {
  const downloads: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://gist.githubusercontent.com/")) {
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      assert.equal(init?.redirect, "error");
      downloads.push(url);
      return new Response(url.endsWith(REVISION_FILENAME) ? rawRevision : "ciphertext");
    }
    if (url.endsWith("/user")) return Response.json({ login: "example" });
    if (url.includes("/gists?")) return Response.json([{ id: "abc", public: false, description: GIST_DESCRIPTION, created_at: "2026-10-27T00:00:00Z", owner: { login: "example" }, files: { [GIST_FILENAME]: { filename: GIST_FILENAME }, [REVISION_FILENAME]: { filename: REVISION_FILENAME } } }]);
    return Response.json({ public: false, owner: { login: "example" }, history: [{ version: "v1" }], files: {
      [GIST_FILENAME]: { size: 1_175_179, truncated: true, content: "partial", raw_url: `https://gist.githubusercontent.com/example/abc/raw/v1/${GIST_FILENAME}` },
      [REVISION_FILENAME]: { size: 26, truncated: true, content: "", raw_url: `https://gist.githubusercontent.com/example/abc/raw/v1/${REVISION_FILENAME}`, ...revision },
    } });
  };
  return { vault: new GitHubVault("synthetic", request), downloads };
}

test("a large Gist can truncate its small revision file together with ciphertext", async () => {
  const f = fixture({});
  assert.deepEqual(await f.vault.read(), { sha: "abc:v1", raw: "ciphertext" });
  assert.equal(f.downloads.length, 2);
});

test("a revision omitted from inline content is fetched even without a truncated flag", async () => {
  const f = fixture({ content: undefined, truncated: false });
  assert.deepEqual(await f.vault.read(), { sha: "abc:v1", raw: "ciphertext" });
});

test("revision raw downloads retain host, account, Gist and size checks", async () => {
  for (const raw_url of ["https://example.com/example/abc/raw/revision", "https://gist.githubusercontent.com/other/abc/raw/revision", "https://gist.githubusercontent.com/example/def/raw/revision", "https://user@gist.githubusercontent.com/example/abc/raw/revision"]) {
    const f = fixture({ raw_url });
    await assert.rejects(f.vault.read(), /다운로드 경로/);
    assert.equal(f.downloads.length, 1);
  }
  const oversized = fixture({ size: 16_385 });
  await assert.rejects(oversized.vault.read(), /크기 제한/);
  assert.equal(oversized.downloads.length, 1);
  await assert.rejects(fixture({}, " ".repeat(16_385)).vault.read(), /크기 제한/);
  await assert.rejects(fixture({}, '{"version":1,"parents":["invalid"]}').vault.read());
});
