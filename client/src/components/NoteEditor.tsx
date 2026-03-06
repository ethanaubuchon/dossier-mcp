import { useState, useEffect } from 'react';
import { getNote, createNote, updateNote } from '../api';

interface NoteEditorProps {
  slug: string | null;
  onSaved: (slug: string) => void;
  onCancel: () => void;
}

export function NoteEditor({ slug, onSaved, onCancel }: NoteEditorProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (slug) {
      setLoading(true);
      getNote(slug)
        .then((note) => {
          setTitle(note.frontmatter.title);
          setContent(note.content);
          setTags(note.frontmatter.tags.join(', '));
        })
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    } else {
      setTitle('');
      setContent('');
      setTags('');
    }
  }, [slug]);

  const handleSave = async () => {
    if (!title.trim() || !content.trim()) {
      setError('Title and content are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      let saved;
      if (slug) {
        saved = await updateNote(slug, { title, content, tags: tagList });
      } else {
        saved = await createNote({ title, content, tags: tagList });
      }
      onSaved(saved.slug);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="h-full flex items-center justify-center text-zinc-500">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-8 py-4 border-b border-zinc-800 shrink-0">
        <h2 className="text-lg font-semibold text-zinc-100">{slug ? 'Edit Note' : 'New Note'}</h2>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-white rounded-md transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-4">
        {error && (
          <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm px-4 py-2 rounded-lg">
            {error}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Note title"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-violet-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">Tags (comma-separated)</label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="react, hooks, frontend"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-violet-500"
          />
        </div>

        <div className="flex-1">
          <label className="block text-xs font-medium text-zinc-400 mb-1">Content (Markdown)</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write your note in markdown…"
            className="w-full h-96 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-violet-500 font-mono text-sm resize-none"
          />
        </div>
      </div>
    </div>
  );
}
