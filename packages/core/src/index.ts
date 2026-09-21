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
  CONFIG_FILENAMES,
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
  sharedFiles,
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
  SharedFile,
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
  CLAUDE_VOLUME,
  WORK_VOLUME_PREFIX,
  isWorkVolume,
  volumeName,
  workVolumeName,
  workstationName,
} from "./naming.js";
export type { DeriveSlugInput, HostParts, VolumePurpose } from "./naming.js";

export { WORKTREES_DIR, canonicalPath, directoriesOf, isInside, paths, samePath, type Paths } from "./paths.js";

export { archBuildArgs, docker, createDocker, DockerError, nodeRunner, type Docker, type ExecResult } from "./docker.js";
export type { BuildCacheRow, ContainerRow, DiskUsage, ImageRow, Runner, VolumeRow } from "./docker.js";

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
  UpResult,
} from "./sandbox/types.js";


export { deadlineFrom, deadlineOf, decide, formatTtl, parseTtl, planExpiry } from "./sandbox/expiry.js";
export type { ExpiryCandidate, ExpiryInput, ExpiryPlan } from "./sandbox/expiry.js";

export { formatBytes, planPrune } from "./sandbox/prune.js";
export type { PrunableImage, PrunableVolume, PruneInput, PrunePlan, PruneResult } from "./sandbox/prune.js";
export { isKeptAlive, readKeep, removeKeep, writeKeep } from "./sandbox/keep.js";
export { ATTACH_HEARTBEAT_MS, attachFileFor, markAttached } from "./sandbox/attach.js";
export type { AttachOptions } from "./sandbox/attach.js";
export type { ProvidedWorkspace } from "./sandbox/provided.js";
/**
 * What a container gets and what it is built from, for an embedder that starts
 * a container of its own beside the engine's.
 *
 * `sandbox/layout.ts` is the host side of the boundary with `container/`, and
 * the point of it is that everything which mounts or reads one of these paths
 * goes through the one spelling. An embedder rebuilding `/workspace` or
 * `/root/.claude` as a string literal is the drift that file exists to prevent.
 */
export { CLAUDE_DIR, WITH_ENV, WORKSPACE } from "./sandbox/layout.js";
export { DEFAULT_IMAGE } from "./sandbox/run.js";
export {
  ATTACH_LIVE_GRACE_MS,
  DEFAULT_ACTIVITY_WINDOW,
  attachedActivity,
  lastActivity,
  mtimeOf,
  note,
  parseAccessLog,
  sandboxActivity,
} from "./sandbox/activity.js";
export type {
  ActivityOptions,
  AttachedActivityOptions,
  RouterActivity,
  RouterRequest,
  SandboxActivityOptions,
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
  ghConfigDir,
  hostGhToken,
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
export { LABELS, labelArgs, labelsFor, sandboxFromLabels, deriveState } from "./sandbox/labels.js";

export {
  BASE_IMAGE,
  ROUTER_CONTAINER,
  ROUTER_IMAGE,
  AUTH_MIDDLEWARE,
  HANDSHAKE_PATH,
  HANDSHAKE_PRIORITY,
  HANDSHAKE_ROUTER,
  handshakeRule,
  regexLiteral,
  HOST_ENV_KEYS,
  hostEnvironment,
  formatHostEnv,
  writeHostEnv,
  HostEnvError,
  FRONTEND_LABEL,
  DEFAULT_FRONTEND_PORT,
  DEFAULT_FRONTEND_CONTAINER,
  frontendRouteLabels,
  listFrontends,
  accessStatus,
  caTrusted,
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
  startRouter,
  stopRouter,
  teardownAccess,
} from "./access/index.js";
export type { AccessReport, AccessStatus, Certificate, FrontendRoute, InitOptions, TeardownOptions } from "./access/index.js";
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

export { InstallError, containerDir, installRoot } from "./install.js";

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

export {
  DEFAULT_DIRTY_IGNORE,
  dirtyFiles,
  gitFacts,
  gitMounts,
  hostGitIdentity,
  type GitFacts,
  type GitIdentity,
} from "./git.js";
