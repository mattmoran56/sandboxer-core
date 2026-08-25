---
title: Secrets
description: How real third-party credentials reach a sandbox, why anything describing where something runs is refused, and why renaming a variable is sometimes the only thing between you and a 401.
sidebar:
  order: 3
---

> **Written, never run** — The import, the filtering rules and the check are written and covered by unit tests in packages/core/src/secrets.ts. No real .env file has been imported for a real sandbox.

A sandbox needs a few real credentials — an identity provider, an analytics key — and must never
be given others. The `secrets` block is where a project draws that line, once, in a file that
gets reviewed.

Nothing here is typed at a prompt or pasted into a terminal. Credentials go from one file on
disk to another, and **only their names are ever printed**.

```yaml
secrets:
  read:
    - services/api/.env
    - web/packages/web/.env
  keep:
    - AUTH0_DOMAIN
    - AUTH0_CLIENT_ID
    - AUTH0_CLIENT_SECRET
    - ANALYTICS_API_KEY
    - JWT_SECRET
  rename:
    ANALYTICS_API_HOST: ANALYTICS_ENDPOINT
    VITE_AUTH0_DOMAIN: SANDBOXR_AUTH0_SPA_DOMAIN
  never:
    - "DB_*"
    - "MYSQL_*"
    - "S3_*"
    - "*_URL"
    - "PORT"
    - "ENV"
```

## The four lists, in plain words

**`read` — what to look in.** A list of files, relative to the repo root. These are almost always
the `.env` files developers already have on their machines. Files are read in order and a later
one wins, which is how a front-end's `.env` can supply a name the backend's does not have. A file
that is not there is reported and skipped, not an error.

**`keep` — what to bring.** An allowlist of variable names. Anything the files contain that is
not on this list is dropped. Nothing is imported because it looked important.

