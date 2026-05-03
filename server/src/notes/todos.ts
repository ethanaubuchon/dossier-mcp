const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;
const TODO_LINE_RE = /^[ \t]*[-*+] \[ \] (.+?)[ \t]*$/gm;

export function extractTodos(content: string): string[] {
  const stripped = content.replace(FENCED_CODE_BLOCK_RE, '');
  const todos: string[] = [];
  for (const match of stripped.matchAll(TODO_LINE_RE)) {
    todos.push(match[1]);
  }
  return todos;
}
