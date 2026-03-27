# Development Workflow

## Branching & Worktrees

Always develop on a branch with a git worktree. Before writing any code:

1. Create a branch: `git checkout -b <branch-name>`
2. Set up a worktree: `git worktree add ../library-<branch-name> <branch-name>`

Skip for trivial single-file fixes only.

## Planning

Write an implementation plan and align before touching code. For small changes a brief bullet list is fine; for larger features use a structured plan with files to change and rationale.

## Implementation

Use subagents to implement changes as much as permissions allow.

## Completion

When work is done:

1. Commit changes with a clear message
2. Push the branch
3. Open a pull request
