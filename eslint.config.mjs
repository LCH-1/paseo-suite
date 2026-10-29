import tseslint from "typescript-eslint";
export default tseslint.config({
  ignores: ["node_modules/**", "dist/**", ".local/**", ".check/**", "plugins/**/modules/**", "plugins/aster/**", "plugins/settings-sync/**"],
}, {
  files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } } },
  rules: { "no-dupe-keys": "error", "no-unreachable": "error", "no-constant-condition": "error" },
});