**`rename` — what to call it once it is here.** The name on the left is what the `.env` file
calls it; the name on the right is what the sandbox will call it. Two very different reasons to
need this, [below](#why-rename-is-load-bearing).

**`never` — what to refuse whatever else the file says.** A list of patterns, where `*` matches
anything. It is applied to every name that was not explicitly renamed, and it is the most
important line in the block.

## Two commands, and no third

```bash
sandboxr secrets import   # read those files, write the project's secrets file
sandboxr secrets check    # say which credentials are missing, by name
```

That is the whole surface. There is no command that lists what is in the file and no command
that prints a value, because there is no safe version of either.

An import looks like this:

```
  ok read /home/you/acme/services/api/.env
   ! not found: /home/you/acme/web/packages/web/.env
  ok wrote 7 credential(s) to /home/you/.sandboxr/secrets/acme.env
  imported (names only):
      ANALYTICS_ENDPOINT
      AUTH0_CLIENT_ID
      AUTH0_CLIENT_SECRET
      AUTH0_DOMAIN
      JWT_SECRET
      SANDBOXR_AUTH0_SPA_DOMAIN
```

And a check:

```
  ok AUTH0_DOMAIN
  ok AUTH0_CLIENT_ID
   ! JWT_SECRET is missing
```

**Names only, never values.** That is a design goal rather than politeness. It means the command
is safe to run in a screen share, safe to paste into a ticket, and safe to hand to an agent whose
transcript you have not read.

<details>
<summary><b>Details for an agent:</b> what the import writes, where, and the exact rules it applies to a name</summary>

`sandboxr secrets import` writes `~/.sandboxr/secrets/<project>.env`, mode 0600. It is written to
a `.partial` name first and moved into place, so an interrupted import can never leave half a
credential file behind. The generated per-sandbox environment is a separate file,
`~/.sandboxr/build/<project>/<slug>.env`.

The rules, applied per name, in this order:

1. If the name is a key of `rename`, it is imported under the renamed name. **An explicit rename
   is its own permission** — neither `keep` nor `never` gets a say, because the author has named
   both the source and the destination in a reviewed file.
2. Otherwise, if the name matches any pattern in `never`, it is dropped.
3. Otherwise, if the name is in `keep`, or is the target of some rename, it is imported.
4. Otherwise it is dropped.

Only `*` is meaningful in a `never` pattern, and it matches any run of characters. Everything
else is matched literally, so a pattern can never accidentally become a regular expression.

Parsing a `.env` file: `NAME=value`, with an optional `export ` in front and whitespace anywhere
sensible. One layer of matching quotes is stripped. On an *unquoted* value, a trailing ` #`
comment is removed — some loaders keep it and services do not. **An empty value is dropped**,
because a name present but blank is what a template looks like, and importing it would mask a
real value from a later file.

`sandboxr secrets check` reports on the names the config asks for: every name in `keep` that is
not itself renamed, plus every rename target. It exits non-zero if any is missing, or if there is
no secrets file at all. `sandboxr doctor` runs the same check as one of its findings.

Source: `packages/core/src/secrets.ts`.

</details>

## Anything describing *where* something runs is never imported

This is the rule that prevents the worst thing that can happen in this whole system.

`DB_HOST`, `MYSQL_*`, `S3_ENDPOINT`, `API_URL`, `PORT` — these do not identify anybody. They say
**where** something is. A sandbox works all of those out for itself: its database is inside its
own container, its object storage is inside its own container, and its services reach each other
on internal ports.

Import a developer's `DB_HOST` and you get a disposable copy of a container **pointed at their
real database**. Nothing errors. The app works perfectly. Then a migration you thought you were
testing safely runs against something that was never a copy, and a test upload lands in a
production bucket.

> [!CAUTION] This is why `never` is a second barrier, applied after `keep`
> `keep` is an allowlist, so in principle nothing unlisted can get through and `never` is
> redundant. It is there anyway, because the cost of one careless addition to `keep` is a write to
> production. Two mechanisms for one rule is the right amount here.
>
> Put the patterns in `never` even when nothing matching them is in `keep`. It records the intent,
> and it protects the next person who adds a variable without thinking about it.

The `env` block in [sandboxr.yaml](./sandboxr-yaml.md) is how your project gets these values
instead: it maps the names the sandbox computes for itself onto the names your code already
reads.

<details>
<summary><b>Details for an agent:</b> the categories a sandbox always provides for itself, and what each one is derived from</summary>

None of these belongs in `secrets`, and all of them belong in `never`.

| Category | Names like | Where the sandbox gets it |
|---|---|---|
| Database location and credentials | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `MYSQL_*` | Its own database, on loopback inside the container |
| Object storage | `S3_ENDPOINT`, `S3_KEY`, `S3_SECRET`, bucket names | Its own object store, inside the container |
| Inter-service URLs | `API_URL`, anything `*_URL` | Computed from the config's labels and this sandbox's slug |
| Ports | `PORT` | The `port` on each entry in the config |
| Environment name | `ENV`, `NODE_ENV` | The sandbox decides |
| CORS allowlists | `CORS_ALLOWED_ORIGINS` | Derived from the sandbox's own hostnames |

That last row has a consequence worth knowing: because a sandbox computes its own allowlist from
its own hostnames, a **new sandbox needs no API-side configuration at all**. The only external
system that has to be told a sandbox hostname exists is your identity provider, and one wildcard
per app label covers every slug for ever. [Prerequisites](../getting-started/prerequisites.md).

</details>

## Why `rename` is load-bearing

It looks like a convenience. It is not. There are two distinct situations, and the second one is
the reason this field exists at all.

### The same value has two names

Codebases drift. The `.env` files say `ANALYTICS_API_HOST`; the code reads `ANALYTICS_ENDPOINT`.
Nobody is going to renormalise every `.env` file on every developer's machine, so the config
aliases one to the other:

```yaml
rename:
  ANALYTICS_API_HOST: ANALYTICS_ENDPOINT
```

### Two names that must **not** be merged

This is the important one, and it is the case people get wrong.

A browser-side identity setting and a server-side one can legitimately be different values. An
identity provider can serve the same tenant on both a custom domain and a provider-issued domain,
and different parts of one product can be pointed at different ones.

If you fold `VITE_AUTH0_DOMAIN` into `AUTH0_DOMAIN` because they "look like the same thing", the
browser gets a token issued by one of them and the API validates it against the other. The API
rejects it as having an invalid issuer.

**The symptom is memorable and completely misleading: login succeeds**, the user lands in the
app, and then every single API call comes back 401. Nothing in that picture points at a variable
name in a config file. People lose a day to it.

So the browser-side values are carried across under names of their own, and never collide with
the server-side pair:

```yaml
rename:
  VITE_AUTH0_DOMAIN: SANDBOXR_AUTH0_SPA_DOMAIN
  VITE_AUTH0_CLIENT_ID: SANDBOXR_AUTH0_SPA_CLIENT_ID
  VITE_AUTH0_AUDIENCE: SANDBOXR_AUTH0_SPA_AUDIENCE
```

They are then handed to the front-end build under whatever names that build expects, through the
`env` block.

<details>
<summary><b>Why it works this way:</b> why a rename is allowed to override the `never` list</summary>

`never` is a pattern over the *shape* of a name; `rename` is an explicit statement about one
specific name. They are for opposite purposes, so the specific one wins.

The example above is exactly why. A browser-side setting is often spelled `VITE_SOMETHING_URL`
and would be caught by `"*_URL"` — but it is a vendor setting the sandbox cannot invent for
itself, so it genuinely has to be imported. Meanwhile the pattern still has to catch every
inter-service URL nobody thought to list.

The alternative would be forcing every project to write `never` patterns precise enough to carve
out their own exceptions, which is how you end up with a denylist nobody dares to touch.

</details>

## Public sandboxes get dummy credentials

If `access.apps` is `public`, third-party credentials must be **dummies** — unless the project
explicitly opts in:

```yaml
access:
  apps: public
  credentials: real     # dummy is the default
```

Anyone who can open a public app can drive it. Without that default, a stranger with a link could
make it send real email, spend real credit, or write to a real analytics property.

`credentials: real` is the opt-in, and it is a decision recorded in a reviewed file rather than a
flag somebody passes once. The other way to get real credentials is `access.apps: private`, which
puts the app hostnames behind the same login as the dashboard — that lifts the restriction because
only people you have given a password to can reach them.

[Public sandboxes](../security/public-sandboxes.md) covers this and the matching rule about data.

<details>
<summary><b>If it goes wrong:</b> what a missing or wrong credential looks like, and where to look first</summary>

| What you see | Usually |
|---|---|
| `sandboxr secrets check` names a variable as missing | Its `.env` file is not in `read`, or the value in that file is blank — an empty value is deliberately not imported |
| `no secrets file yet` | `sandboxr secrets import` has never been run for this project |
| Login works, every API call returns 401 | A browser-side and a server-side identity variable have been merged. See above |
| A service behaves as if it has no credentials at all | The name reached the sandbox under a different spelling from the one the code reads — check `rename`, then the `env` block |
| The sandbox is talking to something real | Something that describes a location was imported. Check `never`, then `env` |

`sandboxr doctor` prints the same missing-credential finding, with `sandboxr secrets import` as
the suggested fix, alongside its other checks.

</details>

## Related

- [sandboxr.yaml, field by field](./sandboxr-yaml.md) — the `secrets` block beside everything
  else, and the `env` block it works with.
- [Public sandboxes](../security/public-sandboxes.md) — the two refusals that make a public URL safe.
- [A MySQL monorepo](./example-monorepo.md) — a real `secrets` block, with its reasoning
  written into the file.
