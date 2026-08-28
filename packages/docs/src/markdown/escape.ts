// Escaping, for the HTML this pipeline writes by hand.
//
// Most of the output comes out of `marked`, which escapes for us. These two are
// for the places where the pipeline builds markup itself around content it was
// handed raw — a prompt fence's body, a diagram's source — and where getting it
// wrong would either break the page or, worse, silently change what a reader
// copies out of it.
//
// They are deliberately two functions and not one. A text node needs `&`, `<`
// and `>` handled and nothing else; a double-quoted attribute additionally needs
// `"`, and escaping `"` inside a text node would put a literal `&quot;` in front
// of whoever copies it. That is the specific failure the split prevents: the
// mermaid source is written into *both* a `data-chart` attribute and a visible
// `<pre>`, and one escaping rule for both cannot be right for either.

/** For a text node. `'` and `"` are left alone — they are already literal there. */
export const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** For the inside of a double-quoted attribute. */
export const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
