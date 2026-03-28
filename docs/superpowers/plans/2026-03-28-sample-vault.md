# Sample Vault Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stale `react-hooks-rules.md` test fixture with a curated set of example notes that demonstrate the agent-as-author paradigm out of the box, and add a Philosophy section to the README.

**Architecture:** Pure content creation — no server code changes. Five markdown files created/replaced in `notes/`, one README section added. Verification confirms valid YAML frontmatter on each file using gray-matter (already a project dependency).

**Tech Stack:** Markdown, YAML frontmatter, gray-matter

---

## Files

| File | Change |
|------|--------|
| `notes/react-hooks-rules.md` | Delete |
| `notes/profile.md` | Create |
| `notes/inbox/getting-started.md` | Create |
| `notes/projects/example-project/overview.md` | Create |
| `notes/context/about-me.md` | Create |
| `README.md` | Add Philosophy section before Setup |

---

### Task 1: Remove stale fixture and create profile.md

**Files:**
- Delete: `notes/react-hooks-rules.md`
- Create: `notes/profile.md`

- [ ] **Step 1: Delete the stale test fixture**

```bash
rm notes/react-hooks-rules.md
```

- [ ] **Step 2: Create notes/profile.md**

```bash
cat > notes/profile.md << 'EOF'
---
title: Vault Profile
date: '2026-03-28'
tags:
  - profile
  - meta
related: []
---
# My Vault

Brief description of what this vault is for and who maintains it.

## Structure

How this vault is organized — describe your folder conventions here.

- `inbox/` — unprocessed notes, landing zone for new captures
- `projects/` — project context and notes, organized by project name
- `context/` — persistent personal context the agent maintains about you
- `reference/` — reference material and resources

## How to Use This Vault

Instructions for the agent:
- Read this file first at the start of any session
- Check `inbox/` for unprocessed notes that may need organizing
- Use `context/about-me.md` for personal context about the vault owner
- When capturing new information, prefer updating existing notes over creating new ones
- Keep notes dense — conclusions and reasoning, not just facts

## Current Focus

What you're currently working on or thinking about. Update this regularly.

## About Me

Key facts the agent should remember about you. Fill this in — or let the agent populate it over time.
EOF
```

- [ ] **Step 3: Verify frontmatter is valid**

```bash
cd server && node -e "const m = require('gray-matter'); const r = m(require('fs').readFileSync('../notes/profile.md','utf-8')); console.log('title:', r.data.title); console.log('tags:', r.data.tags);" && cd ..
```

Expected output:
```
title: Vault Profile
tags: [ 'profile', 'meta' ]
```

- [ ] **Step 4: Commit**

```bash
git add notes/
git commit -m "feat: replace stale fixture with profile.md template"
```

---

### Task 2: Create inbox/getting-started.md

**Files:**
- Create: `notes/inbox/getting-started.md`

- [ ] **Step 1: Create the inbox directory and getting-started note**

```bash
mkdir -p notes/inbox
cat > notes/inbox/getting-started.md << 'EOF'
---
title: Getting Started
date: '2026-03-28'
tags:
  - meta
  - setup
  - tasks
related:
  - profile
---
# Getting Started with Your Vault

Welcome to the library MCP. This note explains how the vault works and what to do first.

## How This Works

This vault is designed for **agent-as-author** use: Claude writes and maintains notes here,
and you can optionally review them in Obsidian or any Markdown viewer. This is different
from tools like Obsidian MCP, where the agent reads notes *you* wrote.

The result is a persistent cross-session memory. Claude can pick up context from a previous
conversation, remember decisions you've made, and build up a knowledge base about your
projects and preferences — without you having to repeat yourself.

## First Steps

- [ ] Open `profile.md` and fill in your name, what this vault is for, and how you work
- [ ] Have a first session with Claude — ask it to read the vault context and introduce itself based on what it knows
- [ ] Let the agent create a few notes naturally during your conversation
- [ ] When ready, delete these example notes and replace them with your own

## How Notes Get Organized

New notes land in `inbox/` by default. Over time, you and the agent will develop conventions
for organizing them — project notes under `projects/<name>/`, personal context under
`context/`, reference material under `reference/`. The slug hierarchy is flexible; use what
makes sense for your vault.

## Tips

- **Let the agent write.** The more you let Claude capture things during conversations,
  the more useful the vault becomes.
- **Review occasionally.** Open the vault in Obsidian or a Markdown viewer to see what's
  been captured. Edit or correct anything that's wrong.
- **Keep profile.md current.** It's the first thing Claude reads. The more accurate it is,
  the better the context.
EOF
```

- [ ] **Step 2: Verify frontmatter is valid**

```bash
cd server && node -e "const m = require('gray-matter'); const r = m(require('fs').readFileSync('../notes/inbox/getting-started.md','utf-8')); console.log('title:', r.data.title); console.log('related:', r.data.related);" && cd ..
```

Expected output:
```
title: Getting Started
related: [ 'profile' ]
```

- [ ] **Step 3: Commit**

