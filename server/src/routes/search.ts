import { Router } from 'express';
import { searchIndex } from '../index.js';
import type { Request, Response } from 'express';

export const searchRouter = Router();

// GET /api/search?q=...
searchRouter.get('/', (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.json([]);
    return;
  }
  const results = searchIndex.search(q);
  res.json(results);
});
