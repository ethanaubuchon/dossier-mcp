import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { notesRouter } from './routes/notes.js';
import { searchRouter } from './routes/search.js';
import { chatRouter } from './routes/chat.js';
import { settingsRouter } from './routes/settings.js';
import { NoteStore } from './notes/NoteStore.js';
import { SearchIndex } from './search/SearchIndex.js';
import { loadConfig } from './config/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Load config and initialize services
const config = await loadConfig();
const notesDir = process.env.NOTES_DIR || config.notesDir || path.join(__dirname, '../../notes');

export const noteStore = new NoteStore(notesDir);
export const searchIndex = new SearchIndex();

// Initialize note store (loads notes + starts watcher)
await noteStore.initialize();

// Build initial search index
const allNotes = await noteStore.list();
searchIndex.buildIndex(allNotes);

// Keep search index in sync with note store
noteStore.on('change', (notes) => {
  searchIndex.buildIndex(notes);
});

// Routes
app.use('/api/notes', notesRouter);
app.use('/api/search', searchRouter);
app.use('/api/chat', chatRouter);
app.use('/api/settings', settingsRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Serve static client files in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Notes directory: ${notesDir}`);
});

export default app;
