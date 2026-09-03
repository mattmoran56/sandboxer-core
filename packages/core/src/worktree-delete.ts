/**
 * Deleting a worktree: the sandbox first, then the directory it was cut from.
 *
 * `down` in ./sandbox/index.ts and `removeWorktree` in ./worktree.ts are each
 * half of this, and doing them in the other order is not merely untidy — it
 * loses the ability to do the first half at all:
 *
 * - **The volumes cannot go while the container runs.** `docker volume rm`
 *   refuses a volume a running container holds, so a teardown that removed the
 *   directory and then tidied up would leave four volumes behind.
 * - **The worktree is what the slug is resolved from** (contracts §3.1). Every
 *   artefact a sandbox owns — container, volumes, plan, environment, logs — is
 *   named `<project>-<slug>`, and the slug comes from the worktree's directory
 *   name, its branch, or a record filed under that directory name. Remove the
 *   directory first and the name of what needs cleaning up has gone with it —
 *   `removeWorktree` forgets the record along with the worktree — so what is
 *   left is an orphan for `gc` to find later, by a different route.
 *
 * **Two worktrees can still answer to one slug, and then they share one
 * sandbox.** §3.1 prefers a ticket-style id found in the directory name, so
 * `feat/eng-3941-answers-page` and `feat/eng-3941-run-selector` both derive
 * `eng-3941`: one container, one set of volumes, one host rule and one migration
 * lock between them. `addWorktree` now *gives* the second of those a slug of its
 * own, but it deliberately does not migrate collisions already on disk — renaming
 * a worktree whose sandbox is running would orphan that container under the old
 * name. So an upgraded machine still has them, and the sibling check below is
 * what protects it: deleting one branch's worktree must never take the container
 * another branch is working in. It costs one listing this function was making
 * anyway, and on a machine with no collisions left it simply never fires.
 *
 * **Every slug here comes from `slugFor`, never from `deriveSlug`.** A worktree
 * that was given a slug carries a random token that cannot be re-derived, so a
 * check that derived would compare a sibling under a name nothing else uses —
 * finding a collision that is not there, or missing one that is.
 */

import { basename } from "node:path";

import { loadConfig, slugCeilingFor } from "./config/load.js";
import { nodeRunner, type Docker, type Runner } from "./docker.js";
import { DEFAULT_DIRTY_IGNORE, dirtyFiles } from "./git.js";
import { SLUG_MAX, sanitizeSlug } from "./naming.js";
import { samePath } from "./paths.js";
import { down, list } from "./sandbox/index.js";
import type { Project } from "./workspace.js";
import { listWorktrees, removeWorktree, type Worktree } from "./worktree.js";
import { removeDisplayName } from "./worktree-name.js";
import { slugFor } from "./worktree-slug.js";

/** A delete that was refused, with the reason already written for a reader. */
export class WorktreeDeleteError extends Error {
  override readonly name = "WorktreeDeleteError";
  /**
   * Whether `force` would get past this.
   *
   * "There is no worktree by that name" and "this worktree has work in it" are
   * both refusals, and only one of them is an opinion a caller may overrule.
   */
  readonly forceable: boolean;

  constructor(message: string, options: { forceable?: boolean } = {}) {
    super(message);
    this.forceable = options.forceable ?? false;
  }
}

/** One worktree and the slug it answers to, as `slugFor` resolves it. */
interface WorktreeSlug {
  worktree: Worktree;
  slug: string;
}

/**
 * One project's slug ceiling, read from whichever worktree carries a config.
 *
 * Any of them will do — the ceiling comes from the `project:` name and the
 * longest hostname label, both the same in every worktree of a project — so this
 * stops at the first that reads. A project with no readable config anywhere
 * falls back to `SLUG_MAX`, which is honest rather than a drift: with no config
 * there are no hostnames, so there is no budget to be spending.
 *
 * Here rather than in the CLI, where it was written, because a delete has to
 * resolve *every* worktree of a project against the ceiling and two copies of
 * one loop eventually answer differently. `slugFor` cannot stand in for it:
 * that function *takes* `max`, and this is what works `max` out.
 */
