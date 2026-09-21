// The kit: the four shapes this site's chrome is built from.
//
// A deliberate subset of the dashboard's `ui.tsx`, copied rather than
// imported for the reason `lib/cn.ts` explains — the dashboard's `src/` is not a
// component library and reaching into it would drag its dependencies here. Four
// components and not twenty: a documentation site has no panels, no badges, no
// progress bars and no combobox, and copying them "in case" is how the two
// copies start to differ in ways nobody notices.
//
// The one rule that came across intact: **a component never names a colour.** It
// uses the semantic tokens from `@sandboxr/tokens/tokens.css`, so anything
// assembled from these is already correct in light, in dark, and in all three
// colour schemes without a single conditional.

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn.js";

/* --- buttons ------------------------------------------------------------- */

export type ButtonTone = "default" | "primary" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md" | "icon";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap " +
  "transition-[background,color,box-shadow,transform] duration-150 select-none " +
  "disabled:pointer-events-none disabled:opacity-45 active:translate-y-px";

const BUTTON_TONES: Record<ButtonTone, string> = {
  primary: "bg-brand text-brand-ink border border-brand hover:brightness-[1.08]",
  // `line-strong` and not `line`, which is the dashboard's reason carried over
  // with the copy: a button drawn in the same hairline as the surface it sits on
  // stops reading as a control at all.
  default: "bg-surface text-ink border border-line-strong hover:bg-hover",
  ghost: "text-ink-muted hover:bg-hover hover:text-ink",
  quiet: "bg-sunken text-ink-muted border border-transparent hover:bg-hover hover:text-ink",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[0.8125rem]",
  md: "h-9 px-3.5 text-sm",
  // A *size* and not something a caller adds through `className`, because `cn`
  // only joins strings — it does no conflict resolution, and which of two
  // competing Tailwind utilities wins is decided by their order in the generated
  // stylesheet, not by the order they appear in the attribute. This is the bug
  // the dashboard's kit records at length; the fix travels with the copy.
  icon: "size-8 p-0",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: ButtonSize;
};

export const Button = ({
  tone = "default",
  size = "md",
  className,
  children,
  ...rest
}: ButtonProps) => (
  <button
    type="button"
    className={cn(BUTTON_BASE, BUTTON_TONES[tone], BUTTON_SIZES[size], className)}
    {...rest}
  >
    {children}
  </button>
);

export type IconButtonProps = ButtonProps & { label: string };

/** A square button whose only content is an icon, so it needs a name out loud. */
export const IconButton = ({ label, className, tone = "ghost", ...rest }: IconButtonProps) => (
  <Button
    tone={tone}
    size="icon"
    aria-label={label}
    title={label}
    {...(className ? { className } : {})}
    {...rest}
  />
);

/* --- a group of exclusive choices ---------------------------------------- */

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

/** A small group of mutually exclusive choices, as one control. */
export const Segmented = <T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  label: string;
  className?: string;
}) => (
  <div
    role="group"
    aria-label={label}
    className={cn("inline-flex items-center gap-0.5 rounded-lg bg-sunken p-0.5", className)}
  >
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        aria-pressed={value === option.value}
        {...(option.title ? { title: option.title } : {})}
        onClick={() => onChange(option.value)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-[0.4rem] px-2.5 text-xs font-medium transition-colors",
          value === option.value ? "bg-surface text-ink shadow-raise" : "text-ink-muted hover:text-ink",
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
);

/* --- a key on a keyboard ------------------------------------------------- */

/**
 * A keycap.
 *
 * Chrome only. The `<kbd>` elements that appear *inside* a page's prose are
 * styled by `docs.css`, because they arrive as part of the rendered Markdown and
 * there is no React component between the pipeline and the page.
 */
export const Kbd = ({ children, className }: { children: ReactNode; className?: string }) => (
  <kbd
    className={cn(
      "rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[0.6875rem]",
      "leading-none text-ink-subtle",
      className,
    )}
  >
    {children}
  </kbd>
);
