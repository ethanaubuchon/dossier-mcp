# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately via [GitHub Security Advisories](https://github.com/ethanaubuchon/dossier-mcp/security/advisories/new). Please do not open a public issue for an unfixed vulnerability.

This is a single-maintainer hobby project, not a commercial product. There is no SLA. Expect a best-effort response.

## Supported versions

| Version | Supported |
|---|---|
| `v1.0.0` and later | Yes |
| Unreleased `main` | Best effort |

## What this software is

dossier-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI coding agent a persistent, cross-session memory stored as Markdown files in a directory (the "vault").

It runs as a **child process of your MCP client** (e.g. Claude Code), launched by that client, communicating over stdin/stdout. It is not a service, not a daemon, and not multi-user. It runs with the privileges of the user who started the client, and has no privilege boundary of its own.

## Threat model

### Assets

1. **Vault contents** — your notes. Plain Markdown on local disk. Often the most sensitive thing here, since a memory vault accumulates context over time.
2. **Filesystem outside the vault** — must remain unreachable through this server.
3. **The host process** — must not execute attacker-controlled code.

### Trust boundaries

| Party | Trust | Notes |
|---|---|---|
| The user running the client | Trusted | Already has full filesystem access; this server grants nothing new. |
| The MCP client / agent | Semi-trusted | Issues tool calls. Presumed non-malicious but **not** presumed correct — an agent can be steered by prompt injection in the content it reads. |
| Note file contents | **Untrusted** | Files arrive by agent write, by hand, and by file sync. Treated as hostile input by the parser. |
| The network | Not in scope | This server makes no network connections. See below. |

### Primary threats considered

- **Path traversal** — a crafted slug reaching files outside the vault.
- **Code execution via note content** — malicious data in a note file being executed during parsing.
- **Silent data exfiltration** — note content leaving the machine.
- **Data loss** — notes destroyed by malformed or hostile tool calls.

### Explicitly out of scope

- **Prompt injection of the agent itself.** A note can contain text that manipulates an LLM reading it. This server cannot detect or prevent that; it is a property of the agent, not of storage. Treat vault content as data your agent will believe.
- **A compromised or malicious MCP client.** It already runs as you.
- **Local attackers with filesystem access.** They can read the vault directly without going through this server.
- **Encryption at rest.** Notes are plain Markdown by design — readable in Obsidian, `grep`, and any editor. Use full-disk or filesystem encryption if you need it.

## Guarantees

### Stdio-only — no network listener

The server communicates exclusively over stdin/stdout using the MCP SDK's `StdioServerTransport` (`server/src/mcp-entry.ts`).

- It **opens no listening socket** and binds no port.
- It **makes no outbound connections**. There are no HTTP clients, no sockets, no telemetry, and no analytics anywhere in `server/src`. Verifiable: `grep -rn "fetch(\|http\.\|https\.\|axios\|net\.\|WebSocket" server/src` returns nothing.
- Its runtime dependencies are the MCP SDK, `chokidar` (file watching), `gray-matter` (frontmatter), `js-yaml`, `slugify`, and `zod`. None is a network client.

Consequently, notes do not leave the machine through this server. Anything that reaches a network does so via your MCP client — the same path any file you show your agent already takes.

Earlier revisions shipped a Dockerfile and Compose files declaring port 3001, left over from an abandoned HTTP prototype. Nothing ever bound that port. They were removed in v1.0.0 to prevent exactly the misreading this section forestalls.

### Vault confinement

Every note path is resolved and bounds-checked before use (`NoteStore.notePath`):

1. **Slug validation** rejects empty slugs, slugs containing a null byte, slugs starting or ending with `/`, and any slug with a `..` path segment.
2. **Boundary check** then resolves the slug to an absolute path and requires it to equal the vault root or start with the vault root plus a path separator. The separator matters: it stops `/vault-evil` from passing a prefix match against `/vault`.

