import { defineWorkspace } from "vitest/config";

import { emptyContent } from "./vitest.config.js";

// Split by extension, the same way the dashboard splits: `.test.ts` is logic and
// runs in `node`, `.test.tsx` renders into jsdom. Which environment a file gets is
// then visible in its name and never a configuration somebody has to look up.
//
// Almost everything in this package is in the first half on purpose. The markdown
// pipeline, the route derivation, the nav↔files check and the search scoring are
// all string in, string out — and a pipeline that can only be tested by rendering
// a page is a pipeline whose failures arrive as a blank article.
export default defineWorkspace([
  {
    plugins: [emptyContent()],
    test: {
      name: "logic",
      include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "build/**/*.test.ts"],
      environment: "node",
    },
  },
  {
    plugins: [emptyContent()],
    test: {
      name: "ui",
      include: ["src/**/*.test.tsx"],
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
      restoreMocks: true,
    },
  },
]);
