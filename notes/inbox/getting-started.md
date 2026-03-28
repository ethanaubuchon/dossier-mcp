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
