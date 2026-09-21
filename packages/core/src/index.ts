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
export { ConfigError, hostLabels, loadConfig, projectPath, resolveConfig, slugCeilingFor } from "./config/load.js";
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
  decideGithub,
  loadMachineConfig,
  machineConfigSchema,
  projectEntry,
  resolveGithub,
  resolveTtl,
  reviewProjectEntries,
  writeMachineConfigExample,
} from "./config/machine.js";
export type {
  GithubDecision,
  GithubInput,
  GithubMode,
  MachineConfig,
  MachineConfigReview,
  MachineProjectEntry,
  ProjectEntryMatch,
  ProjectIdentity,
  ProjectKey,
  TtlInput,
} from "./config/machine.js";
export { compareVersions, parseVersion, satisfies, VersionError } from "./config/version.js";
export { TOOL_VERSION } from "./tool-version.js";

export {
  DEFAULT_DOMAIN,
  IMAGE_NAMESPACE,
  NETWORK,
  NamingError,
  PROTECTED_IMAGES,
  SESSION_ID_MAX,
  SHARED_VOLUMES,
  SLUG_MAX,
  SLUG_MIN,
  containerName,
  depsVolumeName,
  deriveSlug,
  hostFor,
  imageRepository,
  lockName,
  parseContainerName,
  parseHost,
  sanitizeSlug,
  slugCeiling,
  urlFor,
  WORK_VOLUME_PREFIX,
  isWorkVolume,
  volumeName,
  workVolumeName,
  workstationName,
} from "./naming.js";
export type { DeriveSlugInput, HostParts, VolumePurpose } from "./naming.js";

export { WORKTREES_DIR, canonicalPath, directoriesOf, isInside, paths, samePath, type Paths } from "./paths.js";

export { docker, createDocker, DockerError, type Docker, type ExecResult } from "./docker.js";
export type { BuildCacheRow, DiskUsage, ImageRow, VolumeRow } from "./docker.js";

export type { DatabaseDriver, DriverContext, MigrateResult, SeedArtifact } from "./drivers/types.js";
export { DriverError, driverContext, getDriver, driverNames } from "./drivers/index.js";
export type { ContextOptions } from "./drivers/index.js";

export {
  activityFor,
  down,
  expire,
  gc,
  list,
  prune,
  reload,
  // Exported for the same reason `SessionError` and `RuntimeError` are: it is
  // the class of failure a *caller* can act on — a name already in use, a
  // checkout that does not describe itself, a DNS budget that will not fit a
  // slug — as against a fault in sandboxr. The dashboard turns one into an
  // answer and anything else into a 500, and it cannot tell them apart without
  // the class.
  SandboxError,
  startSandbox,
  status,
  stopSandbox,
  up,
} from "./sandbox/index.js";
export type {
  DownOptions,
  DownReport,
  ExpireOptions,
  GcOptions,
  GcPlan,
  ListOptions,
  PruneOptions,
  ReloadOptions,
  Sandbox,
  SandboxKind,
  SandboxState,
  SandboxStatus,
  UpOptions,
} from "./sandbox/types.js";

export {
  DEFAULT_WORKSTATION_IMAGE,
  SESSION_LABELS,
  UNNAMED_SESSION_BASE,
  WORKSTATION_FILTER,
  SessionError,
  createSession,
  deleteSession,
  getSession,
  isSessionKeptAlive,
  kindOf,
  listSessions,
  markSessionAttached,
  readSessionKeep,
  readSessionName,
  parseAdopted,
  readSessionAdopted,
  removeSessionKeep,
  removeSessionName,
  removeSessionState,
  sessionAttachFileFor,
  sessionDirFor,
  sessionFilter,
  sessionFromLabels,
  sessionId,
  sessionIdBase,
  startWorkstation,
  stopWorkstation,
  workVolumeArgs,
  workVolumeLabels,
  workstationArgs,
  workstationLabels,
  workstationState,
  writeSessionAdopted,
  writeSessionKeep,
  writeSessionName,
} from "./session/index.js";
export type {
  AdoptedFrom,
  ContainerKind,
  CreateSessionOptions,
  DeleteSessionReport,
  Session,
  SessionIdInput,
  SessionOptions,
  SessionState,
  WorkstationLabelInput,
  WorkstationRunInput,
} from "./session/index.js";