```bash
git add notes/inbox/getting-started.md
git commit -m "feat: add getting-started meta note explaining agent-as-author paradigm"
```

---

### Task 3: Create projects/example-project/overview.md

**Files:**
- Create: `notes/projects/example-project/overview.md`

- [ ] **Step 1: Create the nested directory and note**

```bash
mkdir -p notes/projects/example-project
cat > notes/projects/example-project/overview.md << 'EOF'
---
title: Example Project — Overview
date: '2026-03-28'
tags:
  - project
  - example
related:
  - context/about-me
---
# Example Project

*This is a sample project note showing how an agent captures project context
mid-conversation. Replace this with notes about your actual projects.*

## What This Is

A demonstration of how project context looks when captured by the agent. Notes like this
get created when you're discussing a project with Claude and want to preserve the context
for future sessions.

## Current Status

In progress. Key decisions made so far:

- Using TypeScript for type safety
- Keeping the architecture simple — one file per concern
- Tests before implementation

## Open Questions

- How to handle authentication?
- Should this be a CLI tool or a library?

## Notes

Agent captured this context on 2026-03-28 during initial project planning discussion.
EOF
```

- [ ] **Step 2: Verify frontmatter is valid**

```bash
cd server && node -e "const m = require('gray-matter'); const r = m(require('fs').readFileSync('../notes/projects/example-project/overview.md','utf-8')); console.log('title:', r.data.title); console.log('tags:', r.data.tags);" && cd ..
```

Expected output:
```
title: Example Project — Overview
tags: [ 'project', 'example' ]
```

- [ ] **Step 3: Commit**

```bash
git add notes/projects/
git commit -m "feat: add example project note demonstrating nested slug structure"
```

---

### Task 4: Create context/about-me.md

**Files:**
- Create: `notes/context/about-me.md`

- [ ] **Step 1: Create the context directory and note**

```bash
mkdir -p notes/context
cat > notes/context/about-me.md << 'EOF'
---
title: About Me
date: '2026-03-28'
tags:
  - context
  - personal
related:
  - profile
---
# About Me

*This is a sample personal context note showing how an agent maintains facts about you
across sessions. Replace this with real content — or let Claude build it up over time.*

## Work

- Role: [Your role]
- Current focus: [What you're working on]
- Tools and stack: [Languages, frameworks, tools you use]

## Preferences

- Communication style: [How you like to work with AI]
- Detail level: [Brief answers or thorough explanations?]
- Things to avoid: [Anything the agent should not do]

## Notes

Agent last updated this note: 2026-03-28.
EOF
```

- [ ] **Step 2: Verify frontmatter is valid**

```bash
cd server && node -e "const m = require('gray-matter'); const r = m(require('fs').readFileSync('../notes/context/about-me.md','utf-8')); console.log('title:', r.data.title); console.log('related:', r.data.related);" && cd ..
```

Expected output:
```
title: About Me
related: [ 'profile' ]
```

- [ ] **Step 3: Commit**

```bash
git add notes/context/about-me.md
git commit -m "feat: add example personal context note"
```

---

### Task 5: Add Philosophy section to README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read README.md to identify insertion point**

Read `README.md`. The Philosophy section should be inserted between the opening description paragraph and the `## Setup` heading.

The current README opens with:

```
# library

Personal knowledge management MCP server...

Built and tested with [Claude Code]...

## Setup
```

- [ ] **Step 2: Insert Philosophy section**

Add the following between the intro paragraphs and `## Setup`:

```markdown
## Philosophy

This tool is designed for **agent-as-author** use: Claude writes and maintains notes in your vault, building up a persistent cross-session memory that you can optionally inspect in Obsidian or any Markdown viewer.

This is the inverse of tools like Obsidian MCP, where the agent reads notes *you* wrote. Here, the agent is the primary author. You direct conversations, the agent captures context, decisions, and knowledge — and picks it all back up next session without you repeating yourself. The result is a lightweight RAG you didn't have to build: structured, searchable, human-readable, and maintained by the agent as a side effect of working with you.

```

- [ ] **Step 3: Verify README renders correctly**

```bash
grep -A 6 "## Philosophy" README.md
```

Expected: the Philosophy section appears with both paragraphs.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add Philosophy section explaining agent-as-author paradigm"
```

---

### Task 6: Open PR

- [ ] **Step 1: Push and create PR**

```bash
git push -u origin feat/sample-vault
gh pr create --title "feat: add sample vault content and philosophy section" --body "$(cat <<'EOF'
## Summary

- Removes stale `react-hooks-rules.md` test fixture
- Adds `notes/profile.md` — vault bootstrap document template
- Adds `notes/inbox/getting-started.md` — meta note explaining agent-as-author paradigm and first steps
- Adds `notes/projects/example-project/overview.md` — sample nested project note
- Adds `notes/context/about-me.md` — sample personal context note
- Adds Philosophy section to README positioning this vs. agent-as-reader tools

MCP works out of the box on fresh install with these example notes. Users delete them when ready to populate their own vault.

Closes #12
EOF
)"
```