export async function projectSlugCeiling(
  worktrees: readonly Worktree[],
  env?: NodeJS.ProcessEnv | undefined,
): Promise<number> {
  for (const worktree of worktrees) {
    if (!worktree.exists) continue;
    try {
      return slugCeilingFor(await loadConfig(worktree.path, { enforceAccess: false, env }));
    } catch {
      // A worktree whose config is missing or unreadable is not this function's
      // problem to report; the next one may well have it.
    }
  }
  return SLUG_MAX;
}

/**
 * Every worktree of a project, each with the slug it answers to.
 *
 * Resolved rather than derived, one `slugFor` per worktree — see the note at the
 * top of this file. A worktree whose name resolves to nothing is dropped instead
 * of throwing: `deriveSlug` refuses a directory that sanitises to the empty
 * string, and one unusable sibling must not make the whole project undeletable.
 */
async function worktreeSlugs(
  project: Project,
  options: { run?: Runner | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): Promise<WorktreeSlug[]> {
  const worktrees = await listWorktrees(project, { run: options.run ?? nodeRunner });
  const max = await projectSlugCeiling(worktrees, options.env);

  const resolved: WorktreeSlug[] = [];
  for (const worktree of worktrees) {
    try {
      resolved.push({
        worktree,
        slug: await slugFor({
          worktree: worktree.path,
          // The workspace *directory* name, which is what a slug record is keyed
          // on (§4.2.3) — not the `project:` a sandboxr.yaml declares.
          project: project.name,
          branch: worktree.branch,
          max,
          ...(options.env === undefined ? {} : { env: options.env }),
        }),
      });
    } catch {
      // Nothing to address it by, so nothing for it to collide with and nothing
      // to delete it under. `pick` reports it as "no worktree called …".
    }
  }
  return resolved;
}

export interface DeleteWorktreeInput {
  project: Project;
  /** The slug the worktree is addressed by. One of `slug` or `branch` is required. */
  slug?: string | undefined;
  /** The branch it has checked out, which is how the command line names one. */
  branch?: string | undefined;
  /** Delete it even though it holds work nothing else has a copy of. */
  force?: boolean | undefined;
  docker?: Docker | undefined;
  run?: Runner | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * What a delete did, item by item.
 *
 * A destructive operation reports what went rather than succeeding silently:
 * the reader is the person who just pressed it, and "done" does not tell them
 * whether the container they were worried about is gone.
 */
export interface WorktreeDeletion {
  /** The workspace directory name, which is what a worktree is keyed on (§4.1). */
  project: string;
  slug: string;
  branch: string;
  path: string;
  /**
   * What happened to the sandbox.
   *
   * `shared` is the outcome that is not tidy and has to be reported as such: the
   * sandbox is still running, on purpose, because another worktree resolves to
   * the same slug.
   */
  sandbox: "removed" | "none" | "shared";
  /**
   * Which sandbox that was — the container's `project:` and slug — or null when
   * the worktree had none.
   *
   * Named separately from `slug` above because the two are allowed to differ: a
   * worktree is keyed on the workspace directory (§4.1) and a container on the
   * name its sandboxr.yaml declares. A caller that has to do something about the
   * sandbox afterwards — the dashboard stops writing its attach heartbeat — needs
   * the container's pair and not the worktree's.
   */
  sandboxId: { project: string; slug: string } | null;
  /** The other worktrees that derive this slug, by path. Empty unless `sandbox` is `shared`. */
  sharedWith: string[];
  /** Every artefact that really went, in the order it went. */
  removed: string[];
  /** What was deliberately left behind, one sentence each. */
  kept: string[];
}

/**
 * Removes a worktree's sandbox and then the worktree.
 *
 * Throws `WorktreeDeleteError` and touches nothing when the worktree cannot be
 * found, or when it holds work that exists nowhere else. A worktree with no
 * sandbox deletes cleanly and says so — "there was nothing to tear down" is an
 * ordinary answer, not a failure.
 */
export async function deleteWorktree(input: DeleteWorktreeInput): Promise<WorktreeDeletion> {
  const run = input.run ?? nodeRunner;
  const log = input.log ?? ((): void => {});
  const env = input.env ?? process.env;
  const { project } = input;

  const entries = await worktreeSlugs(project, { run, env });
  const target = pick(entries, input);
  if (!target) {
    throw new WorktreeDeleteError(`no worktree called ${input.slug ?? input.branch ?? ""} in ${project.name}`);
  }

  const { worktree, slug } = target;
  // Compared on the path, never on the slug: the slug is exactly the thing that
  // may not be unique here, so filtering by it would drop the sibling this check
  // exists to find along with the worktree being deleted.
  const sharers = entries.filter((entry) => entry.slug === slug && !samePath(entry.worktree.path, worktree.path));

  if (!input.force) {
    const unsaved = await unsavedWork(worktree, run);
    if (unsaved) throw new WorktreeDeleteError(unsaved, { forceable: true });
  }

  const removed: string[] = [];
  const kept: string[] = [];

  // The sandbox first — see the note at the top of this file for why the order
  // is the whole reason this is one operation rather than two.
  const sandbox = await sandboxFor(project, worktree, slug, input);
  let outcome: WorktreeDeletion["sandbox"] = "none";

  if (sandbox && sharers.length > 0) {
    outcome = "shared";
    const names = sharers.map((entry) => entry.worktree.branch || entry.worktree.path).join(", ");
    log(`Kept the sandbox ${sandbox.project}/${sandbox.slug}: ${names} resolves to the same slug and is still using it.`);
    kept.push(`the sandbox ${sandbox.project}/${sandbox.slug}, which ${names} also resolves to`);
  } else if (sandbox) {
    const report = await down(sandbox.project, sandbox.slug, {
      ...(input.docker ? { docker: input.docker } : {}),
      env,
      log,
    });
    removed.push(...report.removed);
    outcome = "removed";
  } else {
    log(`No sandbox for ${slug} — there was nothing to tear down.`);
  }

  // `--force` at the git level, always, and only because our own check has
  // already run. git's test is blunter than ours: it refuses on any dirty file
  // at all, including the `.env.local` a sandbox's own build writes, which
  // `DEFAULT_DIRTY_IGNORE` exists to discount. Deciding the policy here and
  // asking git to carry it out keeps one answer to "is there work in this
  // worktree" rather than two that disagree.
  //
  // `env` is not optional here either: `removeWorktree` forgets a given slug
  // along with the worktree, and it has to look for that record under the same
  // home everything above was resolved through.
  await removeWorktree(project, worktree.path, { run, force: true, env });
  removed.push(worktree.path);
  log(`Removed the worktree ${worktree.path}`);

  // The display name is keyed on the workspace *directory* name and the slug
  // (§4.2.1), so a sibling on the same slug is filed under the same name —
  // removing it would blank the label on somebody else's worktree.
  if (sharers.length === 0) {
    await removeDisplayName(project.name, slug, env);
  } else {
    kept.push(`the name filed under ${project.name}/${slug}, which the other worktree on that slug shows`);
  }

  return {
    project: project.name,
    slug,
    branch: worktree.branch,
    path: worktree.path,
    sandbox: outcome,
    sandboxId: sandbox ?? null,
    sharedWith: sharers.map((entry) => entry.worktree.path),
    removed,
    kept,
  };
}

/**
 * The sandbox cut from this worktree, if there is one.
 *
 * Found by the worktree on its label rather than by rebuilding a container name,
 * because the two names in play are allowed to differ: a worktree is keyed on
 * the workspace *directory* (§4.1) and a container on the `project:` its
 * sandboxr.yaml declares. The derived slug is the fallback, for a sandbox
 * started before the worktree label existed, and it is matched against the
 * declared project name for the same reason.
 */
async function sandboxFor(
  project: Project,
  worktree: Worktree,
  slug: string,
  input: DeleteWorktreeInput,
): Promise<{ project: string; slug: string } | undefined> {
  const env = input.env ?? process.env;
  const sandboxes = await list({ ...(input.docker ? { docker: input.docker } : {}), env });

  const byWorktree = sandboxes.find(
    (sandbox) => sandbox.worktree !== "" && samePath(sandbox.worktree, worktree.path),
  );
  if (byWorktree) return { project: byWorktree.project, slug: byWorktree.slug };

  const declared = await declaredProject(worktree, env);
  const bySlug = sandboxes.find(
    (sandbox) => sandbox.slug === slug && (sandbox.project === declared || sandbox.project === project.name),
  );
  return bySlug ? { project: bySlug.project, slug: bySlug.slug } : undefined;
}

/** What this worktree's config calls the project, or undefined when it cannot be read. */
async function declaredProject(worktree: Worktree, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!worktree.exists) return undefined;
  try {
    return (await loadConfig(worktree.path, { enforceAccess: false, env })).project;
  } catch {
    return undefined;
  }
}

/**
 * Why this worktree must not be deleted yet, or `undefined`.
 *
 * Two questions, and they are not the same size of loss, so the wording keeps
 * them apart:
 *
 * - **Uncommitted changes are lost with the directory.** They exist nowhere
 *   else, and `git worktree remove` is the last thing that will ever see them.
 * - **Unpushed commits are not lost.** Commits and branch refs live in the
 *   project's bare clone, which a worktree only borrows, so removing the
 *   directory leaves every one of them where it was. What goes is the checkout.
 *   That is still worth stopping for, and it is worth describing accurately: a
 *   refusal that overstates what it protects is one people learn to force past.
 *
 * A worktree whose directory is already gone has neither, so there is nothing
 * to refuse — that is the stale git entry the delete is there to clear.
 */
async function unsavedWork(worktree: Worktree, run: Runner): Promise<string | undefined> {
  if (!worktree.exists) return undefined;

  const status = await run("git", ["-C", worktree.path, "status", "--porcelain"]);
  const dirty = status.code === 0 ? dirtyFiles(status.stdout, DEFAULT_DIRTY_IGNORE) : [];
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).map((line) => `  ${line}`);
    const more = dirty.length > shown.length ? [`  …and ${dirty.length - shown.length} more`] : [];
    return [
      `${worktree.path} has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}, and deleting it would destroy them:`,
      ...shown,
      ...more,
      "Commit or stash them first, or delete it with --force.",
    ].join("\n");
  }

  // Not `@{upstream}..HEAD`: a branch that has never been pushed has no upstream
  // at all, and asking for one fails rather than answering "all of it". Counting
  // what no remote-tracking ref can reach answers the question the same way for
  // a branch pushed once, a branch never pushed, and a detached worktree.
  const ahead = await run("git", ["-C", worktree.path, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const count = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) : 0;
  if (Number.isFinite(count) && count > 0) {
    return [
      `${worktree.branch || worktree.path} has ${count} commit${count === 1 ? "" : "s"} that is on no remote.`,
      "The commits stay in the project's clone on this machine — a worktree only borrows them — but nothing",
      "here will have that branch checked out any more.",
      "Push the branch first, or delete it with --force.",
    ].join("\n");
  }

  return undefined;
}

