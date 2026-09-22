// What this covers:
//  - the delegated copy handler reading the block's own `code` element
//  - the fallback when `navigator.clipboard` is absent, as it is on an insecure origin
//  - both routes failing: the button says so and selects the code instead
//  - "Expand everything" in both directions, and a page rendering already open
//    when the preference is on
//  - the control being absent on a page with no collapsible blocks
//  - a relative link inside the prose navigating in place, and an off-site one not

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Article } from "./Article.js";
import { clipboardWrites } from "../test-setup.js";

/** A code fence, as the markdown pipeline emits one. */
const CODE = `
<div class="sbx-code" data-lang="bash">
  <div class="sbx-code__bar">
    <span class="sbx-code__lang">bash</span>
    <button class="sbx-copy" type="button" data-copy aria-label="Copy this code">
      <span class="sbx-copy__word">Copy</span>
    </button>
  </div>
  <pre class="sbx-code__pre"><code>cd .worktrees/tkt-4821
sandboxer up</code></pre>
</div>`;

/** A prompt card, which is the same seam with a different wrapper. */
const PROMPT = `
<div class="sbx-prompt">
  <div class="sbx-prompt__bar">
    <span class="sbx-prompt__label">Prompt for your agent</span>
    <button class="sbx-copy sbx-prompt__copy" type="button" data-copy aria-label="Copy this prompt">
      <span class="sbx-copy__word">Copy</span>
    </button>
  </div>
  <pre class="sbx-prompt__pre"><code>Install sandboxer on this machine.</code></pre>
</div>`;

const DETAILS = `
<details class="sbx-detail" data-kind="agent">
  <summary class="sbx-detail__summary"><span class="sbx-detail__chip">Details for an agent</span></summary>
  <div class="sbx-detail__body"><p>every flag</p></div>
</details>
<details class="sbx-detail" data-kind="failure">
  <summary class="sbx-detail__summary"><span class="sbx-detail__chip">If it goes wrong</span></summary>
  <div class="sbx-detail__body"><p>what to do</p></div>
</details>`;

const LINKS = `
<p>
  <a href="/reference/cli/">the CLI</a>
  <a href="#what-happens-first">this section</a>
  <a href="https://github.com/example" target="_blank" rel="noreferrer">GitHub</a>
</p>`;

const mount = (
  html: string,
  over: Partial<Parameters<typeof Article>[0]> = {},
) =>
  render(
    <Article
      title="Your first sandbox"
      description="One sentence."
      html={html}
      slug="getting-started/first-sandbox"
      expandAll={false}
      onExpandAll={() => undefined}
      {...over}
    />,
  );

const copyButton = (label: string) => screen.getByLabelText(label);
const word = (label: string): string =>
  copyButton(label).querySelector(".sbx-copy__word")?.textContent ?? "";

describe("copying", () => {
  it("copies the nearest block's code, not the button's own text", async () => {
    mount(CODE);
    fireEvent.click(copyButton("Copy this code"));
    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toBe("cd .worktrees/tkt-4821\nsandboxer up");
  });

  it("copies a prompt card the same way", async () => {
    mount(PROMPT);
    fireEvent.click(copyButton("Copy this prompt"));
    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toBe("Install sandboxer on this machine.");
  });

  it("copies the block the click landed in, with several on the page", async () => {
    mount(`${CODE}${PROMPT}`);
    fireEvent.click(copyButton("Copy this prompt"));
    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toBe("Install sandboxer on this machine.");
  });

  it("confirms on the button that it copied", async () => {
    mount(CODE);
    fireEvent.click(copyButton("Copy this code"));
    await waitFor(() => expect(word("Copy this code")).toBe("Copied"));
    expect(copyButton("Copy this code")).toHaveAttribute("data-state", "copied");
    // And it is announced, because the button's label has to stay "Copy this code"
    // for the reader who has not pressed it yet.
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("falls back to a selection copy when there is no clipboard API", async () => {
    // What an `http://` preview host looks like: `navigator.clipboard` is not
    // exposed on an insecure origin at all.
    const had = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });

    mount(CODE);
    fireEvent.click(copyButton("Copy this code"));
    await waitFor(() => expect(word("Copy this code")).toBe("Copied"));
    expect(exec).toHaveBeenCalledWith("copy");

    Object.defineProperty(navigator, "clipboard", { value: had, configurable: true });
  });

  it("says so on the button when both routes fail", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });

    mount(CODE);
    fireEvent.click(copyButton("Copy this code"));
    await waitFor(() => expect(word("Copy this code")).toBe("Press ⌘C"));
    expect(copyButton("Copy this code")).toHaveAttribute("data-state", "failed");
    // And the code is selected, so the keystroke it suggests actually works.
    expect(window.getSelection()?.toString()).toContain("sandboxer up");
  });
});

describe("expand everything", () => {
  it("renders a page already open when the preference is on", () => {
    // The reason this matters: somebody arrives at a page with the preference
    // already set, and the prerendered file has every block closed.
    const { container } = mount(DETAILS, { expandAll: true });
    const blocks = [...container.querySelectorAll<HTMLDetailsElement>(".sbx-detail")];
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.open)).toBe(true);
  });

  it("renders a page closed when the preference is off", () => {
    const { container } = mount(DETAILS);
    const blocks = [...container.querySelectorAll<HTMLDetailsElement>(".sbx-detail")];
    expect(blocks.some((block) => block.open)).toBe(false);
  });

  it("asks to turn the preference on, and reports how many blocks there are", () => {
    const onExpandAll = vi.fn();
    mount(DETAILS, { onExpandAll });
    expect(screen.getByText("2 blocks of detail")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Expand everything/ }));
    expect(onExpandAll).toHaveBeenCalledWith(true);
  });

  it("asks to turn it off again when it is on", () => {
    const onExpandAll = vi.fn();
    mount(DETAILS, { expandAll: true, onExpandAll });
    fireEvent.click(screen.getByRole("button", { name: /Collapse everything/ }));
    expect(onExpandAll).toHaveBeenCalledWith(false);
  });

  it("is absent on a page with nothing to expand", () => {
    mount("<p>Just prose.</p>");
    expect(screen.queryByRole("button", { name: /everything/ })).not.toBeInTheDocument();
  });
});

describe("links inside the prose", () => {
  it("navigates in place for a link to another page on this site", () => {
    const onNavigate = vi.fn();
    mount(LINKS, { onNavigate });
    fireEvent.click(screen.getByText("the CLI"));
    expect(onNavigate).toHaveBeenCalledWith("/reference/cli/");
  });

  it("navigates in place for a link to a section of this page", () => {
    const onNavigate = vi.fn();
    mount(LINKS, { onNavigate });
    fireEvent.click(screen.getByText("this section"));
    expect(onNavigate).toHaveBeenCalledWith("/#what-happens-first");
  });

  it("leaves an off-site link to the browser", () => {
    const onNavigate = vi.fn();
    mount(LINKS, { onNavigate });
    fireEvent.click(screen.getByText("GitHub"));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("leaves a ⌘-click to the browser", () => {
    const onNavigate = vi.fn();
    mount(LINKS, { onNavigate });
    fireEvent.click(screen.getByText("the CLI"), { metaKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
