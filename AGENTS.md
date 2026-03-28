# Library — AI Agent Instructions

## Stack

- Server: `server/` — Node.js, Express, TypeScript (ESM), Jest
- MCP: `server/src/mcp/` — Model Context Protocol server exposing note tools
- Notes: Markdown files with YAML frontmatter, read from a vault directory via chokidar
- Search: In-memory full-text search built on the note index

## Development Commands

All commands run from `server/`.

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start Express server with hot reload |
| `npm run mcp` | Start MCP server (stdio transport) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run test` | Run Jest test suite |

## Key Gotchas

_Agents: if you discover a project-specific trap, workaround, or non-obvious convention
during your work, add it here before completing the session._

## Feature Development Workflow

### Starting a Feature

1. `git checkout main && git pull origin main`
2. `git checkout -b <branch-name>`
3. `git worktree add ../library-<branch-name> <branch-name>`

Skip the worktree for trivial single-file fixes (≤ 2 files AND ≤ 50 lines changed).

### Small Changes (≤ 2 files AND ≤ 50 lines)

Skip brainstorm and plan. Go straight to:
**TDD → verify → finish branch**

### Larger Features

1. **Brainstorm** (`superpowers:brainstorming`) — explore intent, requirements, design
2. **Write plan** (`superpowers:writing-plans`) — step-by-step implementation plan
3. **Execute** (`superpowers:executing-plans`) — human reviews between each step
4. **Verify** (`superpowers:verification-before-completion`) — run tests, confirm output
5. **Code review** (`superpowers:requesting-code-review`)
6. **Finish branch** (`superpowers:finishing-a-development-branch`) — merge/PR/cleanup

Always use `superpowers:executing-plans` to execute plans.

## Completion

When work is done:

1. If you discovered any gotchas, add them to the **Key Gotchas** section above
2. Commit changes with a clear message
3. Push the branch
4. Open a pull request
