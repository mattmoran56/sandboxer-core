/**
 * @sandboxr/core — the public surface every other package depends on.
 *
 * Nothing outside this file is a contract. The names below are fixed by
 * docs/architecture/contracts.md; a package that disagrees with them is a bug.
 */

export type {
  AccessConfig,
  BackendService,
  DatabaseConfig,
  DriverName,
  FrontendApp,
  MigrateConfig,
  ProjectConfig,
  ResolvedConfig,
  RouteMap,
  SeedFrom,
  SecretsConfig,
  StorageConfig,
  ToolchainConfig,
} from "./config/types.js";
export { ConfigError, findConfig, loadConfig, projectPath, resolveConfig, CONFIG_FILENAME } from "./config/load.js";
export type { LoadOptions } from "./config/load.js";
export { allowsRealCredentials, permittedSeeds, publicAccessViolations } from "./config/access.js";
export type { AccessViolation } from "./config/access.js";
export { configSchema } from "./config/schema.js";
export { compareVersions, parseVersion, satisfies, VersionError } from "./config/version.js";
export { TOOL_VERSION } from "./tool-version.js";

export {
  DEFAULT_DOMAIN,
  NETWORK,
  NamingError,
  SHARED_VOLUMES,
  SLUG_MAX,
  containerName,
  depsVolumeName,
  deriveSlug,
  hostFor,
  lockName,
  parseContainerName,
  sanitizeSlug,
  urlFor,
  volumeName,
} from "./naming.js";
export type { DeriveSlugInput, HostParts, VolumePurpose } from "./naming.js";

export { directoriesOf, paths, type Paths } from "./paths.js";

export { docker, createDocker, DockerError, type Docker, type ExecResult } from "./docker.js";

export type { DatabaseDriver, DriverContext, MigrateResult, SeedArtifact } from "./drivers/types.js";
export { DriverError, driverContext, getDriver, driverNames } from "./drivers/index.js";
export type { ContextOptions } from "./drivers/index.js";

export { down, gc, list, reload, status, up } from "./sandbox/index.js";
export type {
  DownOptions,
  GcOptions,
  GcPlan,
  ListOptions,
  ReloadOptions,
  Sandbox,
  SandboxState,
  SandboxStatus,
  UpOptions,
} from "./sandbox/types.js";
export { LABELS, labelsFor, sandboxFromLabels, deriveState } from "./sandbox/labels.js";

export { checkSecrets, importSecrets, filterSecrets, parseEnvFile, matchesAny } from "./secrets.js";
export type { SecretsCheck, SecretsReport, SecretRules } from "./secrets.js";

export { gitFacts, type GitFacts } from "./git.js";
