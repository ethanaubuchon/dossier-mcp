# Docs Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete historical implementation docs from the repo and update the completion workflow in `AGENTS.md` so future specs/plans are deleted as the final step of every feature branch.

**Architecture:** Two changes — a one-time cleanup of existing docs, and a workflow update to `AGENTS.md`. No code changes. This PR itself demonstrates the new workflow by deleting its own spec and plan as the final commit.

**Tech Stack:** Git, Markdown

---

## File Map

| File | Action |
|---|---|
| `docs/superpowers/specs/2026-03-21-pkm-system-design.md` | Delete |
| `docs/superpowers/plans/2026-03-21-pkm-mcp-server.md` | Delete |
| `docs/superpowers/plans/2026-03-27-coerce-string-array-inputs.md` | Delete |
| `AGENTS.md` | Modify — add plan deletion step to Completion section |
| `docs/superpowers/specs/2026-03-28-docs-lifecycle-design.md` | Delete (final commit) |
| `docs/superpowers/plans/2026-03-28-docs-lifecycle.md` | Delete (final commit) |

---

### Task 1: Delete historical docs

**Files:**
- Delete: `docs/superpowers/specs/2026-03-21-pkm-system-design.md`
- Delete: `docs/superpowers/plans/2026-03-21-pkm-mcp-server.md`
- Delete: `docs/superpowers/plans/2026-03-27-coerce-string-array-inputs.md`

- [ ] **Step 1: Delete the files**

```bash
git rm docs/superpowers/specs/2026-03-21-pkm-system-design.md \
       docs/superpowers/plans/2026-03-21-pkm-mcp-server.md \
       docs/superpowers/plans/2026-03-27-coerce-string-array-inputs.md
```

- [ ] **Step 2: Confirm staged deletions**

```bash
git status
```

Expected: three deleted files staged, nothing else.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove historical implementation docs"
```

---

### Task 2: Update AGENTS.md completion workflow

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Replace the Completion section**

Open `AGENTS.md` and replace the current Completion section:

```markdown
## Completion

When work is done:

1. If you discovered any gotchas, add them to the **Key Gotchas** section above
2. Commit changes with a clear message
3. Push the branch
4. Open a pull request
```

With:

```markdown
## Completion

When work is done:

1. If you discovered any gotchas, add them to the **Key Gotchas** section above
2. Commit changes with a clear message
3. Delete any `docs/superpowers/specs/` and `docs/superpowers/plans/` files created for this feature
4. Commit the deletions: `chore: remove implementation plan`
5. Push the branch
6. Open a pull request
```

- [ ] **Step 2: Verify the edit looks right**

```bash
git diff AGENTS.md
```

Expected: only the Completion section changed, new steps 3 and 4 added.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: add plan deletion step to completion workflow"
```

---

### Task 3: Delete this spec and plan (demonstrating the new workflow)

**Files:**
- Delete: `docs/superpowers/specs/2026-03-28-docs-lifecycle-design.md`
- Delete: `docs/superpowers/plans/2026-03-28-docs-lifecycle.md`

- [ ] **Step 1: Delete both files**

```bash
git rm docs/superpowers/specs/2026-03-28-docs-lifecycle-design.md \
       docs/superpowers/plans/2026-03-28-docs-lifecycle.md
```

- [ ] **Step 2: Confirm the docs/ directory is now empty**

```bash
find docs/ -type f
```

Expected: no output (directory empty or gone).

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove implementation plan"
```

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin <branch-name>
gh pr create --title "chore: docs lifecycle — delete historical docs, add deletion step to workflow" \
  --body "$(cat <<'EOF'
## Summary

- Deletes historical implementation specs/plans that are personal-path-heavy and have no audience now that their features are shipped
- Adds a workflow step to `AGENTS.md` so future specs/plans are deleted as the final commit of every feature branch
- Demonstrates the new workflow by deleting this PR's own spec and plan

## Test plan

- [ ] `docs/superpowers/` directory is empty after merge
- [ ] `AGENTS.md` Completion section includes the plan deletion steps
- [ ] Git history retains deleted files for reference

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Delete existing docs → Task 1
- ✅ Update `AGENTS.md` completion workflow → Task 2
- ✅ Delete spec/plan for this feature (demonstrating workflow) → Task 3
- ✅ Deletion in its own final commit → Task 3, Step 3

**Placeholder scan:** None — all steps contain exact commands.

**Type consistency:** N/A — no code changes.