/**
 * The worktree the caller named.
 *
 * A branch is resolved to a **directory** first and to a branch name second,
 * because the directory is what `addWorktree` derives from the branch and is
 * therefore unique, while the branch name is not: a worktree checked out
 * detached — which is how a branch that is open somewhere else gets run — has
 * `branchOf` recover the same name as the worktree really holding it.
 *
 * A slug is resolved the same way round and may still be **ambiguous**, because
 * two worktrees can derive one slug (see the note at the top of this file).
 * Deleting an arbitrary one of the two is the single worst thing this file could
 * do, so that case is refused and asks to be told the branch instead.
 */
function pick(entries: WorktreeSlug[], input: DeleteWorktreeInput): WorktreeSlug | undefined {
  if (input.branch) {
    const branch = input.branch;
    return (
      entries.find((entry) => basename(entry.worktree.path) === sanitizeSlug(branch)) ??
      entries.find((entry) => entry.worktree.branch === branch)
    );
  }
  if (input.slug) {
    const byDir = entries.find((entry) => basename(entry.worktree.path) === input.slug);
    if (byDir) return byDir;

    const bySlug = entries.filter((entry) => entry.slug === input.slug);
    if (bySlug.length > 1) {
      throw new WorktreeDeleteError(
        [
          `${input.slug} is the slug of ${bySlug.length} worktrees, so it does not say which one to delete:`,
          ...bySlug.map((entry) => `  ${entry.worktree.branch || "detached"} at ${entry.worktree.path}`),
          "Name the branch instead. They share one sandbox as well as one slug, so deleting the wrong",
          "one would take the container the other is working in.",
        ].join("\n"),
      );
    }
    return bySlug[0];
  }
  return undefined;
}
