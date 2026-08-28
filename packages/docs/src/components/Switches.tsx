// The two appearance controls, in one file because two places render them.
//
// The header carries them on a wide screen and the mobile drawer carries them on
// a narrow one, and they are the same controls in both — a phone reader who wants
// dark mode should not have to find a different affordance than a laptop reader.
//
// Both write to `<html>` through `state/prefs.tsx` and nothing else. The theme
// switch has **three** positions rather than two because "follow this machine" is
// a real answer, and a two-way toggle forces somebody to re-pick every time their
// machine changes at sunset.

import { usePrefs } from "../state/prefs.js";
import { SCHEMES, type SchemeId, type ThemeChoice } from "../lib/prefs.js";
import { Monitor, Moon, Sun } from "./icons.js";
import { Segmented } from "./ui.js";
import { cn } from "../lib/cn.js";

const THEMES = [
  { value: "light" as ThemeChoice, label: <Sun size={14} />, title: "Light" },
  { value: "dark" as ThemeChoice, label: <Moon size={14} />, title: "Dark" },
  { value: "system" as ThemeChoice, label: <Monitor size={14} />, title: "Follow this machine" },
];

export const ThemeSwitch = ({ className }: { className?: string }) => {
  const { prefs, set } = usePrefs();
  return (
    <Segmented
      label="Colour theme"
      value={prefs.theme}
      onChange={(theme) => set({ theme })}
      options={THEMES}
      {...(className ? { className } : {})}
    />
  );
};

/**
 * Three swatches, each wearing its own scheme.
 *
 * `data-scheme` on the swatch itself, not just on `<html>`. The scheme blocks in
 * `tokens.css` are plain attribute selectors, so an element carrying the
 * attribute resolves the brand tokens to *that* scheme's hues — which means a
 * swatch can show the gradient it would give you without a single hex here and
 * without three hard-coded gradients to keep in step with the palette.
 */
export const SchemePicker = ({ className }: { className?: string }) => {
  const { prefs, set } = usePrefs();
  return (
    <div
      role="group"
      aria-label="Colour scheme"
      className={cn("inline-flex items-center gap-1 rounded-lg bg-sunken p-1", className)}
    >
      {SCHEMES.map((scheme) => (
        <button
          key={scheme.id}
          type="button"
          aria-pressed={prefs.scheme === scheme.id}
          title={`${scheme.name} — ${scheme.note}`}
          onClick={() => set({ scheme: scheme.id as SchemeId })}
          className={cn(
            "grid size-5 place-items-center rounded-full transition-transform",
            prefs.scheme === scheme.id
              ? "ring-2 ring-brand ring-offset-1 ring-offset-sunken"
              : "opacity-70 hover:opacity-100",
          )}
        >
          <span
            data-scheme={scheme.id}
            aria-hidden="true"
            className="size-3.5 rounded-full bg-gradient-brand"
          />
          <span className="sr-only">{scheme.name}</span>
        </button>
      ))}
    </div>
  );
};