export { deadlineOf, formatTtl, parseTtl, planExpiry } from "./sandbox/expiry.js";
export type { ExpiryCandidate, ExpiryInput, ExpiryPlan } from "./sandbox/expiry.js";
export { planSessionExpiry, sessionDeadlineOf } from "./session/expiry.js";
export type { SessionExpiryCandidate, SessionExpiryInput, SessionExpiryPlan } from "./session/expiry.js";
export { expireSessions } from "./session/expire.js";
export type { ExpireSessionsOptions } from "./session/expire.js";
export {
  CLONE_SCRIPT,
  LIST_SCRIPT,
  WORK_DIR,
  SESSION_LABEL,
  UNKNOWN_BRANCH,
  WorkVolumeError,
  branchDir,
  cloneArgs,
  cloneIntoWork,
  ensureWorkVolume,
  listArgs,
  listWork,
  parseWorkListing,
  placeBranch,
  removeWorkVolume,
  workMountArgs,
  workPath,
  workspaceMountArgs,
} from "./session/work.js";
export type { CloneRequest, WorkEntry, WorkRunner } from "./session/work.js";
export { addSessionRepo, SessionRepoError } from "./session/repos.js";
export type { AddRepoRequest, AddedRepo, SessionRepoRefusal } from "./session/repos.js";
export { adoptWorktree, AdoptError } from "./session/adopt.js";
export type { AdoptWorktreeRequest, AdoptedWorktree, AdoptRefusal } from "./session/adopt.js";
export { readableBranch, sessionNameForWorktree } from "./session/adopt-name.js";
export type { WorktreeNameInput } from "./session/adopt-name.js";
export { captureWorktreeChanges, carryIntoWork, CarryError } from "./session/carry.js";
export type { WorktreeChanges } from "./session/carry.js";
export { RuntimeError, runtimeSlug, runtimeWorkspaceArgs, stageRuntime } from "./session/runtime.js";
export type { RuntimeRequest, StagedRuntime } from "./session/runtime.js";

export { formatBytes, planPrune } from "./sandbox/prune.js";
export type { PrunableImage, PrunableVolume, PruneInput, PrunePlan, PruneResult } from "./sandbox/prune.js";
export { isKeptAlive, readKeep, removeKeep, writeKeep } from "./sandbox/keep.js";
export { ATTACH_HEARTBEAT_MS, attachFileFor, markAttached } from "./sandbox/attach.js";
export type { AttachOptions } from "./sandbox/attach.js";
export {
  AGENT_LIVE_GRACE_MS,
  AGENT_LIVE_STATES,
  ATTACH_LIVE_GRACE_MS,
  DEFAULT_ACTIVITY_WINDOW,
  agentActivity,
  agentSessionActivity,
  attachedActivity,
  lastActivity,
  parseAccessLog,
  sandboxActivity,
  sessionActivity,
  sessionAttachedActivity,
} from "./sandbox/activity.js";
export type {
  ActivityOptions,
  AgentActivityOptions,
  AttachedActivityOptions,
  RouterActivity,
  SandboxActivityOptions,
  SessionActivityOptions,
} from "./sandbox/activity.js";

