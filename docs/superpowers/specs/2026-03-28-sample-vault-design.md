# Design: Sample Vault Content

**Date:** 2026-03-28
**Issue:** #12
**Status:** Approved

## Summary

Ship a small set of example notes in `notes/` that demonstrate the agent-as-author paradigm out of the box. The MCP works immediately on fresh install, new users see what a real vault looks like, and the meta note explains the philosophy so they understand why this is different from an Obsidian MCP.

## Goals

- New users can register the MCP and immediately interact with working example content
- The example content demonstrates the agent-as-author paradigm through its structure and content, not just through documentation
- A meta/setup note explains the philosophy and gives first steps
- README gets a "Philosophy" section that positions this clearly vs. agent-as-reader tools

## Non-Goals

- Exhaustive vault templates for every use case
- Server-side fallback logic (notes/ is used as-is; no empty-vault detection)
- Tutorials or step-by-step onboarding beyond the getting-started note

## Files

### `notes/profile.md`

Replace the stale `react-hooks-rules.md` with a proper `profile.md` at the vault root. This is what `get_vault_context` reads — the bootstrap document.

Content: a template that shows the structure — vault overview, how it's organized, placeholder sections for personal context and current focus. Written generically enough that a new user can see the pattern and fill it in.

### `notes/inbox/getting-started.md`

The meta/task note. Written as if the agent created it to orient a new user. Covers:

- What this vault is and how to use it
- The agent-as-author paradigm — what it means, why it's more powerful than agent-as-reader
- First tasks: fill in profile.md, have a first session, let the agent start creating notes, delete these examples when ready
- How notes get organized (inbox → slug hierarchy as context accumulates)

### `notes/projects/example-project/overview.md`

A sample project context note written as if an agent captured it mid-conversation. Demonstrates:
- Nested slug structure (`projects/<name>/overview`)
- How project context looks when an agent writes it
- The `related` field linking to other notes
- Dense, useful content rather than a placeholder

### `notes/context/about-me.md`

A sample personal context note demonstrating the agent-as-author pattern for personal information. Shows:
- How an agent might write and maintain facts about the user
- That personal context lives in `context/` not `inbox/`
- The value of the agent remembering things across sessions

### `README.md` — Philosophy section

Add a "Philosophy" section before Setup. Two paragraphs:
1. Agent-as-author vs. agent-as-reader — what the distinction means
2. Why this is different from an Obsidian MCP or similar tools — the agent builds the knowledge base, you can optionally inspect it

## What Gets Removed

- `notes/react-hooks-rules.md` — delete, it's a stale test fixture

## What Stays the Same

- `notes/` directory name and location
- All server logic — no changes to the MCP server
- Frontmatter format: `title`, `date`, `tags`, `related`
