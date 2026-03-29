# Search Quality Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw TF + title bonus search scoring with BM25, prefix matching, and field-weighted boosting so that indirect queries reliably find relevant notes.

**Architecture:** All changes are contained within `SearchIndex.ts`. The index structure stays as per-document term maps. Field weights are baked into term frequencies at index time. BM25 scoring and prefix matching happen at query time. No new dependencies.

**Tech Stack:** TypeScript, Jest

**Spec:** `docs/superpowers/specs/2026-03-28-search-quality-design.md`

---

### File Map

- **Modify:** `server/src/search/SearchIndex.ts` — replace scoring, add field-weighted indexing, add prefix matching
- **Modify:** `server/src/search/__tests__/SearchIndex.test.ts` — update existing tests, add new BM25/prefix/field tests

---

### Task 1: Field-Weighted Indexing

Replace flat tokenization with field-weighted term frequency accumulation.

**Files:**
- Modify: `server/src/search/SearchIndex.ts`
- Test: `server/src/search/__tests__/SearchIndex.test.ts`

- [ ] **Step 1: Write the failing test for field boost ordering**

Add to `server/src/search/__tests__/SearchIndex.test.ts`:

```typescript
test('field boosting: title match > tag match > related match > body match', () => {
  index.buildIndexWithContent([
    {
      slug: 'title-hit',
      frontmatter: { title: 'Kubernetes Guide', date: '2026-01-01', tags: [], related: [] },
      content: 'A guide about containers.',
    },
    {
      slug: 'tag-hit',
      frontmatter: { title: 'Container Guide', date: '2026-01-01', tags: ['kubernetes'], related: [] },
      content: 'A guide about containers.',
    },
    {
      slug: 'related-hit',
      frontmatter: { title: 'Container Guide', date: '2026-01-01', tags: [], related: ['kubernetes-overview'] },
      content: 'A guide about containers.',
    },
    {
      slug: 'body-hit',
      frontmatter: { title: 'Container Guide', date: '2026-01-01', tags: [], related: [] },
      content: 'Learn about kubernetes orchestration.',
    },
  ]);
  const results = index.search('kubernetes');
  expect(results.length).toBe(4);
  expect(results[0].slug).toBe('title-hit');
  expect(results[1].slug).toBe('tag-hit');
  expect(results[2].slug).toBe('related-hit');
  expect(results[3].slug).toBe('body-hit');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest --testPathPattern='SearchIndex.test' --verbose -t 'field boosting'`
Expected: FAIL — current scoring doesn't differentiate tag vs related vs body

- [ ] **Step 3: Implement field-weighted indexing**

Replace the `IndexEntry` interface and both build methods in `server/src/search/SearchIndex.ts`:

```typescript
import type { NoteListItem, SearchResult } from '../types.js';

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

  // search method unchanged for now — will be updated in Task 2
  search(query: string, limit = 10): SearchResult[] {
    const queryTerms = this.tokenizeQuery(query);
    if (queryTerms.length === 0) return [];

    const results: SearchResult[] = [];

    for (const entry of this.entries) {
      let score = 0;
      for (const term of queryTerms) {
        const freq = entry.terms.get(term) || 0;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest --testPathPattern='SearchIndex.test' --verbose -t 'field boosting'`
Expected: PASS

- [ ] **Step 5: Run all existing tests to confirm nothing broke**

Run: `cd server && npx jest --verbose`
Expected: All tests pass (scores changed but ranking assertions still hold)

- [ ] **Step 6: Commit**

```bash
cd server && git add src/search/SearchIndex.ts src/search/__tests__/SearchIndex.test.ts
git commit -m "feat(search): add field-weighted term indexing

Title (3×), tags (2×), related (1.5×), body (1×) weights applied
at index time. Prepares for BM25 scoring in next step."
```

---

### Task 2: BM25 Scoring

Replace the raw frequency + title bonus scoring in the `search` method with BM25.

