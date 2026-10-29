import assert from "node:assert/strict";
import { test } from "node:test";
import { pickConfig } from "../shared/model";

test("snapshots include only fields supported by the daemon config patch", () => {
  assert.deepEqual(pickConfig({
    providers: { claude: { env: { EXAMPLE: "synthetic" } } },
    skills: { disabled: ["example"] },
    browserTools: { enabled: true, unsupported: "local" },
    metadataGeneration: { providers: ["claude"], unsupported: true },
    mcp: { injectIntoAgents: false, custom: "local" },
    appendSystemPrompt: "example",
    relay: { enabled: true },
  }), {
    providers: { claude: { env: { EXAMPLE: "synthetic" } } },
    browserTools: { enabled: true }, metadataGeneration: { providers: ["claude"] },
    mcp: { injectIntoAgents: false }, appendSystemPrompt: "example",
  });
  assert.deepEqual(pickConfig({ browserTools: {}, mcp: { custom: "local" }, metadataGeneration: null }), {});
});