Both layers run on every read, write, move, and delete. See "Known limitations" for the symlink caveat.

### YAML-only frontmatter parsing

Frontmatter is parsed as YAML and nothing else.

`gray-matter` ships an engine that evaluates JavaScript frontmatter via `eval()`. All parsing goes through a single wrapper (`server/src/notes/parseMatter.ts`) that rejects any fence whose language is not YAML, and additionally overrides that engine to throw. YAML itself is parsed with `safeLoad`, so type tags such as `!!js/function` are refused by the schema.

All `gray-matter` access — read and write — lives in that one module, so the property can be audited by grepping for imports of `gray-matter`.

*(A `---js` fence did execute in pre-v1.0.0 `main`. It was fixed before the v1.0.0 tag; no released version contains it.)*

### No shell execution

The server never invokes a shell or a subprocess. `server/src` contains no import of `child_process`, no `spawn`/`execFile`/`execSync`, no `eval()`, and no `new Function()`. Verifiable:

```bash
grep -rn "child_process\|execSync\|execFile\|spawn(\|spawnSync\|[^.]eval(\|new Function" server/src
```

(The pattern excludes `.exec(` deliberately: the only matches for that spelling are `RegExp.prototype.exec` calls in the heading and wiki-link parsers.)

## Known limitations

Recorded deliberately. None is considered a vulnerability under the trust model above, but each is a real edge a reviewer should know about.

### Symlinks inside the vault are followed

The directory walk resolves symlinks (`NoteStore.walkMdFiles`). A symlink placed **inside** the vault pointing outside it will be traversed, and Markdown files beneath it indexed and readable through the server. The path bounds check does not defeat this, because the symlink's own path is legitimately inside the vault.

Placing such a symlink requires write access to the vault directory — at which point the attacker already has the user's filesystem privileges. It is therefore accepted rather than blocked. Symlink loops are handled: the walk tracks visited real paths, so cycles terminate.

**If your vault lives on a shared or synced volume that others can write to, do not place symlinks in it.**

### Vault writes are trusted by the index

Any process that can write to the vault directory can add, alter, or delete notes; the server will index the result. This is inherent to file-backed storage that you can also edit by hand — it is a feature of the design, not a hole in it.

### Deletions are real

`delete_note` unlinks the file. There is no trash, undo, or soft delete. `move_note` rewrites `related` references and inline `[[wiki-links]]` in *other* notes as a side effect. **Keep your vault in version control or under backup.** This is the most likely route to actual data loss in normal use.

### Search scores are not comparable across vaults

With multiple configured vaults, each has its own index and raw BM25 scores are merged without cross-corpus normalization. A correctness and ranking-quality caveat, not a security one; noted because it affects which notes an agent surfaces.

### No authentication or authorization

There is none, by design. The server trusts its stdio peer completely. Access control is entirely the operating system's: whoever can run the client can use the vault.

## Configuration that affects exposure

| Variable | Security relevance |
|---|---|
| `NOTES_DIR` | The vault root, and therefore the confinement boundary. Point it at a directory dedicated to notes — never at `$HOME` or a source tree, since everything under it becomes agent-readable. |
| `DOSSIER_CONFIG` | Path to a multi-vault `config.yaml`. Each configured vault is its own boundary. |
| `DOSSIER_EXCLUDE_TAGS` | Filters tagged notes out of `search_notes`, `list_notes`, and `list_todos` results. **Not a security control** — excluded notes remain fully readable via `get_note` and the `note://` resource. Use it for noise reduction, never to hide sensitive content. |

## Supply chain

- Six runtime dependencies, all widely used, none a network client.
- Installs use `pnpm install --frozen-lockfile`, which fails on lockfile drift rather than silently resolving different versions — so a reviewed tag, CI, and a developer machine resolve an identical tree. The lockfiles are committed.
- The pnpm version is pinned via the `packageManager` field.
- CI runs typecheck and the full test suite on every pull request.
