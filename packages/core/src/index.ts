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
export { ConfigError, loadConfig, projectPath, resolveConfig } from "./config/load.js";
export type { LoadOptions, ResolveOptions } from "./config/load.js";
export {
  CONFIG_FILENAME,
  findConfig,
  isWorkspaceProjectDir,
  locateConfig,
  workspaceWorktree,
} from "./config/locate.js";
export type { ConfigLocation, ConfigOrigin, LocateOptions, WorkspaceWorktree } from "./config/locate.js";
export { allowsRealCredentials, permittedSeeds, publicAccessViolations } from "./config/access.js";
export { persistenceAdvice, pointsAtSandboxState } from "./config/advice.js";
export type { Advice } from "./config/advice.js";
export type { AccessViolation } from "./config/access.js";
export { configSchema } from "./config/schema.js";
export {
  DEFAULT_TTL,
  DEFAULT_GITHUB,
  GITHUB_MODES,
  MACHINE_CONFIG_EXAMPLE,
  loadMachineConfig,
  machineConfigSchema,
  resolveGithub,
  resolveTtl,
  writeMachineConfigExample,
} from "./config/machine.js";
export type { GithubInput, GithubMode, MachineConfig, TtlInput } from "./config/machine.js";
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

export { WORKTREES_DIR, canonicalPath, directoriesOf, isInside, paths, samePath, type Paths } from "./paths.js";

export { docker, createDocker, DockerError, type Docker, type ExecResult } from "./docker.js";

export type { DatabaseDriver, DriverContext, MigrateResult, SeedArtifact } from "./drivers/types.js";
export { DriverError, driverContext, getDriver, driverNames } from "./drivers/index.js";
export type { ContextOptions } from "./drivers/index.js";

export { activityFor, down, expire, gc, list, reload, startSandbox, status, stopSandbox, up } from "./sandbox/index.js";
export type {
  DownOptions,
  ExpireOptions,
  GcOptions,
  GcPlan,
  ListOptions,
  ReloadOptions,
  Sandbox,
  SandboxState,
  SandboxStatus,
  UpOptions,
} from "./sandbox/types.js";

export { deadlineOf, formatTtl, parseTtl, planExpiry } from "./sandbox/expiry.js";
export type { ExpiryCandidate, ExpiryInput, ExpiryPlan } from "./sandbox/expiry.js";
export { isKeptAlive, readKeep, removeKeep, writeKeep } from "./sandbox/keep.js";
export { DEFAULT_ACTIVITY_WINDOW, lastActivity, parseAccessLog } from "./sandbox/activity.js";
export type { ActivityOptions } from "./sandbox/activity.js";

export {
  WorkspaceError,
  cloneProject,
  fetchProject,
  findProject,
  listProjects,
  projectNameFromUrl,
} from "./workspace.js";
export type { CloneOptions, Project, WorkspaceOptions } from "./workspace.js";

export {
  WorktreeError,
  addWorktree,
  listBranches,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
} from "./worktree.js";
export type { AddInput, Branch, Worktree } from "./worktree.js";

export {
  alreadyAdded,
  ghAvailable,
  listPullRequests,
  listRemoteRepos,
  matchesOrigin,
  mergedBranches,
  parsePullRequests,
  parseRemoteRepos,
  repoSlugFromUrl,
} from "./forge.js";
export type { ForgeOptions, PullRequest, RemoteRepo, RemoteReposOptions } from "./forge.js";
export { LABELS, labelsFor, sandboxFromLabels, deriveState } from "./sandbox/labels.js";

export {
  BASE_IMAGE,
  DASHBOARD_CONTAINER,
  DASHBOARD_PORT,
  ROUTER_CONTAINER,
  ROUTER_IMAGE,
  accessStatus,
  caTrusted,
  dashboardArgs,
  domainOf,
  routerScheme,
  ensureBaseImage,
  ensureSandboxCertificate,
  issueCertificate,
  originFor,
  portSuffix,
  routerPorts,
  initAccess,
  mkcertAvailable,
  routerArgs,
  routeLabels,
  sandboxRouteLabels,
  sandboxRule,
  startDashboard,
  startRouter,
  stopDashboard,
  stopRouter,
  teardownAccess,
} from "./access/index.js";
export type { AccessReport, AccessStatus, Certificate, InitOptions, TeardownOptions } from "./access/index.js";

export {
  BLOCKS,
  ImageError,
  applyBlocks,
  applyValues,
  blocksFor,
  ensureProjectImage,
  findGoModule,
  findManifests,
  imageTag,
  renderDockerfile,
  valuesFor,
} from "./image.js";
export type { BuiltImage, RenderInput, StagedFile } from "./image.js";

export { InstallError, containerDir, dashboardEntry, installRoot } from "./install.js";

export { checkSecrets, importSecrets, filterSecrets, parseEnvFile, matchesAny } from "./secrets.js";
export type { SecretsCheck, SecretsReport, SecretRules } from "./secrets.js";

export { gitFacts, gitMounts, hostGitIdentity, type GitFacts, type GitIdentity } from "./git.js";

export { MAIN_THREAD } from "./agent/types.js";
export type {
  AgentEvent,
  AgentRun,
  AskEvent,
  AskResultEvent,
  CompactedEvent,
  ErrorEvent,
  ForkOrigin,
  McpServerState,
  ResultEvent,
  RetryEvent,
  RunState,
  SessionEvent,
  TextEvent,
  ThinkingEvent,
  TokenUsage,
  ToolEvent,
  ToolResultEvent,
} from "./agent/types.js";
export { lineReader, normalise, usageIn } from "./agent/stream.js";
export type { NormaliseContext } from "./agent/stream.js";
export { AgentStore, agentPaths } from "./agent/store.js";
export type { AgentPaths } from "./agent/store.js";
export { AgentGrants, grantText, grantsPath } from "./agent/grants.js";
export type { AgentGrant } from "./agent/grants.js";
export {
  PERMISSION_MODES,
  PERMISSION_PROMPT_TOOL,
  controlErrorIn,
  isPermissionMode,
  permissionRequestIn,
  permissionResponseFrame,
  ruleText,
  setPermissionModeFrame,
  wireMode,
} from "./agent/permissions.js";
export type {
  PermissionDecision,
  PermissionGrantRule,
  PermissionModeInfo,
  PermissionRequest,
} from "./agent/permissions.js";
export {
  AGENT_WORKDIR,
  CREDENTIALS_FILE,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_PERMISSION_MODE,
  FORK_PERMISSION_MODE,
  FORK_TOOLS,
  agentArgv,
  agentEnv,
  agentName,
  interruptArgv,
  agentModelFrom,
  agentPermissionModeFrom,
  agentTokenFrom,
  userMessageFrame,
} from "./agent/launch.js";
export type { AgentLaunch, PermissionMode } from "./agent/launch.js";
export { AGENT_MODELS, DEFAULT_AGENT_MODEL, isAgentModel } from "./agent/models.js";
export type { AgentModel, AgentModelId } from "./agent/models.js";
export {
  BUILTIN_COMMANDS,
  COMMAND_LISTING_ARGV,
  leadingCommand,
  nonSendableCommand,
  parseCommandListing,
  refusalFor,
  slashCommandList,
} from "./agent/commands.js";
export type { SlashCommand, SlashCommandHandler, SlashCommandSource } from "./agent/commands.js";
export { NOTHING_ASKED, SIDE_QUESTION, sideQuestion, sideQuestionPreamble } from "./agent/btw.js";
