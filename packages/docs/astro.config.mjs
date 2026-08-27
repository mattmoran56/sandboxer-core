// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

import { rehypeDocLinks, rehypeGithubAlerts, remarkMermaid } from "./plugins/markdown.mjs";

export default defineConfig({
  // The pages live in the repository's `docs/` directory so they can be read on
  // GitHub without building anything. See src/content.config.ts.
  markdown: {
    remarkPlugins: [remarkMermaid],
    rehypePlugins: [rehypeGithubAlerts, rehypeDocLinks],
  },
  integrations: [
    starlight({
      title: "sandboxr",
      description:
        "Turn any git worktree into a running copy of a whole project, on its own hostname.",
      components: {
        // The Head override loads the diagram renderer.
        Head: "./src/components/Head.astro",
      },
      social: {
        github: "https://github.com/mattmoran56/sandboxr",
      },
      editLink: {
        baseUrl: "https://github.com/mattmoran56/sandboxr/edit/main/docs/",
      },
      customCss: ["./src/styles/custom.css"],
      lastUpdated: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        { label: "Introduction", slug: "introduction" },
        { label: "How it works", slug: "how-it-works" },
        {
          label: "Getting started",
          items: [
            { label: "Overview", slug: "getting-started" },
            { label: "Install it", slug: "getting-started/install" },
            { label: "Your first sandbox", slug: "getting-started/first-sandbox" },
            { label: "Every worktree at once", slug: "getting-started/every-worktree" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Overview", slug: "guides" },
            { label: "Start, stop, list, clean up", slug: "guides/lifecycle" },
            { label: "The edit\u2013reload loop", slug: "guides/edit-and-reload" },
            { label: "Logs, shells and terminals", slug: "guides/logs-and-shells" },
            { label: "The dashboard", slug: "guides/dashboard" },
            { label: "Projects, worktrees and lifetimes", slug: "guides/managed-sandboxes" },
            { label: "Testing a migration", slug: "guides/testing-a-migration" },
            { label: "Agents in a sandbox", slug: "guides/agents-in-a-sandbox" },
            { label: "Agent sessions", slug: "guides/agent-sessions" },
          ],
        },
        {
          label: "Configuring a project",
          items: [
            { label: "Overview", slug: "configuration" },
            { label: "sandboxr.yaml, field by field", slug: "configuration/sandboxr-yaml" },
            { label: "Three runtime kinds", slug: "configuration/runtime-kinds" },
            { label: "Secrets", slug: "configuration/secrets" },
            { label: "Two worked examples", slug: "configuration/examples" },
          ],
        },
        { label: "Databases", slug: "databases" },
        { label: "Access and security", slug: "access" },
        {
          label: "Architecture",
          items: [
            { label: "Overview", slug: "architecture" },
            { label: "How a request arrives", slug: "architecture/request-path" },
            { label: "The startup graph", slug: "architecture/startup" },
            { label: "plan.json", slug: "architecture/plan-json" },
            { label: "State lives in labels", slug: "architecture/state" },
            { label: "Design decisions", slug: "architecture/decisions" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Overview", slug: "reference" },
            { label: "CLI commands", slug: "reference/cli" },
            { label: "Environment variables", slug: "reference/environment" },
            { label: "Paths", slug: "reference/paths" },
            { label: "Glossary", slug: "reference/glossary" },
            { label: "What is built", slug: "reference/status" },
          ],
        },
        {
          label: "Elsewhere",
          items: [
            { label: "Running on a server", slug: "running-on-a-server" },
            { label: "Troubleshooting", slug: "troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
