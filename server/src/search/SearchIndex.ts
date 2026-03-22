import type { NoteListItem, SearchResult } from '../types.js';

interface IndexEntry {
  slug: string;
  frontmatter: NoteListItem['frontmatter'];
  terms: Map<string, number>; // term -> frequency
  text: string; // for excerpts
}

export class SearchIndex {
  private entries: IndexEntry[] = [];

  buildIndex(notes: NoteListItem[]): void {
    this.entries = notes.map((note) => {
      const text = [
        note.frontmatter.title,
        ...note.frontmatter.tags,
        ...note.frontmatter.related,
      ].join(' ');
      return {
        slug: note.slug,
        frontmatter: note.frontmatter,
        terms: this.tokenize(text),
        text,
      };
    });
  }

  buildIndexWithContent(notes: Array<NoteListItem & { content: string }>): void {
    this.entries = notes.map((note) => {
      const text = [
        note.frontmatter.title,
        ...note.frontmatter.tags,
        ...note.frontmatter.related,
        note.content,
      ].join(' ');
      return {
        slug: note.slug,
        frontmatter: note.frontmatter,
        terms: this.tokenize(text),
        text,
      };
    });
  }

  search(query: string, limit = 10): SearchResult[] {
    const queryTerms = this.tokenizeQuery(query);
    if (queryTerms.length === 0) return [];

    const results: SearchResult[] = [];

    for (const entry of this.entries) {
      let score = 0;
      for (const term of queryTerms) {
        const freq = entry.terms.get(term) || 0;
        // Title matches score higher
        const titleMatch = entry.frontmatter.title.toLowerCase().includes(term) ? 3 : 0;
        score += freq + titleMatch;
      }
      if (score > 0) {
        results.push({
          slug: entry.slug,
          frontmatter: entry.frontmatter,
          score,
          excerpt: this.makeExcerpt(entry.text, queryTerms),
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private tokenize(text: string): Map<string, number> {
    const terms = new Map<string, number>();
    const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    for (const word of words) {
      terms.set(word, (terms.get(word) || 0) + 1);
    }
    return terms;
  }

  private tokenizeQuery(query: string): string[] {
    return query
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 1);
  }

  private makeExcerpt(text: string, terms: string[]): string {
    const lower = text.toLowerCase();
    for (const term of terms) {
      const idx = lower.indexOf(term);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + 80);
        return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
      }
    }
    return text.slice(0, 120);
  }
}
