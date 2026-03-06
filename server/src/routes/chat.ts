import { Router } from 'express';
import type { Request, Response } from 'express';
import { noteStore, searchIndex } from '../index.js';
import { loadConfig } from '../config/config.js';
import Anthropic from '@anthropic-ai/sdk';
import { parseNoteBlocks } from '../notes/noteBlockParser.js';
import type { ChatMessage } from '../types.js';

export const chatRouter = Router();

const SYSTEM_PROMPT = `You are a personal knowledge management assistant. Your job is to help the user capture and organize their thoughts into a structured knowledge base of markdown notes.

When the user shares ideas, thoughts, or information:
1. Respond conversationally to acknowledge and expand on their idea
2. If the content is worth preserving as a note, output a note block in this exact format:

<note>
title: "Note Title"
tags: [tag1, tag2]
related: [existing-slug-if-any]
---
# Note Title
Full markdown content here. Use [[slug]] to link to related notes.
</note>

You can output multiple <note> blocks if needed.

When answering questions, use the provided context notes (labeled [NOTE: slug]) to ground your answers. Cite which notes you used by mentioning their titles.

Keep your conversational responses helpful and concise.`;

chatRouter.post('/', async (req: Request, res: Response) => {
  const { messages } = req.body as { messages: ChatMessage[] };

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  const config = await loadConfig();
  if (!config.apiKey) {
    res.status(400).json({ error: 'API key not configured. Go to Settings to add your Anthropic API key.' });
    return;
  }

  // RAG: find relevant notes based on last user message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  let contextNotes: string[] = [];
  let usedSlugs: string[] = [];

  if (lastUserMessage) {
    const results = searchIndex.search(lastUserMessage.content, 5);
    if (results.length > 0) {
      usedSlugs = results.map((r) => r.slug);
      const noteContents = await Promise.all(
        results.map(async (r) => {
          const note = await noteStore.get(r.slug);
          if (note) {
            return `[NOTE: ${r.slug}]\nTitle: ${note.frontmatter.title}\nTags: ${note.frontmatter.tags.join(', ')}\n\n${note.content}`;
          }
          return null;
        })
      );
      contextNotes = noteContents.filter((n): n is string => n !== null);
    }
  }

  const systemWithContext =
    contextNotes.length > 0
      ? `${SYSTEM_PROMPT}\n\n--- RELEVANT NOTES FROM KNOWLEDGE BASE ---\n\n${contextNotes.join('\n\n---\n\n')}\n\n--- END NOTES ---`
      : SYSTEM_PROMPT;

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send context metadata first
  res.write(`data: ${JSON.stringify({ type: 'context', slugs: usedSlugs })}\n\n`);

  const client = new Anthropic({ apiKey: config.apiKey });

  try {
    const stream = client.messages.stream({
      model: config.model,
      max_tokens: 2048,
      system: systemWithContext,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    let fullText = '';

    stream.on('text', (text) => {
      fullText += text;
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    });

    await stream.finalMessage();

    // Parse and save any note blocks
    const noteBlocks = parseNoteBlocks(fullText);
    const savedNotes = [];
    for (const block of noteBlocks) {
      const saved = await noteStore.upsert(block);
      savedNotes.push(saved.slug);
    }

    res.write(`data: ${JSON.stringify({ type: 'done', savedNotes })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
    res.end();
  }
});