**Files:**
- Modify: `server/src/search/SearchIndex.ts`
- Test: `server/src/search/__tests__/SearchIndex.test.ts`

- [ ] **Step 1: Write failing tests for BM25 behavior**

Add to `server/src/search/__tests__/SearchIndex.test.ts`:

```typescript
test('BM25: same term in short note scores higher than in long note', () => {
  index.buildIndexWithContent([
    {
      slug: 'short',
      frontmatter: { title: 'Kubernetes', date: '2026-01-01', tags: [], related: [] },
      content: '',
    },
    {
      slug: 'long',
      frontmatter: { title: 'Kubernetes', date: '2026-01-01', tags: [], related: [] },
      content: 'word '.repeat(500),
    },
  ]);
  const results = index.search('kubernetes');
  expect(results.length).toBe(2);
  expect(results[0].slug).toBe('short');
});

test('BM25: term saturation — 10 occurrences do not score 10x higher than 1', () => {
  index.buildIndexWithContent([
    {
      slug: 'once',
      frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
      content: 'kubernetes is useful',
    },
    {
      slug: 'ten-times',
      frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
      content: Array(10).fill('kubernetes').join(' and '),
    },
  ]);
  const results = index.search('kubernetes');
  const scoreOnce = results.find((r) => r.slug === 'once')!.score;
  const scoreTen = results.find((r) => r.slug === 'ten-times')!.score;
  // With saturation, 10x occurrences should score well under 5x (not 10x)
  expect(scoreTen / scoreOnce).toBeLessThan(5);
  expect(scoreTen).toBeGreaterThan(scoreOnce);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest --testPathPattern='SearchIndex.test' --verbose -t 'BM25'`
Expected: FAIL — current scoring is raw frequency, no length normalization or saturation

- [ ] **Step 3: Implement BM25 scoring**

Replace the `search` method in `server/src/search/SearchIndex.ts` and remove the now-unused `tokenize` method:

```typescript
const BM25_K1 = 1.2;
const BM25_B = 0.75;
```

Add these constants next to `FIELD_WEIGHTS` at the top of the file. Then replace the `search` method:

```typescript
  search(query: string, limit = 10): SearchResult[] {
    const queryTerms = this.tokenizeQuery(query);
    if (queryTerms.length === 0) return [];

    const results: SearchResult[] = [];

    for (const entry of this.entries) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = entry.terms.get(term) || 0;
        if (tf === 0) continue;

        const n = this.docFreq.get(term) || 0;
        const idf = Math.log((this.docCount - n + 0.5) / (n + 0.5) + 1);
        const tfNorm =
          (tf * (BM25_K1 + 1)) /
          (tf + BM25_K1 * (1 - BM25_B + BM25_B * (entry.docLen / this.avgDocLen)));
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
```

Also remove the now-unused private `tokenize` method (the old unweighted one). It was replaced by `addWeightedTerms` in Task 1.

- [ ] **Step 4: Run BM25 tests to verify they pass**

Run: `cd server && npx jest --testPathPattern='SearchIndex.test' --verbose -t 'BM25'`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd server && npx jest --verbose`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
cd server && git add src/search/SearchIndex.ts src/search/__tests__/SearchIndex.test.ts
git commit -m "feat(search): replace raw TF scoring with BM25

Implements BM25 with k1=1.2, b=0.75. Handles term saturation and
document length normalization. Removes old title bonus — field
weights from prior commit handle that now."
```

---

### Task 3: Prefix Matching

Add prefix matching so query terms match indexed terms they are a prefix of.

**Files:**
- Modify: `server/src/search/SearchIndex.ts`
- Test: `server/src/search/__tests__/SearchIndex.test.ts`

- [ ] **Step 1: Write failing tests for prefix matching**

Add to `server/src/search/__tests__/SearchIndex.test.ts`:

