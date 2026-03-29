# Search Quality Improvement — BM25 + Prefix Matching + Field Boosting

**Issue:** [#3 — Search quality is weak for indirect or title-mismatch queries](https://github.com/ethanaubuchon/library/issues/3)
**Date:** 2026-03-28
**Status:** Approved design, pending implementation

## Problem

The current search uses simple term frequency + a flat +3 title-match bonus. This works for exact keyword matches but fails when query terms don't directly appear in the note — even when the note is clearly the right result. Queries like `"spec computer todo"` and `"ThinkPad X1 Carbon"` returned no relevant results for a note titled "Hardware — ThinkPad X1 Carbon (Arch Laptop)".

## Approach

In-house implementation: replace the scoring algorithm and add prefix matching directly in `SearchIndex.ts`. No new dependencies. The scoring math, tokenization, and prefix logic total ~60-80 lines replacing the current ~40 lines of scoring. The index data structure (per-document term maps) stays the same — an inverted index refactor is unnecessary at current vault scale and can be layered on later if needed.

## Design

### 1. BM25 Scoring

Replace raw TF + title bonus with BM25 scoring.

**Index changes:**
- Each `IndexEntry` stores its total term count (`docLen`) for length normalization
- `SearchIndex` tracks `avgDocLen` (mean document length), `docCount`, and `docFreq` (term → number of documents containing it)
- Term maps remain per-document (no inverted index restructure)

**BM25 formula per (query term, document) pair:**

```
score = IDF × (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × docLen / avgDocLen))
```

Where:
- `tf` = term frequency in the document (weighted by field — see section 3)
- `IDF` = `ln((N - n + 0.5) / (n + 0.5) + 1)` — N is total docs, n is docs containing the term
- `k1 = 1.2`, `b = 0.75` (standard defaults, defined as constants)
- `docLen` = total weighted term count in this document
- `avgDocLen` = mean document length across all notes

A document's total score is the sum of BM25 scores across all query terms.

**What this fixes:** Matches in short notes rank higher than the same word buried in long notes. Repeated terms don't inflate scores endlessly (term saturation).

### 2. Prefix Matching

During search, each query token is checked against indexed terms with a prefix match.

**Behavior:**
- `think` matches `think`, `thinkpad`, `thinking`, etc.
- Prefix matching is one-directional: the query term is treated as a prefix of indexed terms, not the reverse. `thinkpad` in a query won't match indexed term `think`.
- Minimum prefix length of 3 characters. Shorter query terms require exact match only, to avoid noise.
- When a query term prefix-matches multiple indexed terms in the same document, their frequencies are summed as the tf value. E.g., query `comp` matching both `computer` and `components` combines their counts.

**What this fixes:** The core failing scenarios from issue #3. `spec computer todo` now matches notes containing `specification`, `computer`, `todo-list` via prefix. `ThinkPad` matches content containing `thinkpad` as part of longer compounds.

### 3. Field Boosting

Replace the flat +3 title bonus with per-field weight multipliers applied during indexing.

| Field | Weight | Rationale |
|-------|--------|-----------|
| title | 3.0 | Most signal-dense; what the note "is about" |
| tags | 2.0 | Curated metadata, high intent |
| related slugs | 1.5 | Cross-references indicate topical relevance |
| body | 1.0 | Baseline — bulk content, noisier |

**How it works:** During indexing, term frequency is incremented by `1 × field_weight`. BM25 then operates on these weighted frequencies naturally.

**Trade-off:** Simpler than maintaining separate per-field indexes, but field weights can't be tuned at query time. Acceptable for this use case — weights are a property of the vault, not the query.

### 4. API and Behavioral Changes

**External interface:** No changes. `search_notes` keeps the same signature — `query` (string) + `limit` (optional number). `SearchResult` type unchanged.

**Internal changes to `SearchIndex`:**
- New private state: `avgDocLen`, `docCount`, `docFreq` map (term → document count) — computed during index build
- `IndexEntry` gains a `docLen` field
- `buildIndex` and `buildIndexWithContent` signatures unchanged

**Excerpt generation:** Unchanged.

**Score magnitude:** BM25 produces smaller numbers than raw TF + bonus. Scores are only used for relative ranking, never displayed or compared across queries.

### 5. Testing Strategy

**Existing tests to update:**
- Title match scoring — assertion logic stays the same (title > tag) but expected values change
- Multi-term query — more terms still score higher, values differ

**New tests:**
- Prefix matching — query `think` matches note containing `thinkpad`; `comp` matches `computer` and `components`
- Minimum prefix length — 2-character query terms don't prefix-match (exact only)
- BM25 document length normalization — same term in a short note scores higher than in a long note
- BM25 term saturation — term appearing 10× doesn't score 10× higher than 1×
- Field boosting — title match > tag match > related match > body match for the same term
- Issue #3 regression — note titled "Hardware — ThinkPad X1 Carbon (Arch Laptop)" found by `ThinkPad` and `spec computer todo`

**Integration tests:** Existing `mcpTools.test.ts` search tests assert on result presence, not scores — should pass without modification.

## Scope

**In scope:** BM25 scoring, prefix matching, field boosting — all within `SearchIndex.ts` and its tests.

**Out of scope:** Fuzzy/typo tolerance (not needed for agent-authored vault), inverted index restructure (unnecessary at current scale, documented as future consideration in vault note `library/architecture/search-inverted-index-future`), boolean operators, phrase search.
