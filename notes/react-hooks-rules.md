---
title: React Hooks Rules
date: 2026-03-05
tags:
  - react
  - hooks
  - frontend
related: []
---

# React Hooks Rules

React hooks must follow two fundamental rules to work correctly.

## Rule 1: Only Call Hooks at the Top Level

Don't call hooks inside loops, conditions, or nested functions. Always use hooks at the top level of your React function, before any early returns.

**Bad:**
```js
if (condition) {
  const [value, setValue] = useState(null); // ❌
}
```

**Good:**
```js
const [value, setValue] = useState(null); // ✅
if (condition) {
  // use value here
}
```

## Rule 2: Only Call Hooks from React Functions

Call hooks from React function components or custom hooks — not from regular JavaScript functions.

## Why These Rules Exist

React relies on the order in which hooks are called to associate state and effects with the right component instance. Calling hooks conditionally breaks this ordering.

## The `eslint-plugin-react-hooks` Plugin

Use this ESLint plugin to automatically enforce both rules in your codebase:

```bash
npm install eslint-plugin-react-hooks --save-dev
```