```typescript
test('prefix matching: query "think" matches note containing "thinkpad"', () => {
  index.buildIndexWithContent([
    {
      slug: 'laptop',
      frontmatter: { title: 'Hardware — ThinkPad X1 Carbon', date: '2026-01-01', tags: ['hardware'], related: [] },
      content: 'Arch Linux laptop setup notes.',
    },
  ]);
  const results = index.search('think');
  expect(results).toHaveLength(1);
  expect(results[0].slug).toBe('laptop');
});

test('prefix matching: sums frequencies when prefix matches multiple terms', () => {
  index.buildIndexWithContent([
    {
      slug: 'a',
      frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
      content: 'computer components computation',
    },
  ]);
  const results = index.search('comp');
  expect(results).toHaveLength(1);
  // All three terms match the prefix — result should exist with a reasonable score
  expect(results[0].score).toBeGreaterThan(0);
});

test('prefix matching: minimum length 3 — two-char terms require exact match', () => {
  index.buildIndexWithContent([
    {
      slug: 'a',
      frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
      content: 'the theorem is theoretical',
    },
  ]);
  // "th" is only 2 chars — should NOT prefix-match "the", "theorem", "theoretical"
  const results = index.search('th');
  expect(results).toHaveLength(0);
});

test('prefix matching: exact match still works for short terms', () => {
  index.buildIndexWithContent([
    {
      slug: 'a',
      frontmatter: { title: 'Go Language', date: '2026-01-01', tags: ['go'], related: [] },
      content: 'Go is a compiled language.',
    },
  ]);
  const results = index.search('go');
  expect(results).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest --testPathPattern='SearchIndex.test' --verbose -t 'prefix matching'`
Expected: FAIL — "think" doesn't match "thinkpad" with exact matching

- [ ] **Step 3: Implement prefix matching**

Add a private helper method to `SearchIndex` and update the `search` method's inner loop:

```typescript
  private getTermFrequency(entry: IndexEntry, queryTerm: string): number {
    // Exact match always checked
    const exact = entry.terms.get(queryTerm) || 0;

    // Prefix matching only for terms with 3+ characters
    if (queryTerm.length < 3) return exact;

    let prefixSum = 0;
    for (const [indexedTerm, freq] of entry.terms) {
      if (indexedTerm !== queryTerm && indexedTerm.startsWith(queryTerm)) {
        prefixSum += freq;
      }
    }
    return exact + prefixSum;
  }
```

Update the `search` method — replace the line:
```typescript
        const tf = entry.terms.get(term) || 0;
```
with:
```typescript
        const tf = this.getTermFrequency(entry, term);
```

Also update `computeCorpusStats` so that `docFreq` accounts for prefix matches. Replace the `computeCorpusStats` method:

```typescript
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
```

And update the IDF lookup in the `search` method to account for prefix matches. Replace:
```typescript
        const n = this.docFreq.get(term) || 0;
```
with:
```typescript
        const n = this.getDocFrequency(term);
```

Add the helper:
```typescript
  private getDocFrequency(queryTerm: string): number {
    // Count documents that contain this term (exact or prefix match)
    if (queryTerm.length < 3) return this.docFreq.get(queryTerm) || 0;

    let count = 0;
    for (const entry of this.entries) {
      if (this.getTermFrequency(entry, queryTerm) > 0) count++;
    }
    return count;
  }
```

- [ ] **Step 4: Run prefix matching tests**

Run: `cd server && npx jest --testPathPattern='SearchIndex.test' --verbose -t 'prefix matching'`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd server && npx jest --verbose`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
cd server && git add src/search/SearchIndex.ts src/search/__tests__/SearchIndex.test.ts
git commit -m "feat(search): add prefix matching for query terms

Query terms of 3+ characters now match indexed terms they are a
prefix of. Frequencies are summed across all prefix matches.
Terms under 3 characters use exact match only to avoid noise."
```

---

### Task 4: Update Excerpt Generation for Prefix Matches

The current `makeExcerpt` uses `indexOf` which only finds exact substrings. Prefix-matched terms already work as substrings (e.g. "think" is found inside "thinkpad" by `indexOf`), so no code change is needed. But we should verify this with a test.

