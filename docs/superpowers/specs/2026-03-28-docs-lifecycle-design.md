# Docs Lifecycle Design

**Date:** 2026-03-28

## Problem

The `docs/superpowers/specs/` and `docs/superpowers/plans/` directories accumulate implementation artifacts (specs, plans) generated during feature development. These files:

- Contain personal paths and context that are inappropriate for an open-source repo
- Have no audience once a feature ships — the PR, commit history, and issue list are the canonical record
- Add noise for contributors who encounter them

## Solution

Treat specs and plans as ephemeral branch artifacts. Delete them as the final step of every feature branch, in their own commit, before the PR is opened.

## Workflow Change

Add the following step to the **Completion** section of `AGENTS.md`, after code review and before pushing:

1. Delete any `docs/superpowers/specs/` and `docs/superpowers/plans/` files created for this feature
2. Commit: `chore: remove implementation plan`
3. Push and open the PR

The deletion is a **separate final commit** so it's visually distinct from feature work in the PR diff. GitHub renders deleted file contents in full — reviewers can still read the spec if they want context.

## Existing Docs

Delete `docs/superpowers/` entirely in a single commit on main. No history purge required — files contain only personal paths and homelab hostnames, all already public in the repo.

## What This Is Not

- No archive folder
- No TTL / automated cleanup
- No GitHub Actions
- No git hooks

## Out of Scope

If a long-lived architecture decision needs documentation (e.g. a major design pivot), that belongs in a `docs/architecture/` ADR — written once, maintained, not deleted. That convention is separate and not defined here.
