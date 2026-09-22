/**
 * This tool's own version, which the `sandboxer:` constraint in a project's
 * config is checked against.
 *
 * A constant rather than a read of package.json: the published package is
 * bundled to `dist/`, where package.json sits at a different relative depth
 * than it does in the source tree, and a version check that resolves
 * differently in development and in production is worse than no check.
 * Kept in step with packages/core/package.json.
 */
export const TOOL_VERSION = "0.1.0";