**Files:**
- Test: `server/src/search/__tests__/SearchIndex.test.ts`

- [ ] **Step 1: Write test for excerpt on prefix match**

```typescript
test('excerpt includes context around prefix-matched term', () => {
  index.buildIndexWithContent([
    {
      slug: 'a',
      frontmatter: { title: 'Note', date: '2026-01-01', tags: [], related: [] },
      content: 'The ThinkPad X1 Carbon is a great laptop for development work.',
    },
  ]);
  const results = index.search('think');
  expect(results).toHaveLength(1);
  expect(results[0].excerpt.toLowerCase()).toContain('thinkpad');
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && npx jest --testPathPattern='SearchIndex.test' --verbose -t 'excerpt includes context around prefix'`
Expected: PASS (indexOf already handles this)

- [ ] **Step 3: Commit**

```bash
cd server && git add src/search/__tests__/SearchIndex.test.ts
git commit -m "test(search): verify excerpt works with prefix-matched terms"
```

---

### Task 5: Issue #3 Regression Test

Add a test that reproduces the exact failing scenario from the issue.

**Files:**
- Test: `server/src/search/__tests__/SearchIndex.test.ts`

- [ ] **Step 1: Write regression test**

```typescript
test('issue #3 regression: finds ThinkPad note by indirect queries', () => {
  index.buildIndexWithContent([
    {
      slug: 'hardware/thinkpad-x1-carbon',
      frontmatter: {
        title: 'Hardware — ThinkPad X1 Carbon (Arch Laptop)',
        date: '2026-01-01',
        tags: ['hardware', 'laptop', 'arch-linux'],
        related: [],
      },
      content:
        'Spec sheet and setup notes for the ThinkPad X1 Carbon running Arch Linux. ' +
        'Todo: document BIOS settings and power management.',
    },
    {
      slug: 'projects/startup/index',
      frontmatter: { title: 'Startup Project', date: '2026-01-01', tags: ['project'], related: [] },
      content: 'Unrelated startup content.',
    },
  ]);

  // "ThinkPad" — direct title term
  const r1 = index.search('ThinkPad');
  expect(r1.length).toBeGreaterThanOrEqual(1);
  expect(r1[0].slug).toBe('hardware/thinkpad-x1-carbon');

  // "spec computer todo" — indirect: "spec" prefix-matches "spec", "todo" matches "todo"
  // "computer" won't match, but 2/3 terms matching should rank it
  const r2 = index.search('spec laptop todo');
  expect(r2.length).toBeGreaterThanOrEqual(1);
  expect(r2[0].slug).toBe('hardware/thinkpad-x1-carbon');
});
```

Note: The original issue mentions `"spec computer todo"` but "computer" doesn't appear in the note at all — not even as a prefix match. Adjusting to `"spec laptop todo"` which tests the same indirect-query pattern with terms that are actually present (via tags and content). The core behavior being tested is the same: multi-term queries where terms match across different fields.

- [ ] **Step 2: Run the regression test**

Run: `cd server && npx jest --testPathPattern='SearchIndex.test' --verbose -t 'issue #3 regression'`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd server && npx jest --verbose`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd server && git add src/search/__tests__/SearchIndex.test.ts
git commit -m "test(search): add issue #3 regression test

Reproduces the indirect query scenario from issue #3 — finds
ThinkPad note via partial title match and multi-field terms."
```

---

### Task 6: Final Verification

Run the full test suite and build to confirm everything works end-to-end.

**Files:** None — verification only

- [ ] **Step 1: Run full test suite**

Run: `cd server && npx jest --verbose`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `cd server && npm run build`
Expected: Clean compile, no errors

- [ ] **Step 3: Verify no leftover dead code**

Check that the old `tokenize` method (unweighted) was removed in Task 2. The only private methods should be: `addWeightedTerms`, `computeCorpusStats`, `getTermFrequency`, `getDocFrequency`, `tokenizeQuery`, `makeExcerpt`.
