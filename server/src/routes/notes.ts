import { Router } from 'express';
import { noteStore } from '../index.js';
import type { Request, Response } from 'express';

export const notesRouter = Router();

// GET /api/notes - list all notes
notesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const notes = await noteStore.list();
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/notes/:slug - get single note
notesRouter.get('/:slug', async (req: Request, res: Response) => {
  try {
    const note = await noteStore.get(req.params.slug);
    if (!note) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/notes - create/upsert note
notesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { title, content, tags, related, slug } = req.body;
    if (!title || !content) {
      res.status(400).json({ error: 'title and content are required' });
      return;
    }
    const note = await noteStore.upsert({ title, content, tags, related, slug });
    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/notes/:slug - delete note
notesRouter.delete('/:slug', async (req: Request, res: Response) => {
  try {
    const deleted = await noteStore.delete(req.params.slug);
    if (!deleted) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
