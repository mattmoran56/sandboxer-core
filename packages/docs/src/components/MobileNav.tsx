// The nav on a narrow screen: a real drawer, not the sidebar with `display: none`
// taken off it.
//
// It is a native `<dialog>` opened with `showModal()`, for the same reason the
// dashboard's Modal is one: focus trapping, an inert page behind it, Escape to
// close and the top layer are all the browser's, and every hand-rolled version of
// those gets one of them subtly wrong for keyboard readers. A drawer that trapped
// a reader's Tab key inside the article behind it would be worse than no drawer.
//
// It also carries the appearance controls. On a phone the header has room for a
// logo, a search button and a handle, so the theme and scheme switches live here
// instead — the same controls, not lesser ones.

import { useEffect, useRef } from "react";

import { NavTree } from "./Sidebar.js";
import { SchemePicker, ThemeSwitch } from "./Switches.js";
import { Close } from "./icons.js";
import { IconButton } from "./ui.js";

export const MobileNav = ({
  open,
  onClose,
  slug,
  known,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  known: ReadonlySet<string>;
}) => {
  const ref = useRef<HTMLDialogElement>(null);

  // `showModal()` on an already-open dialog throws, hence the guard on `.open`.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Documentation navigation"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The backdrop is the dialog element itself; anything inside is the panel.
        if (event.target === ref.current) onClose();
      }}
      // `m-0 mr-auto` rather than the dialog default of `margin: auto`, which is
      // what centres it. A nav belongs against the edge it opens from.
      className="m-0 mr-auto h-dvh max-h-none w-[19rem] max-w-[85vw] border-r border-line bg-surface p-0 text-ink shadow-modal backdrop:bg-black/45 backdrop:backdrop-blur-sm lg:hidden"
    >
      {open ? (
        <div className="flex h-full flex-col">
          <header className="flex items-center gap-2 border-b border-line px-3 py-3">
            <span className="font-serif text-lg leading-none text-ink">Contents</span>
            <IconButton label="Close navigation" className="ml-auto" onClick={onClose}>
              <Close />
            </IconButton>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto py-4 pl-2 pr-3">
            {/* Following a link closes the drawer: the page it goes to is behind it. */}
            <NavTree slug={slug} known={known} onNavigate={onClose} />
          </div>

          <footer className="flex items-center justify-between gap-2 border-t border-line px-3 py-3">
            <ThemeSwitch />
            <SchemePicker />
          </footer>
        </div>
      ) : null}
    </dialog>
  );
};
