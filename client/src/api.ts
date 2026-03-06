import type { Note, NoteListItem, SearchResult, Config } from './types';

const BASE = '/api';

export async function listNotes(): Promise<NoteListItem[]> {
  const res = await fetch(`${BASE}/notes`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getNote(slug: string): Promise<Note> {
  const res = await fetch(`${BASE}/notes/${slug}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createNote(data: {
  title: string;
  content: string;
  tags?: string[];
  related?: string[];
  slug?: string;
}): Promise<Note> {
  const res = await fetch(`${BASE}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateNote(slug: string, data: {
  title: string;
  content: string;
  tags?: string[];
  related?: string[];
}): Promise<Note> {
  const res = await fetch(`${BASE}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, slug }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteNote(slug: string): Promise<void> {
  const res = await fetch(`${BASE}/notes/${slug}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

export async function searchNotes(q: string): Promise<SearchResult[]> {
  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getSettings(): Promise<Config> {
  const res = await fetch(`${BASE}/settings`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveSettings(config: Partial<Config>): Promise<Config> {
  const res = await fetch(`${BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
