import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getNote } from '../api';
import type { Note } from '../types';

interface NoteReaderProps {
  slug: string;
  onEdit: (slug: string) => void;
  onSelectNote: (slug: string) => void;
}

export function NoteReader({ slug, onEdit, onSelectNote }: NoteReaderProps) {
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getNote(slug)
      .then(setNote)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-500">
        Loading…
      </div>
    );
  }

  if (error || !note) {
    return (
      <div className="h-full flex items-center justify-center text-red-400">
        {error || 'Note not found'}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Note header */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-zinc-800 shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">{note.frontmatter.title}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-zinc-500">{note.frontmatter.date}</span>
            <div className="flex gap-1">
              {note.frontmatter.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-violet-900/40 text-violet-400 px-2 py-0.5 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
        <button
          onClick={() => onEdit(slug)}
          className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors"
        >
          Edit
        </button>
      </div>

      {/* Related notes */}
      {note.frontmatter.related.length > 0 && (
        <div className="px-8 py-2 border-b border-zinc-800 flex items-center gap-2 shrink-0">
          <span className="text-xs text-zinc-500">Related:</span>
          {note.frontmatter.related.map((rel) => (
            <button
              key={rel}
              onClick={() => onSelectNote(rel)}
              className="text-xs text-violet-400 hover:text-violet-300 hover:underline"
            >
              {rel}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="prose-custom">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                // Handle [[wikilink]] style links
                if (href?.startsWith('[[') && href.endsWith(']]')) {
                  const target = href.slice(2, -2);
                  return (
                    <button
                      onClick={() => onSelectNote(target)}
                      className="text-violet-400 hover:text-violet-300 hover:underline cursor-pointer bg-transparent border-none p-0"
                    >
                      {children}
                    </button>
                  );
                }
                return (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                );
              },
            }}
          >
            {transformWikilinks(note.content)}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

/**
 * Transforms [[slug]] wikilinks into markdown links that our custom renderer handles.
 */
function transformWikilinks(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_, slug) => `[${slug}]([[${slug}]])`);
}
