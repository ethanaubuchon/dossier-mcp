# Library — AI Agent Instructions

## Stack

- Server: `server/` — Node.js, TypeScript (ESM), Jest
- MCP: `server/src/mcp/` — Model Context Protocol server (stdio transport) exposing note tools and resources
- Notes: Markdown files with YAML frontmatter, read from a vault directory via chokidar
- Search: In-memory full-text search built on the note index

## Development Commands

This repo uses **pnpm** (pinned via `packageManager` / Corepack). All commands run from `server/`.

| Script | Purpose |
|--------|---------|
| `pnpm mcp` | Start the MCP server (stdio transport) — the primary entry point (`src/mcp-entry.ts`) |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm test` | Run the Jest test suite |
| `pnpm start:mcp` | Run the compiled MCP server (`dist/mcp-entry.js`) |

> `pnpm dev` and `pnpm start` reference a legacy HTTP entry (`src/index.ts`) that no longer exists — use the MCP scripts above.

## Code Conventions

- **Comments explain how the code works, not its history.** Describe current behavior, invariants, and non-obvious rationale. Do **not** cite issue or PR numbers (`#89`), acceptance-criterion tags (`AC #4`), or "delivered by / deferred to" phrasing in comments, docstrings, or test labels — that archaeology goes stale the moment it merges. Historic context belongs in commit messages and PR descriptions, not in the source.

## Key Gotchas

_Agents: if you discover a project-specific trap, workaround, or non-obvious convention
during your work, add it here before completing the session._

- **Multi-vault `search_notes` scores are not normalized across vaults.** With more than one configured vault, each vault has its own `SearchIndex`; the tool queries each and merges results by raw BM25 score. Because IDF / avgDocLen / docFreq are computed *per index*, raw scores are only loosely comparable across vaults — a term that is rare in a small vault can outrank the same term in a large one. Accepted at the single-user / few-vaults scale; there is no cross-corpus normalization in v1. Don't treat cross-vault score ordering as globally calibrated ranking.

## Feature Development Workflow

### Starting a Feature

Always use a branch and worktree — even for small changes. This keeps main clean and other sessions unblocked.

1. `git fetch origin main`
2. `git worktree add .worktrees/<branch-name> -b <branch-name> origin/main` — creates the branch and its worktree in one step, off up-to-date `main`

### Small Changes (≤ 2 files AND ≤ 50 lines)

Skip brainstorm and plan. Go straight to:
**branch + worktree → TDD → verify → finish branch**

### Larger Features

1. **Brainstorm** (`superpowers:brainstorming`) — explore intent, requirements, design
2. **Write plan** (`superpowers:writing-plans`) — step-by-step implementation plan
3. **Execute** — choose one:
   - `superpowers:subagent-driven-development` — fresh subagent per task with two-stage review (recommended)
   - `superpowers:executing-plans` — inline execution with human checkpoints
4. **Verify** (`superpowers:verification-before-completion`) — run tests, confirm output
5. **Code review** (`superpowers:requesting-code-review`)
6. **Finish branch** (`superpowers:finishing-a-development-branch`) — **REQUIRED, do not skip** — handles docs cleanup, merge/PR

## Completion

When work is done, invoke `superpowers:finishing-a-development-branch`. It will guide you through:

1. Adding any discovered gotchas to the **Key Gotchas** section above
2. Deleting `docs/superpowers/specs/` and `docs/superpowers/plans/` files created for this feature
3. Committing deletions: `chore: remove implementation plan`
4. Pushing the branch
5. Opening a pull request

**Do not skip this skill.** Skipping it leaves plan/spec artifacts in the repo and risks missing cleanup steps.

**If the implementation plan includes an "Open PR" task, do not execute it.** That task is superseded by this skill — `finishing-a-development-branch` handles PR creation as part of the full cleanup flow. Executing the plan's PR task directly bypasses the cleanup steps.
