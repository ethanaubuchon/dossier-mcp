import { useState, useEffect } from 'react';

interface MCPSetupPanelProps {
  onSelectNote: (slug: string) => void;
}

export function MCPSetupPanel({ onSelectNote: _onSelectNote }: MCPSetupPanelProps) {
  const [notesDir, setNotesDir] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((c) => setNotesDir(c.notesDir || ''))
      .catch(() => {});
  }, []);

  const serverPath = window.location.hostname === 'localhost'
    ? '/path/to/library/server'
    : '/path/to/library/server';

  const desktopConfig = JSON.stringify(
    {
      mcpServers: {
        library: {
          command: 'node',
          args: [`${serverPath}/dist/mcp-entry.js`],
          env: { NOTES_DIR: notesDir || '/path/to/library/notes' },
        },
      },
    },
    null,
    2
  );

  const devConfig = JSON.stringify(
    {
      mcpServers: {
        library: {
          command: 'npx',
          args: ['tsx', `${serverPath}/src/mcp-entry.ts`],
          env: { NOTES_DIR: notesDir || '/path/to/library/notes' },
        },
      },
    },
    null,
    2
  );

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-8 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Connect to Claude</h1>
          <p className="text-zinc-400 text-sm leading-relaxed">
            Library works as an MCP server — your notes become tools and resources that Claude
            can use directly. No API key required: just connect Claude Desktop to this server
            and start a conversation.
          </p>
        </div>

        {/* How it works */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          {[
            { icon: '📚', label: 'Browse', desc: 'Use this web app to view and edit notes' },
            { icon: '🔌', label: 'Connect', desc: 'Point Claude Desktop at the MCP server' },
            { icon: '💬', label: 'Chat', desc: 'Claude reads and writes your notes automatically' },
          ].map((step) => (
            <div key={step.label} className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-4 text-center">
              <div className="text-2xl mb-2">{step.icon}</div>
              <div className="text-sm font-medium text-zinc-200 mb-1">{step.label}</div>
              <div className="text-xs text-zinc-500">{step.desc}</div>
            </div>
          ))}
        </div>

        {/* Step 1: Build */}
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-violet-600 text-white text-xs flex items-center justify-center">1</span>
            Build the server
          </h2>
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden">
            <div className="px-3 py-1.5 bg-zinc-800 border-b border-zinc-700 text-xs text-zinc-400">Terminal</div>
            <pre className="px-4 py-3 text-sm text-zinc-300 font-mono overflow-x-auto">
              <code>{`cd ${serverPath || '/path/to/library/server'}
npm run build`}</code>
            </pre>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            Or skip this step and use the <span className="text-zinc-300 font-mono">tsx</span> dev config below.
          </p>
        </div>

        {/* Step 2: Configure Claude Desktop */}
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-violet-600 text-white text-xs flex items-center justify-center">2</span>
            Add to Claude Desktop config
          </h2>
          <p className="text-xs text-zinc-500 mb-2">
            Edit <span className="text-zinc-300 font-mono">~/.claude/claude_desktop_config.json</span>:
          </p>

          <div className="bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden mb-3">
            <div className="px-3 py-1.5 bg-zinc-800 border-b border-zinc-700 text-xs text-zinc-400 flex items-center justify-between">
              <span>Production (compiled)</span>
              <button
                onClick={() => copy(desktopConfig)}
                className="text-violet-400 hover:text-violet-300 text-xs transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="px-4 py-3 text-xs text-zinc-300 font-mono overflow-x-auto">
              <code>{desktopConfig}</code>
            </pre>
          </div>

          <div className="bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden">
            <div className="px-3 py-1.5 bg-zinc-800 border-b border-zinc-700 text-xs text-zinc-400 flex items-center justify-between">
              <span>Development (tsx, no build needed)</span>
              <button
                onClick={() => copy(devConfig)}
                className="text-violet-400 hover:text-violet-300 text-xs transition-colors"
              >
                Copy
              </button>
            </div>
            <pre className="px-4 py-3 text-xs text-zinc-300 font-mono overflow-x-auto">
              <code>{devConfig}</code>
            </pre>
          </div>
        </div>

        {/* Step 3: Restart and chat */}
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-violet-600 text-white text-xs flex items-center justify-center">3</span>
            Restart Claude Desktop and start chatting
          </h2>
          <div className="space-y-2">
            {[
              'I want to remember that React hooks must be called at the top level.',
              'What do I know about React?',
              'Create a note summarizing the key ideas from our conversation.',
              'Search my notes for anything related to TypeScript.',
            ].map((prompt) => (
              <div
                key={prompt}
                className="bg-zinc-800/60 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-zinc-400 font-mono"
              >
                "{prompt}"
              </div>
            ))}
          </div>
        </div>

        {/* Available tools */}
        <div>
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Available MCP tools</h2>
          <div className="grid grid-cols-2 gap-2">
            {[
              { name: 'list_notes', desc: 'List all notes with metadata' },
              { name: 'get_note', desc: 'Read a note by slug' },
              { name: 'create_note', desc: 'Save a new note' },
              { name: 'update_note', desc: 'Update an existing note' },
              { name: 'delete_note', desc: 'Remove a note' },
              { name: 'search_notes', desc: 'Keyword search across notes' },
            ].map((tool) => (
              <div key={tool.name} className="bg-zinc-800/40 border border-zinc-700 rounded-lg px-3 py-2">
                <div className="text-xs font-mono text-violet-400">{tool.name}</div>
                <div className="text-xs text-zinc-500 mt-0.5">{tool.desc}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-600 mt-3">
            Notes are also exposed as <span className="font-mono text-zinc-500">note://slug</span> resources Claude can read directly.
          </p>
        </div>
      </div>
    </div>
  );
}
