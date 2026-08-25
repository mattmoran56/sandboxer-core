/**
 * Argument parsing.
 *
 * Hand-rolled rather than pulled in as a dependency, for two reasons: the
 * grammar is tiny (a command, an optional subcommand, positional words and
 * long flags), and the parse is a pure function over a string array, which is
 * the easiest thing in the whole CLI to test exhaustively.
 */

export interface ParsedArgs {
  /** The command, e.g. `up`. Empty when nothing was given. */
  command: string;
  /** Words that are not flags, in order. */
  positional: string[];
  /** Long flags. A flag with no value is `true`. */
  flags: Record<string, string | boolean>;
  /** Everything after a bare `--`, passed through untouched. */
  rest: string[];
}

/** Flags that take the next word as their value. */
const VALUE_FLAGS = new Set([
  "worktree",
  "slug",
  "project",
  "seed",
  "target",
  "tail",
  "ref",
  "timeout",
  "with",
  "prefer",
  "since",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];

  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index] as string;

    // Everything after a bare `--` belongs to whatever the command shells out
    // to, so it is never interpreted here.
    if (arg === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq > 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      // `--no-x` is how a boolean flag is turned off, which reads better than
      // an `--x=false` nobody would type.
      if (body.startsWith("no-")) {
        flags[body.slice(3)] = false;
        continue;
      }
      const next = argv[index + 1];
      if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        index += 1;
        continue;
      }
      flags[body] = true;
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (const letter of arg.slice(1)) flags[letter] = true;
      continue;
    }

    positional.push(arg);
  }

  return { command: positional.shift() ?? "", positional, flags, rest };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.flags[name];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "false" && value !== "0";
  return fallback;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  // An empty value is absent, not zero: `Number("")` is 0, and a bare `--tail=`
  // silently meaning "no lines at all" is the opposite of what it reads like.
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A comma-separated list, which is how `--with` names several runtimes. */
export function flagList(args: ParsedArgs, name: string): string[] | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
