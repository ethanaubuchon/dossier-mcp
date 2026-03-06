import { parseNoteBlocks } from '../noteBlockParser.js';

describe('parseNoteBlocks', () => {
  test('returns empty array for text with no note blocks', () => {
    expect(parseNoteBlocks('Hello, this is a normal response.')).toEqual([]);
  });

  test('parses a single note block', () => {
    const text = `
Great idea! Here's a note for you:

<note>
title: "React Hooks Rules"
tags: [react, hooks]
related: []
---
# React Hooks Rules
Call hooks at the top level.
</note>
`;
    const blocks = parseNoteBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe('React Hooks Rules');
    expect(blocks[0].tags).toEqual(['react', 'hooks']);
    expect(blocks[0].related).toEqual([]);
    expect(blocks[0].content).toContain('Call hooks at the top level.');
  });

  test('parses multiple note blocks', () => {
    const text = `
<note>
title: "First Note"
tags: [a]
related: []
---
First content.
</note>

Some text in between.

<note>
title: "Second Note"
tags: [b, c]
related: [first-note]
---
Second content.
</note>
`;
    const blocks = parseNoteBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].title).toBe('First Note');
    expect(blocks[1].title).toBe('Second Note');
    expect(blocks[1].related).toEqual(['first-note']);
  });

  test('returns empty array if separator is missing', () => {
    const text = `<note>
title: "Bad Note"
tags: []
No separator here.
</note>`;
    expect(parseNoteBlocks(text)).toEqual([]);
  });

  test('handles tags with spaces and quotes', () => {
    const text = `<note>
title: "My Note"
tags: [react, "web dev", hooks]
related: []
---
Content here.
</note>`;
    const blocks = parseNoteBlocks(text);
    expect(blocks[0].tags).toContain('react');
    expect(blocks[0].tags).toContain('web dev');
    expect(blocks[0].tags).toContain('hooks');
  });
});
