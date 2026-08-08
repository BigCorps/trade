import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // These pages intentionally start async data hydration from effects after
    // the Supabase session is known. React's rule also flags the state updates
    // inside the called async functions, even though they do not run during
    // render and are guarded by the session lifecycle.
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Supabase Edge Functions run in Deno and use generated/runtime-shaped
    // records at the API boundary. Keep the stricter rule for the Next.js app,
    // but do not turn deliberately dynamic database payloads into lint errors.
    files: ["supabase/functions/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
