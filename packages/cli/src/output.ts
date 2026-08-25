/**
 * Where output goes, and why the split matters.
 *
 * **Human-readable output goes to stderr. Machine-readable JSON goes to
 * stdout.** That way `sandboxr ls --json | jq` works while the person running
 * it still sees the progress, and an agent driving the CLI can read stdout
 * without having to strip a spinner out of it.
 *
 * Colour is used only when stderr is a terminal, so piping to a file or to an
 * agent gives clean text.
 */

export interface Writer {
  out: (text: string) => void;
  err: (text: string) => void;
  isTTY: boolean;
}

export const processWriter: Writer = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  isTTY: Boolean(process.stderr.isTTY),
};

const CODES = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
} as const;

export class Output {
  private readonly writer: Writer;
  readonly json: boolean;

  constructor(writer: Writer = processWriter, json = false) {
    this.writer = writer;
    this.json = json;
  }

  private paint(code: keyof typeof CODES, text: string): string {
    return this.writer.isTTY ? `${CODES[code]}${text}${CODES.reset}` : text;
  }

  /** A plain line of prose. */
  line(text = ""): void {
    this.writer.err(`${text}\n`);
  }

  /** A step that is starting. */
  step(text: string): void {
    this.writer.err(`${this.paint("blue", "==>")} ${text}\n`);
  }

  ok(text: string): void {
    this.writer.err(`${this.paint("green", "  ok")} ${text}\n`);
  }

  warn(text: string): void {
    this.writer.err(`${this.paint("yellow", "   !")} ${text}\n`);
  }

  error(text: string): void {
    this.writer.err(`${this.paint("red", "   x")} ${text}\n`);
  }

  dim(text: string): void {
    this.writer.err(`${this.paint("dim", text)}\n`);
  }

  bold(text: string): void {
    this.writer.err(`${this.paint("bold", text)}\n`);
  }

  /** The machine-readable result, on stdout. */
  data(value: unknown): void {
    this.writer.out(`${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * Text that is itself the result, on stdout and unaltered.
   *
   * A schema dump and a log are the answer rather than a description of it, so
   * `sandboxr db snapshot > before.sql` has to produce the file it looks like it
   * produces. Nothing is added, so the output is byte-for-byte what was read.
   */
  raw(text: string): void {
    this.writer.out(text);
  }

  /**
   * A table, aligned to its own content.
   *
   * Written to stderr like everything else a person reads: the same command with
   * `--json` is what a script should be reading.
   */
  table(headers: string[], rows: string[][]): void {
    const widths = headers.map((header, column) =>
      Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
    );
    const render = (cells: string[]) =>
      cells
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd();

    this.writer.err(`${this.paint("bold", render(headers))}\n`);
    for (const row of rows) this.writer.err(`${render(row)}\n`);
  }
}