export {
  WorkspaceError,
  cloneProject,
  fetchProject,
  findProject,
  listProjects,
  projectDirectories,
  projectIdentities,
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

export { WorktreeDeleteError, deleteWorktree, projectSlugCeiling, worktreeSlugs } from "./worktree-delete.js";
export type { DeleteWorktreeInput, WorktreeDeletion, WorktreeSlug } from "./worktree-delete.js";

export { freshenBranch, pullReport, pullWorktree, statusPaths, untrackedBlocks } from "./pull.js";
export type {
  FreshenInput,
  FreshenOutcome,
  FreshenResult,
  PullInput,
  PullRefusal,
  PullRefusalKind,
  PullResult,
} from "./pull.js";

export {
  DISPLAY_NAME_MAX,
  DisplayNameError,
  normaliseDisplayName,
  readDisplayName,
  removeDisplayName,
  writeDisplayName,
} from "./worktree-name.js";

export {
  SLUG_TOKEN_LEN,
  normaliseRecordedSlug,
  readRecordedSlug,
  removeRecordedSlug,
  slugFor,
  slugToken,
  uniqueSlug,
  writeRecordedSlug,
} from "./worktree-slug.js";
export type { SlugForInput } from "./worktree-slug.js";

export {
  alreadyAdded,
  createPullIndex,
  ghAvailable,
  indexByBranch,
  listPullRequests,
  listRemoteRepos,
  matchesOrigin,
  mergedBranches,
  parsePullRequests,
  parseRemoteRepos,
  PULL_INDEX_RETRY_MS,
  PULL_INDEX_TTL_MS,
  repoSlugFromUrl,
} from "./forge.js";
export type {
  ForgeOptions,
  ProjectOrigin,
  PullIndex,
  PullIndexOptions,
  PullRequest,
  PullState,
  RemoteRepo,
  RemoteReposOptions,
} from "./forge.js";
export { LABELS, labelsFor, sandboxFromLabels, deriveState } from "./sandbox/labels.js";

export {
  BASE_IMAGE,
  DASHBOARD_CONTAINER,
  DASHBOARD_IMAGE_NAME,
  DASHBOARD_PORT,
  WORKSTATION_IMAGE_NAME,
  ensureWorkstationImage,
  ROUTER_CONTAINER,
  ROUTER_IMAGE,
  FRONTEND_LABEL,
  DEFAULT_FRONTEND_PORT,
  DEFAULT_FRONTEND_CONTAINER,
  frontendRouteLabels,
  listFrontends,
  accessStatus,
  caTrusted,
  dashboardArgs,
  domainOf,
  routerScheme,
  ensureBaseImage,
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
export type { AccessReport, AccessStatus, Certificate, FrontendRoute, InitOptions, TeardownOptions } from "./access/index.js";
export {
  ORCHESTRATOR_CONTAINER,
  ORCHESTRATOR_IMAGE_NAME,
  orchestratorArgs,
  startOrchestrator,
  stopOrchestrator,
} from "./access/orchestrator.js";
export type { OrchestratorInput, StartOrchestratorOptions } from "./access/orchestrator.js";

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

export {
  checkSecrets,
  importSecrets,
  filterSecrets,
  parseEnvFile,
  matchesAny,
  declaredNames,
  writeSecretsFile,
  readProjectSecrets,
  describeProjectSecrets,
  revealProjectSecret,
  editProjectSecrets,
  envNameRefusal,
  isReservedEnvName,
  hintFor,
  envDigest,
  RESERVED_ENV_NAMES,
  RESERVED_ENV_PREFIXES,
} from "./secrets.js";
export type {
  SecretVar,
  SecretsView,
  SecretsEdit,
  SecretsEditReport,
  SecretRefusal,
} from "./secrets.js";
export type { SecretsCheck, SecretsReport, SecretRules } from "./secrets.js";

export { gitFacts, gitMounts, hostGitIdentity, type GitFacts, type GitIdentity } from "./git.js";
export { CREDENTIALS_ENV, claudeConfigDir, hostClaudeCredentials } from "./agent/credentials.js";

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
export { SPOKEN_MARKER, SPOKEN_PROMPT } from "./agent/spoken.js";
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

export { CODE_PATH_MAX, baseName, resolveInRoot, safePath } from "./code/paths.js";
export {
  FILE_READ_LIMIT,
  LISTING_LIMIT,
  listingArgv,
  looksBinary,
  parseListing,
  readFileArgv,
  readFileResult,
} from "./code/listing.js";
export type { CodeEntry, CodeEntryKind, CodeFile, CodeListing } from "./code/listing.js";
export {
  DIFF_FILE_LIMIT,
  HEAD_ARGV,
  MERGE_BASE_ARGV,
  PATCH_LIMIT,
  REPO_ROOT_ARGV,
  UNTRACKED_ARGV,
  UPSTREAM_ARGV,
  isCommit,
  mergeChanges,
  nameStatusArgv,
  nulFields,
  numstatArgv,
  parseNameStatus,
  parseNumstat,
  parsePatch,
  patchArgv,
  untrackedPatchArgv,
} from "./code/diff.js";
export type {
  ChangeStatus,
  ChangedFile,
  DiffBase,
  DiffSummary,
  Patch,
  PatchHunk,
  PatchLine,
  PatchLineKind,
} from "./code/diff.js";
