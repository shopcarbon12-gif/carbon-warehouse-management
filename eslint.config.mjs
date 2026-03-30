import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local SDKs / caches (eslint was scanning Gradle + pub-cache → OOM)
    ".tools/**",
    "mobile/carbon_wms/build/**",
    "mobile/carbon_wms/.dart_tool/**",
    "mobile/carbon_wms/android/.gradle/**",
    "coverage/**",
  ]),
]);

export default eslintConfig;
