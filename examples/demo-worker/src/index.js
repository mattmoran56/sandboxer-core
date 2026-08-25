/**
 * A Cloudflare Worker on D1: a guestbook.
 *
 * Deliberately one file with no build step. It exists to be the smallest thing
 * that is still a real application — it reads and writes a real database, it
 * serves real HTML, and every part of it has to work for the page to render.
 */

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

const page = (notes, sandbox) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sandboxr demo — guestbook</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 3rem 1.25rem; display: flex; justify-content: center;
    background: Canvas; color: CanvasText;
  }
  main { width: 100%; max-width: 34rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .where { opacity: .65; font-size: .875rem; margin: 0 0 2rem; }
  .where code { font-size: .875rem; }
  form { display: flex; gap: .5rem; margin: 0 0 2rem; }
  input, button { font: inherit; padding: .55rem .8rem; border-radius: .5rem; border: 1px solid #8884; }
  input { flex: 1; background: Canvas; color: CanvasText; }
  button { cursor: pointer; background: #2563eb; color: #fff; border-color: #2563eb; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  li { border: 1px solid #8883; border-radius: .5rem; padding: .7rem .9rem; }
  time { display: block; opacity: .55; font-size: .8rem; }
  .empty { opacity: .6; }
</style>
</head>
<body>
<main>
  <h1>Guestbook</h1>
  <p class="where">Served from sandbox <code>${escape(sandbox.slug)}</code> at
    <code>${escape(sandbox.host)}</code> — ${notes.length} row(s) in D1.</p>

  <form method="post" action="/notes">
    <input name="body" maxlength="140" placeholder="Leave a note" required autocomplete="off">
    <button type="submit">Sign</button>
  </form>

  ${
    notes.length === 0
      ? '<p class="empty">Nothing here yet. The fixtures did not run, or someone cleared it.</p>'
      : `<ol>${notes
          .map(
            (note) =>
              `<li>${escape(note.body)}<time>${escape(note.created_at)}</time></li>`,
          )
          .join("")}</ol>`
  }
</main>
</body>
</html>
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const sandbox = { slug: env.SANDBOXR_SLUG ?? "local", host: url.host };

    if (request.method === "POST" && url.pathname === "/notes") {
      const form = await request.formData();
      const body = String(form.get("body") ?? "").trim().slice(0, 140);
      if (body !== "") {
        await env.DB.prepare("INSERT INTO notes (body) VALUES (?)").bind(body).run();
      }
      // 303 so a refresh after posting re-reads the list instead of re-posting it.
      return new Response(null, { status: 303, headers: { location: "/" } });
    }

    // A machine-readable answer as well as the page: this is what the end-to-end
    // check asserts against, so a change to the markup cannot break the test.
    if (url.pathname === "/api/notes") {
      const { results } = await env.DB.prepare(
        "SELECT id, body, created_at FROM notes ORDER BY id DESC",
      ).all();
      return Response.json({ sandbox: sandbox.slug, notes: results });
    }

    if (url.pathname === "/health") return new Response("ok\n");

    if (url.pathname !== "/") return new Response("not found\n", { status: 404 });

    const { results } = await env.DB.prepare(
      "SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 50",
    ).all();
    return new Response(page(results, sandbox), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
