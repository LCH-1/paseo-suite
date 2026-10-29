const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const core = path.resolve(
  process.env.PASEO_CORE_ROOT || path.join(root, "../paseo-core"),
);
const requireCore = createRequire(path.join(core, "package.json"));
const yaml = requireCore("yaml");
const base = yaml.parse(
  fs.readFileSync(
    path.join(core, "packages/desktop/electron-builder.yml"),
    "utf8",
  ),
);
module.exports = {
  ...base,
  afterPack: requireCore(
    path.join(core, "packages/desktop/scripts/after-pack.js"),
  ).default,
  afterSign: requireCore(
    path.join(core, "packages/desktop/scripts/after-sign.js"),
  ).default,
  extraMetadata: { version: "1.0.0" },
  directories: {
    ...base.directories,
    output: path.join(root, "dist/installers"),
  },
  extraResources: [
    ...base.extraResources,
    { from: path.join(root, "dist/plugins"), to: "suite/plugins" },
    { from: path.join(root, "dist/compatibility"), to: "suite/compatibility" },
    {
      from: path.join(root, "dist/suite-lock.json"),
      to: "suite/suite-lock.json",
    },
    { from: path.join(root, "dist/bootstrap.mjs"), to: "suite/bootstrap.mjs" },
    {
      from: path.join(root, "dist/bundled-setup.json"),
      to: "bundled-setup.json",
    },
  ],
  publish: {
    provider: "github",
    owner: "LCH-1",
    repo: "paseo-suite",
    private: true,
  },
  nsis: { ...base.nsis, include: path.join(root, "tools/installer.nsh") },
  win: {
    ...base.win,
    artifactName: "Paseo-Suite-1.0.0-${arch}.${ext}",
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  mac: { ...base.mac, artifactName: "Paseo-Suite-1.0.0-${arch}.${ext}" },
};
