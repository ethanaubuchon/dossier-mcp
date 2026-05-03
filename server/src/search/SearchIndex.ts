import type { NoteListItem, SearchResult } from '../types.js';

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const FIELD_WEIGHTS = {
  title: 3.0,
  tags: 2.0,
  related: 1.5,
  body: 1.0,
} as const;

interface IndexEntry {
  slug: string;
  frontmatter: NoteListItem['frontmatter'];
  terms: Map<string, number>; // term -> weighted frequency
  docLen: number; // total weighted term count
  text: string; // for excerpts
}

export class SearchIndex {
  private entries: IndexEntry[] = [];
  private avgDocLen = 0;
  private docCount = 0;
  private docFreq = new Map<string, number>(); // term -> number of docs containing it

  buildIndex(notes: NoteListItem[]): void {
    this.entries = notes.map((note) => {
      const terms = new Map<string, number>();
      let docLen = 0;

      docLen += this.addWeightedTerms(terms, note.frontmatter.title, FIELD_WEIGHTS.title);
      docLen += this.addWeightedTerms(terms, note.frontmatter.tags.join(' '), FIELD_WEIGHTS.tags);
      docLen += this.addWeightedTerms(terms, note.frontmatter.related.join(' '), FIELD_WEIGHTS.related);

      const text = [
        note.frontmatter.title,
        ...note.frontmatter.tags,
        ...note.frontmatter.related,
      ].join(' ');

      return { slug: note.slug, frontmatter: note.frontmatter, terms, docLen, text };
    });
    this.computeCorpusStats();
  }

  buildIndexWithContent(notes: Array<NoteListItem & { content: string }>): void {
    this.entries = notes.map((note) => {
      const terms = new Map<string, number>();
      let docLen = 0;

      docLen += this.addWeightedTerms(terms, note.frontmatter.title, FIELD_WEIGHTS.title);
      docLen += this.addWeightedTerms(terms, note.frontmatter.tags.join(' '), FIELD_WEIGHTS.tags);
      docLen += this.addWeightedTerms(terms, note.frontmatter.related.join(' '), FIELD_WEIGHTS.related);
      docLen += this.addWeightedTerms(terms, note.content, FIELD_WEIGHTS.body);

      const text = [
        note.frontmatter.title,
        ...note.frontmatter.tags,
        ...note.frontmatter.related,
        note.content,
      ].join(' ');

      return { slug: note.slug, frontmatter: note.frontmatter, terms, docLen, text };
    });
    this.computeCorpusStats();
  }

  search(query: string, limit = 10): SearchResult[] {
    const queryTerms = this.tokenizeQuery(query);
    if (queryTerms.length === 0) return [];

    const results: SearchResult[] = [];
    const safeAvgDocLen = this.avgDocLen > 0 ? this.avgDocLen : 1;

    // Precompute IDF per query term to avoid redundant O(entries) scans
    const idfMap = new Map<string, number>();
    for (const term of queryTerms) {
      const n = this.getDocFrequency(term);
      idfMap.set(term, Math.log((this.docCount - n + 0.5) / (n + 0.5) + 1));
    }

    for (const entry of this.entries) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = this.getTermFrequency(entry, term);
        if (tf === 0) continue;

        const idf = idfMap.get(term)!;
        const tfNorm =
          (tf * (BM25_K1 + 1)) /
          (tf + BM25_K1 * (1 - BM25_B + BM25_B * (entry.docLen / safeAvgDocLen)));
        score += idf * tfNorm;
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

  private getTermFrequency(entry: IndexEntry, queryTerm: string): number {
    const exact = entry.terms.get(queryTerm) || 0;
    if (queryTerm.length < 3) return exact;

    let prefixSum = 0;
    for (const [indexedTerm, freq] of entry.terms) {
      if (indexedTerm !== queryTerm && indexedTerm.startsWith(queryTerm)) {
        prefixSum += freq;
      }
    }
    return exact + prefixSum;
  }

  private getDocFrequency(queryTerm: string): number {
    if (queryTerm.length < 3) return this.docFreq.get(queryTerm) || 0;

    let count = 0;
    for (const entry of this.entries) {
      if (this.getTermFrequency(entry, queryTerm) > 0) count++;
    }
    return count;
  }

  private addWeightedTerms(terms: Map<string, number>, text: string, weight: number): number {
    const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    for (const word of words) {
      terms.set(word, (terms.get(word) || 0) + weight);
    }
    return words.length * weight;
  }

  private computeCorpusStats(): void {
    this.docCount = this.entries.length;
    this.docFreq.clear();

    let totalLen = 0;
    for (const entry of this.entries) {
      totalLen += entry.docLen;
      for (const term of entry.terms.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
      }
    }
    this.avgDocLen = this.docCount > 0 ? totalLen / this.docCount : 0;
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
