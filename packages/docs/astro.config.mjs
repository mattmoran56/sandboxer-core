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
        // The tool is documented alongside code that is still being written. The
        // Banner override shows that notice on every page, which the config-level
        // banner cannot do. The Head override loads the diagram renderer.
        Banner: "./src/components/Banner.astro",
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
        {
          label: "Introduction",
          items: [
            { label: "Overview", slug: "introduction" },
            { label: "What sandboxr is", slug: "introduction/what-it-is" },
            { label: "When to use it", slug: "introduction/when-to-use" },
          ],
        },
        {
          label: "What is where, and how it works",
          items: [
            { label: "Overview", slug: "orientation" },
            { label: "The repository map", slug: "orientation/repository-map" },
            { label: "The life of a sandbox", slug: "orientation/life-of-a-sandbox" },
            { label: "Where everything lives", slug: "orientation/where-things-live" },
          ],
        },
        {
          label: "Getting started",
          items: [
            { label: "Overview", slug: "getting-started" },
            { label: "Prerequisites", slug: "getting-started/prerequisites" },
            { label: "Set up your machine", slug: "getting-started/setup" },
            { label: "Your first sandbox", slug: "getting-started/first-sandbox" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Overview", slug: "guides" },
            { label: "Start, stop, list, clean up", slug: "guides/lifecycle" },
            { label: "The edit–reload loop", slug: "guides/edit-and-reload" },
            { label: "Logs, shells and terminals", slug: "guides/logs-and-shells" },
            { label: "The dashboard", slug: "guides/dashboard" },
            { label: "Testing a migration", slug: "guides/testing-a-migration" },
            { label: "Agents in a sandbox", slug: "guides/agents-in-a-sandbox" },
          ],
        },
        {
          label: "Configuring a project",
          items: [
            { label: "Overview", slug: "configuration" },
            { label: "sandboxr.yaml, field by field", slug: "configuration/sandboxr-yaml" },
            { label: "Three runtime kinds", slug: "configuration/runtime-kinds" },
            { label: "Secrets", slug: "configuration/secrets" },
            { label: "Example: a MySQL monorepo", slug: "configuration/example-monorepo" },
            { label: "Example: Workers on D1", slug: "configuration/example-workers" },
          ],
        },
        {
          label: "Databases",
          items: [
            { label: "Overview", slug: "databases" },
            { label: "The driver model", slug: "databases/drivers" },
            { label: "MySQL: the hard case", slug: "databases/mysql" },
            { label: "D1 and SQLite: the easy case", slug: "databases/d1-sqlite" },
          ],
        },
        {
          label: "Access and security",
          items: [
            { label: "Overview", slug: "security" },
            { label: "The two tiers", slug: "security/two-tiers" },
            { label: "Public sandboxes", slug: "security/public-sandboxes" },
          ],
        },
        {
          label: "Architecture",
          items: [
            { label: "Overview", slug: "architecture" },
            { label: "How a request arrives", slug: "architecture/request-path" },
            { label: "The startup graph", slug: "architecture/startup" },
            { label: "plan.json, the container boundary", slug: "architecture/plan-json" },
            { label: "State lives in labels", slug: "architecture/state" },
            { label: "Design decisions", slug: "architecture/decisions" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Overview", slug: "reference" },
            { label: "CLI commands", slug: "reference/cli" },
            { label: "Configuration schema", slug: "reference/config-schema" },
            { label: "Environment variables", slug: "reference/environment" },
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
