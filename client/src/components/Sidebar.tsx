import { useEffect, useState, useCallback } from 'react';
import { listNotes, searchNotes } from '../api';
import type { NoteListItem, SearchResult } from '../types';

interface SidebarProps {
  activeSlug: string | null;
  activeTag: string | null;
  onSelectNote: (note: NoteListItem) => void;
  onNewNote: () => void;
  onSettings: () => void;
  onTagSelect: (tag: string | null) => void;
  refreshTrigger: number;
  onViewChat: () => void;
  currentView: string;
}

export function Sidebar({
  activeSlug,
  activeTag,
  onSelectNote,
  onNewNote,
  onSettings,
  onTagSelect,
  refreshTrigger,
  onViewChat,
  currentView,
}: SidebarProps) {
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);

  const load = useCallback(async () => {
    const all = await listNotes();
    setNotes(all);
    const tags = [...new Set(all.flatMap((n) => n.frontmatter.tags))].sort();
    setAllTags(tags);
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  useEffect(() => {
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      const results = await searchNotes(search);
      setSearchResults(results);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const displayNotes: NoteListItem[] = searchResults
    ? searchResults.map((r) => ({ slug: r.slug, frontmatter: r.frontmatter }))
    : activeTag
    ? notes.filter((n) => n.frontmatter.tags.includes(activeTag))
    : notes;

  return (
    <aside className="flex flex-col w-64 border-r border-zinc-800 bg-zinc-900 shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={onViewChat}
            className="flex items-center gap-2 text-violet-400 hover:text-violet-300 font-semibold text-sm"
          >
            <BookIcon />
            Library
          </button>
          <div className="flex gap-1">
            <button
              onClick={onNewNote}
              title="New note"
              className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded"
            >
              <PlusIcon />
            </button>
            <button
              onClick={onSettings}
              title="Settings"
              className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded"
            >
              <GearIcon />
            </button>
          </div>
        </div>
        <input
          type="search"
          placeholder="Search notes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-violet-500"
        />
      </div>

      {/* Chat button */}
      <button
        onClick={onViewChat}
        className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b border-zinc-800 transition-colors ${
          currentView === 'chat'
            ? 'bg-violet-900/40 text-violet-300'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
        }`}
      >
        <ChatIcon />
        Chat with AI
      </button>

      {/* Tag filter */}
      {allTags.length > 0 && !search && (
        <div className="px-3 py-2 border-b border-zinc-800">
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => onTagSelect(null)}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                activeTag === null
                  ? 'bg-violet-600 border-violet-600 text-white'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300'
              }`}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => onTagSelect(activeTag === tag ? null : tag)}
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                  activeTag === tag
                    ? 'bg-violet-600 border-violet-600 text-white'
                    : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Note list */}
      <div className="flex-1 overflow-y-auto">
        {displayNotes.length === 0 ? (
          <div className="p-4 text-zinc-500 text-sm text-center">
            {search ? 'No results' : 'No notes yet'}
          </div>
        ) : (
          <ul>
            {displayNotes.map((note) => (
              <li key={note.slug}>
                <button
                  onClick={() => onSelectNote(note)}
                  className={`w-full text-left px-4 py-2.5 border-b border-zinc-800/50 transition-colors ${
                    activeSlug === note.slug
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-300 hover:bg-zinc-800/50 hover:text-zinc-100'
                  }`}
                >
                  <div className="text-sm font-medium truncate">{note.frontmatter.title}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">{note.frontmatter.date}</div>
                  {note.frontmatter.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {note.frontmatter.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="text-xs bg-zinc-700/60 text-zinc-400 px-1.5 py-0.5 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
