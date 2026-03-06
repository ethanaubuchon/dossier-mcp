import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadConfig, saveConfig } from '../config/config.js';

export const settingsRouter = Router();

// GET /api/settings
settingsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const config = await loadConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/settings
settingsRouter.put('/', async (req: Request, res: Response) => {
  try {
    const updated = await saveConfig(req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
