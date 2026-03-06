import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat } from '../api';
import type { ChatMessage } from '../types';

interface ChatPanelProps {
  onSelectNote: (slug: string) => void;
  onNoteCreated: () => void;
}

interface UIMessage {
  role: 'user' | 'assistant';
  content: string;
  contextSlugs?: string[];
  savedNotes?: string[];
  streaming?: boolean;
}

export function ChatPanel({ onSelectNote, onNoteCreated }: ChatPanelProps) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setError(null);

    const userMsg: UIMessage = { role: 'user', content: text };
    const assistantMsg: UIMessage = { role: 'assistant', content: '', streaming: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setLoading(true);

    const history: ChatMessage[] = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ];

    try {
      for await (const event of streamChat(history)) {
        if (event.type === 'context') {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, contextSlugs: event.slugs };
            }
            return updated;
          });
        } else if (event.type === 'text') {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, content: last.content + (event.text || '') };
            }
            return updated;
          });
        } else if (event.type === 'done') {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, streaming: false, savedNotes: event.savedNotes };
            }
            return updated;
          });
          if (event.savedNotes && event.savedNotes.length > 0) {
            onNoteCreated();
          }
        } else if (event.type === 'error') {
          setError(event.error || 'Unknown error');
          setMessages((prev) => prev.slice(0, -1)); // remove empty assistant msg
        }
      }
    } catch (e) {
      setError(String(e));
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === 'assistant' && last.content === '') {
          return updated.slice(0, -1);
        }
        return updated.map((m, i) =>
          i === updated.length - 1 && m.role === 'assistant' ? { ...m, streaming: false } : m
        );
      });
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, onNoteCreated]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-4xl mb-4">📚</div>
            <h2 className="text-xl font-semibold text-zinc-300 mb-2">Welcome to Library</h2>
            <p className="text-zinc-500 max-w-md">
              Share your thoughts, ideas, and knowledge. The AI will help you capture and organize
              them into a structured knowledge base.
            </p>
            <div className="mt-6 grid grid-cols-1 gap-2 text-sm">
              {[
                'Tell me about a concept I want to remember',
                'What do I know about React hooks?',
                'Help me organize my notes on machine learning',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors text-left"
                >
                  "{suggestion}"
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-3xl ${msg.role === 'user' ? 'ml-16' : 'mr-16'}`}>
              {msg.contextSlugs && msg.contextSlugs.length > 0 && (
                <div className="mb-2 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-zinc-500">Sources:</span>
                  {msg.contextSlugs.map((slug) => (
                    <button
                      key={slug}
                      onClick={() => onSelectNote(slug)}
                      className="text-xs text-violet-400 hover:text-violet-300 hover:underline"
                    >
                      {slug}
                    </button>
                  ))}
                </div>
              )}

              <div
                className={`rounded-2xl px-4 py-3 ${
                  msg.role === 'user'
                    ? 'bg-violet-600 text-white rounded-br-md'
                    : 'bg-zinc-800 text-zinc-100 rounded-bl-md'
                }`}
              >
                {msg.role === 'assistant' ? (
                  <div className="prose-custom text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content || (msg.streaming ? '▋' : '')}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                )}
              </div>

              {msg.savedNotes && msg.savedNotes.length > 0 && (
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-zinc-500">Saved notes:</span>
                  {msg.savedNotes.map((slug) => (
                    <button
                      key={slug}
                      onClick={() => onSelectNote(slug)}
                      className="text-xs bg-emerald-900/40 text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded-full hover:underline"
                    >
                      {slug}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {error && (
          <div className="flex justify-center">
            <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm px-4 py-2 rounded-lg">
              {error}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 p-4">
        <div className="flex gap-3 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Share a thought, ask a question… (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-violet-500 resize-none min-h-[44px] max-h-32 overflow-y-auto"
            style={{ height: 'auto' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 128) + 'px';
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || loading}
            className="px-4 py-3 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-xl transition-colors shrink-0"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
