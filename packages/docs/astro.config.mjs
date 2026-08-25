// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    starlight({
      title: "sandboxr",
      description:
        "Turn any git worktree into a running copy of a whole project, on its own hostname.",
      // The tool is still being built. The Banner override shows the "documented ahead of
      // the code" notice on every page, which the config-level banner cannot do.
      components: {
        Banner: "./src/components/Banner.astro",
      },
      social: {
        github: "https://github.com/mattmoran56/sandboxr",
      },
      editLink: {
        baseUrl: "https://github.com/mattmoran56/sandboxr/edit/main/packages/docs/",
      },
      customCss: ["./src/styles/custom.css"],
      lastUpdated: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        {
          label: "Introduction",
          items: [
            { label: "What sandboxr is", slug: "introduction/what-it-is" },
            { label: "When to use it", slug: "introduction/when-to-use" },
          ],
        },
        {
          label: "What is where, and how it works",
          items: [
            { label: "The map", slug: "orientation/map" },
            { label: "The life of a sandbox", slug: "orientation/life-of-a-sandbox" },
            { label: "Where everything lives", slug: "orientation/where-things-live" },
          ],
        },
        {
          label: "Getting started",
          items: [
            { label: "Prerequisites", slug: "start/prerequisites" },
            { label: "Set up your machine", slug: "start/setup" },
            { label: "Your first sandbox", slug: "start/first-sandbox" },
          ],
        },
        {
          label: "Everyday use",
          items: [
            { label: "Start, stop, list, clean up", slug: "use/lifecycle" },
            { label: "The edit–reload loop", slug: "use/edit-and-reload" },
            { label: "Logs, shells and terminals", slug: "use/logs-and-shells" },
            { label: "The dashboard", slug: "use/dashboard" },
          ],
        },
        {
          label: "Configuring a project",
          items: [
            { label: "sandboxr.yaml, field by field", slug: "config/sandboxr-yaml" },
            { label: "Three runtime kinds", slug: "config/runtime-kinds" },
            { label: "Secrets", slug: "config/secrets" },
            { label: "Example: a MySQL monorepo", slug: "config/example-mysql-monorepo" },
            { label: "Example: Workers on D1", slug: "config/example-workers-d1" },
          ],
        },
        {
          label: "Databases",
          items: [
            { label: "The driver model", slug: "databases/drivers" },
            { label: "MySQL: the hard case", slug: "databases/mysql" },
            { label: "D1 and SQLite: the easy case", slug: "databases/d1-sqlite" },
            { label: "Testing a migration", slug: "databases/testing-a-migration" },
          ],
        },
        {
          label: "Access and security",
          items: [
            { label: "The two tiers", slug: "security/two-tiers" },
            { label: "Public sandboxes", slug: "security/public-sandboxes" },
          ],
        },
        {
          label: "Running on a server",
          items: [{ label: "Deployment guide", slug: "server/deployment" }],
        },
        {
          label: "Agents",
          items: [{ label: "Agents in a sandbox", slug: "agents/in-a-sandbox" }],
        },
        {
          label: "Architecture",
          items: [
            { label: "How a request arrives", slug: "architecture/request-path" },
            { label: "The startup graph", slug: "architecture/startup" },
            { label: "plan.json, the container boundary", slug: "architecture/plan-json" },
            { label: "State lives in labels", slug: "architecture/state" },
            { label: "Design decisions", slug: "architecture/decisions" },
          ],
        },
        {
          label: "Troubleshooting",
          items: [{ label: "Symptom to cause", slug: "troubleshooting/symptom-to-cause" }],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI commands", slug: "reference/cli" },
            { label: "Environment variables", slug: "reference/environment" },
            { label: "Config schema", slug: "reference/config-schema" },
            { label: "Glossary", slug: "reference/glossary" },
            { label: "What is built", slug: "reference/status" },
          ],
        },
      ],
    }),
  ],
});
