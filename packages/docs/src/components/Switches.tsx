// The theme switch, in a file of its own because two places render it.
//
// The header carries it on a wide screen and the mobile drawer carries it on a
// narrow one, and it is the same control in both — a phone reader who wants dark
// mode should not have to find a different affordance than a laptop reader.
//
// It writes to `<html>` through `state/prefs.tsx` and nothing else. The theme
// switch has **three** positions rather than two because "follow this machine" is
// a real answer, and a two-way toggle forces somebody to re-pick every time their
// machine changes at sunset.

import { usePrefs } from "../state/prefs.js";
import type { ThemeChoice } from "../lib/prefs.js";
import { Monitor, Moon, Sun } from "./icons.js";
import { Segmented } from "./ui.js";

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
