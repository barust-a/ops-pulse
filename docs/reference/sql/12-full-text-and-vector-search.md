# Full-Text Search and Vector Search in PostgreSQL

> Part of the [SQL & PostgreSQL reference library](README.md) · Last researched: 2026-10-05 · Targets PostgreSQL 14–18 (19 beta noted where relevant)

**What this covers.** How to search text inside PostgreSQL: built-in full-text search (`tsvector`/`tsquery`), BM25 ranking extensions, fuzzy matching with `pg_trgm`, semantic (vector) search with `pgvector`, and hybrid search that combines them. It ends with a schema for retrieval-augmented generation (RAG), performance tuning, and when a dedicated search engine is the better choice.

Related: [indexing](05-indexing.md) · [query optimization and EXPLAIN](06-query-optimization-and-explain.md) · [security and RLS](11-security.md) · [PostgreSQL features and types](03-postgresql-features-and-types.md) · [tools by use case](13-tools-by-use-case.md) · [Postgres from TypeScript](15-postgres-from-typescript.md).

## Key rules (TL;DR)

1. Pick the tool by the question: words and phrases → full-text search; typos and substrings → `pg_trgm`; meaning → vectors; real products → hybrid (keywords + vectors).
2. Always pass the text search configuration explicitly (`to_tsvector('english', …)`), never rely on `default_text_search_config`.
3. Store the `tsvector` in a `GENERATED ALWAYS AS (…) STORED` column with a GIN index. Write `STORED` explicitly: generated columns are virtual by default (PG 18+), and virtual columns cannot be indexed.
4. Parse user input with `websearch_to_tsquery()` (never raises syntax errors). Never build `to_tsquery()` strings from raw user input.
5. Rank only the rows that matched (`WHERE tsv @@ query`), and call `ts_headline()` only on the final top N rows — both are expensive.
6. Core full-text ranking is not BM25: it has no global term statistics. If ranking quality matters, use a BM25 extension (`pg_textsearch`, ParadeDB `pg_search`) or rely on hybrid search with vectors.
7. Use a `gin_trgm_ops` index to speed up `LIKE`/`ILIKE '%term%'` and regex; use GiST (`gist_trgm_ops`) when you need `ORDER BY col <-> 'term' LIMIT k`.
8. Store embeddings in a typed column (`vector(1536)`, `halfvec(3072)`) and record the model name and version next to them. Never mix models in one index.
9. Use the distance operator that matches your model and index opclass: `<=>` + `vector_cosine_ops` by default; `<#>` + `vector_ip_ops` for normalized vectors.
10. An approximate index is used only with `ORDER BY embedding <op> $1 LIMIT k` (ascending distance, operator — not an expression). Check with `EXPLAIN`.
11. Never put a distance threshold in the same `WHERE` as the ordered vector scan; take the top k in a `MATERIALIZED` CTE and apply the threshold outside it.
12. Prefer HNSW over IVFFlat for most workloads. Build it after the bulk load, with enough `maintenance_work_mem`, and with `CREATE INDEX CONCURRENTLY` in production.
13. Tune recall with `hnsw.ef_search` (default 40; it also caps the rows one scan returns) using `SET LOCAL` inside a transaction; measure recall@k against exact search before and after.
14. Approximate search filters *after* the index scan. With `WHERE` filters, enable `hnsw.iterative_scan` (pgvector 0.8.0+), or use partial indexes, partitions, or exact search when the filter is very selective.
15. Enforce permissions in the database (row-level security or a mandatory `tenant_id` filter). Under RLS, run `EXPLAIN` as the application role: non-leakproof filters (`@@`, `@>`, `LIKE`, trigram) cannot use their indexes there.
16. Reduce memory with `halfvec`, binary quantization plus re-ranking, or subvector (Matryoshka) indexes — always re-rank with the full vector.
17. Combine keyword and vector results with Reciprocal Rank Fusion (k = 60) in one SQL query; never add raw, unnormalized scores from different methods.
18. Keep the HNSW index in memory (size it, watch `shared_buffers` and the OS cache, warm it with `pg_prewarm`).
19. Load vectors with `COPY` (binary format when your driver supports it), then build indexes; never row-by-row inserts for a large backfill.
20. Model a RAG corpus as `documents` → `chunks` (ON DELETE CASCADE), with chunk order, token count, content hash, metadata `jsonb`, and model/version columns.
21. Re-embed with a new column or table plus a new index built in the background, then switch reads; never update a live index in place with a different model.
22. Know your extension versions (`SELECT extversion FROM pg_extension`): use pgvector ≥ 0.8.4 for the HNSW vacuum fixes, and check licenses (AGPL vs permissive) before adopting a BM25 or vector extension.
23. Stay in PostgreSQL while one database is enough (transactions, joins, filters, one system to run); move to a dedicated engine only for measured needs it cannot meet.

## 1. Choose the right kind of search

Different questions need different tools. Many real products need two of them.

| Need | Tool | Example query | Index |
|---|---|---|---|
| Find documents that contain these words (any word form) | Full-text search (`tsvector @@ tsquery`) | "invoice overdue" finds "overdue invoices" | GIN on `tsvector` |
| Rank keyword matches like a search engine | BM25 extension (`pg_textsearch`, `pg_search`) | best matches for "refund policy" | extension index (`bm25`, `paradedb`) |
| Tolerate typos, substring search, autocomplete on names | `pg_trgm` | "postgrs" finds "postgres"; `ILIKE '%gres%'` | GIN or GiST trigram |
| Find text with the same *meaning* | `pgvector` (embeddings) | "how do I get my money back" finds "refund policy" | HNSW or IVFFlat |
| Production search / RAG retrieval | Hybrid: keyword + vector, fused | both exact terms (error codes, names) and meaning | both of the above |

Vocabulary used in this document:

- **Token**: a piece of text found by a parser (a word, a number, an email address…).
- **Lexeme**: a normalized token (lower case, stemmed), the unit stored in a `tsvector`.
- **Stemming**: reducing a word to a root form, so "running" and "runs" both become "run".
- **Embedding**: a list of numbers (a vector) produced by a machine-learning model; texts with similar meaning get vectors that are close.
- **k-NN / ANN**: k nearest neighbors (exact) / approximate nearest neighbors (fast, may miss some results).
- **Recall@k**: the share of the true k nearest neighbors that an approximate search returns (1.0 = perfect).

## 2. Full-text search in core PostgreSQL

### 2.1 `tsvector` and `tsquery`

**Why:** `LIKE '%word%'` does not understand word forms, cannot rank, and cannot use a B-tree index. Full-text search (FTS) parses text into lexemes once, indexes them, and matches queries against them [1].

**How:** a document becomes a `tsvector` (sorted lexemes with positions). A query becomes a `tsquery` (lexemes joined by `&` AND, `|` OR, `!` NOT, `<->` FOLLOWED BY). The `@@` operator tests a match.

```sql
SELECT to_tsvector('english', 'a fat  cat sat on a mat - it ate a fat rats');
-- 'ate':9 'cat':3 'fat':2,11 'mat':7 'rat':12 'sat':4
-- Stop words (a, on, it) are removed; "rats" is stemmed to "rat".

SELECT to_tsvector('english', 'The fat rats') @@ to_tsquery('english', 'rat & fat');  -- true
```

### 2.2 Text search configurations (`english`, `french`, `simple`)

A **configuration** binds a parser to a list of dictionaries for each token type [3]. It decides the language rules: stop words and stemming.

| Configuration | Lower-cases | Removes stop words | Stems | Use for |
|---|---|---|---|---|
| `english`, `french`, `german`, … | yes | yes (language list) | yes (Snowball stemmer) | prose in one known language |
| `simple` | yes | no | no | names, codes, identifiers, mixed or unknown languages |
| custom (copy + edit) | yes | your choice | your choice | adding `unaccent`, synonyms, a thesaurus |

```sql
SELECT cfgname FROM pg_ts_config;          -- list configurations (psql: \dF)
SHOW default_text_search_config;           -- set by initdb from the locale; built-in default is pg_catalog.simple
SELECT to_tsvector('french', 'Hôtels de la Mer');  -- 'hôtel':1 'mer':4 ("de", "la" are French stop words)
```

Always pass the configuration as the first argument. The two-argument `to_tsvector(regconfig, text)` is immutable, so it can be used in indexes and generated columns; the one-argument form depends on a setting and cannot [2]. An expression index is used only when the query repeats the same expression with the same configuration [2].

New stemmers arrive with major versions: Estonian (PG 18+) [4]; Polish and Esperanto, plus an updated Dutch stemmer (old one kept as `dutch_porter`) (PG 19, beta — may change) [5].

### 2.3 Parsing, dictionaries, stemming and stop words

The parser splits text into typed tokens (`asciiword`, `email`, `url`, `int`…). For each token, the dictionaries of the configuration are tried in order; the first one that recognizes the token emits lexemes. A stop word produces nothing; a token that no dictionary recognizes is dropped [9][3]. Put specific dictionaries first (synonyms, thesaurus) and a catch-all (Snowball stemmer or `simple`) last [3].

Use `ts_debug` to see exactly what happens — the fastest way to understand a surprising (non-)match:

```sql
SELECT alias, token, dictionaries, lexemes
FROM ts_debug('english', 'Running the PostgreSQL 18 servers');
-- 'Running' -> {english_stem} -> {run}
-- 'the'     -> {english_stem} -> {}        (stop word)
-- '18'      -> {simple}       -> {18}
```

Consequences to know:

- Stop words are removed from documents *and* queries. A query made only of stop words ("to be or not to be") becomes empty and matches nothing (PostgreSQL emits a NOTICE).
- Stemming is approximate: different words can share a stem, and some forms are not merged. Check with `ts_lexize('english_stem', 'word')`.
- Changing dictionaries (except small stop-word edits) means you must rebuild stored `tsvector` values and indexes [3].

### 2.4 Accent-insensitive search with `unaccent`

**Why:** French and other languages use diacritics. Users type "hotel" and expect "hôtel".

**How:** the `unaccent` extension is a *filtering* dictionary: it removes accents and passes the result to the next dictionary [6]. Build a custom configuration once:

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;   -- trusted: needs only CREATE privilege on the database

CREATE TEXT SEARCH CONFIGURATION public.french_unaccent (COPY = pg_catalog.french);
ALTER TEXT SEARCH CONFIGURATION public.french_unaccent
  ALTER MAPPING FOR hword, hword_part, word
  WITH public.unaccent, pg_catalog.french_stem;

SELECT to_tsvector('public.french_unaccent', 'Hôtels de la Mer');                -- 'hotel':1 'mer':4
SELECT to_tsvector('public.french_unaccent', 'Hôtel de la Mer')
       @@ websearch_to_tsquery('public.french_unaccent', 'hotels');               -- true
```

Because `to_tsvector('public.french_unaccent', …)` uses the two-argument form, it works in a generated column or an index. The standalone `unaccent(text)` *function* is declared `STABLE`, not `IMMUTABLE` [7], because it depends on a dictionary found through `search_path` [52]; so it cannot be used directly in an index or generated column (for example for `pg_trgm` on unaccented text). The usual workaround is an immutable wrapper with the function and dictionary schema-qualified (Erwin Brandstetter's answer [52] also shows a faster variant based on a C-language copy of the function):

```sql
CREATE FUNCTION public.immutable_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
RETURN public.unaccent('public.unaccent'::regdictionary, $1);   -- SQL-standard body: PG 14+

CREATE INDEX users_name_trgm_idx ON users USING gin (public.immutable_unaccent(full_name) gin_trgm_ops);

-- The query must repeat the indexed expression (trigram matching is already case-insensitive)
SELECT id, full_name
FROM users
WHERE public.immutable_unaccent(full_name) ILIKE '%' || public.immutable_unaccent($1) || '%';
```

You promise PostgreSQL the result never changes. If you edit the `unaccent.rules` file later, reindex. (PG 17+ changed the rules-file syntax to allow whitespace and quotes [8].)

### 2.5 Turning user input into a `tsquery`

| Function | Input it expects | Operators recognized | Errors on bad input? | Use for |
|---|---|---|---|---|
| `to_tsquery` | tsquery syntax: `fat & (rat \| cat)`, `supern:*` | `& \| ! <-> <N>`, `:*`, weights `:AB` | **yes** (syntax error) | queries your code builds from validated tokens |
| `plainto_tsquery` | plain text | none (all words AND-ed) | no | simple "all words" search |
| `phraseto_tsquery` | plain text | none (words joined with `<->`) | no | exact phrase search |
| `websearch_to_tsquery` | web-search style text | `"quoted phrase"`, `or`, `-word` | **never** raises a syntax error | **raw user input** (search boxes) |

Sources: [9].

```sql
SELECT websearch_to_tsquery('english', '"supernovae stars" -crab');
-- 'supernova' <-> 'star' & !'crab'
SELECT websearch_to_tsquery('english', 'signal -"segmentation fault"');
-- 'signal' & !( 'segment' <-> 'fault' )

-- Bad: raw user input given to to_tsquery: "C++ & (" raises a syntax error, and the user controls the operators
SELECT * FROM documents WHERE search_tsv @@ to_tsquery('english', $1);
-- Good: never fails, supports quotes / or / minus
SELECT * FROM documents WHERE search_tsv @@ websearch_to_tsquery('english', $1);
```

All of these are bound parameters, so there is no SQL injection either way (see [security](11-security.md)); the risk with `to_tsquery` is errors and unexpected operators, not injection.

### 2.6 Phrase and prefix queries

- **Phrase:** `<->` means "immediately followed by"; `<N>` means "followed at distance N". `phraseto_tsquery` and quoted text in `websearch_to_tsquery` produce them, accounting for removed stop words with `<N>` [9].
- **Prefix:** `:*` matches every lexeme that starts with the string — the basis of search-as-you-type. It is only available in `to_tsquery` syntax, so build it from sanitized tokens:

```sql
-- "postg" typed so far -> match postgres, postgresql, ...
SELECT title
FROM documents
WHERE search_tsv @@ to_tsquery('simple', 'postg:*')
LIMIT 10;
```

Prefix queries on stemmed configurations can surprise: the prefix is stemmed too. For autocomplete on titles or names, use the `simple` configuration or `pg_trgm` (section 4).

### 2.7 Store the `tsvector`: generated column + GIN index

**Why:** computing `to_tsvector` at query time is slow and repeats work for every row. A stored column is computed once on write, and the index can be used without repeating the expression [2].

```sql
ALTER TABLE documents
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'D')
  ) STORED;                                   -- write STORED: PG 18 defaults to VIRTUAL

CREATE INDEX CONCURRENTLY documents_search_tsv_idx ON documents USING gin (search_tsv);

SELECT id, title
FROM documents
WHERE search_tsv @@ websearch_to_tsquery('english', 'refund policy');
```

Rules:

- Use `coalesce`: `to_tsvector(NULL)` is NULL and `NULL || tsvector` is NULL, so one NULL field would erase the whole vector [9].
- `setweight` labels lexemes A (highest) to D (lowest, the default) so ranking can favor titles [9].
- Write `STORED`. In PG 18+, a generated column without `STORED` is **virtual**, and indexes on virtual generated columns are not supported [10][11].
- Adding a stored generated column rewrites the whole table and its indexes [53] under an `ACCESS EXCLUSIVE` lock. On a big live table, follow [safe schema migrations](10-safe-schema-migrations.md) (add a plain column, backfill in batches, keep it updated with a trigger, then index concurrently).
- Prefer GIN. GiST text-search indexes are lossy (signature of 124 bytes by default) and cause many rechecks [12]. GIN index builds can run in parallel in PG 18+ [4]; GIN has a pending list (`fastupdate`) that speeds up writes but slows searches until it is cleaned — see [indexing](05-indexing.md).
- A `tsvector` must be smaller than 1 MB, positions stop at 16,383, and each lexeme keeps at most 256 positions [13]. Very long documents lose positional detail; chunking (section 10) avoids this.

### 2.8 Ranking: `ts_rank` vs `ts_rank_cd`

Both functions look at the matching row's `tsvector` only [9]:

| Function | Scores by | Needs positions | Notes |
|---|---|---|---|
| `ts_rank` | frequency of matching lexemes | no | cheaper; good default |
| `ts_rank_cd` | "cover density": frequency **and** proximity of matching terms | yes (returns 0 on stripped vectors) | better for multi-word queries |

**Weights** are an optional first argument, in the order `{D, C, B, A}`; the default is `{0.1, 0.2, 0.4, 1.0}` [9].

**Normalization** is a bit mask (combine with `|`) that controls document-length effects [9]:

| Flag | Effect |
|---|---|
| 0 | ignore length (default) |
| 1 | divide by 1 + log(document length) |
| 2 | divide by document length |
| 4 | divide by mean harmonic distance between extents (`ts_rank_cd` only) |
| 8 | divide by number of unique words |
| 16 | divide by 1 + log(number of unique words) |
| 32 | rank / (rank + 1) — scales to 0..1, does not change the order |

```sql
SELECT id, title,
       ts_rank_cd('{0.1, 0.2, 0.4, 1.0}', search_tsv, query, 1) AS rank
FROM documents, websearch_to_tsquery('english', $1) AS query
WHERE search_tsv @@ query          -- rank only the matches (uses the GIN index)
ORDER BY rank DESC
LIMIT 20;
```

Ranking is costly: it must read the `tsvector` of *every* matching row, and the GIN index cannot return rows in rank order. If a common term matches 500,000 rows, the query reads and ranks all 500,000 rows to return 20. The PostgreSQL manual says this is "almost impossible to avoid" [9]. Mitigations: narrow with filters first, keep `tsvector` columns small (chunking), use a BM25 extension that supports top-k index scans (section 3), or use the `rum` index below.

**The `rum` extension** (Postgres Professional, PostgreSQL-style license, release 1.3.15 in October 2025) is a GIN-like index that also stores lexeme positions. It can return rows already ordered by rank with `ORDER BY tsv <=> query` (lower = better) and speeds up phrase search, at the price of slower builds and inserts than GIN [58]. It is not BM25 (no global statistics), but it ranks from the index itself instead of reading every matching row from the table. Amazon RDS offers it [22].

```sql
CREATE EXTENSION rum;
CREATE INDEX documents_search_rum_idx ON documents USING rum (search_tsv rum_tsvector_ops);

SELECT id, title, search_tsv <=> query AS rank_distance
FROM documents, websearch_to_tsquery('english', $1) AS query
WHERE search_tsv @@ query
ORDER BY search_tsv <=> query
LIMIT 20;
```

### 2.9 Highlighting with `ts_headline` — only on the final rows

`ts_headline` re-parses the *original text* (not the `tsvector`), so it is slow [9]. Compute it only for the rows you return:

```sql
-- Bad: a headline for every match (no LIMIT)
SELECT id, title, ts_headline('english', body, query) AS snippet
FROM documents, websearch_to_tsquery('english', $1) AS query
WHERE search_tsv @@ query;

-- Good: rank and limit first in a subquery, then highlight only 10 rows
SELECT id, title,
       ts_headline('english', body, query,
                   'MaxFragments=2, MaxWords=25, MinWords=8, StartSel=<mark>, StopSel=</mark>') AS snippet
FROM (
  SELECT id, title, body, query, ts_rank_cd(search_tsv, query) AS rank
  FROM documents, websearch_to_tsquery('english', $1) AS query
  WHERE search_tsv @@ query
  ORDER BY rank DESC
  LIMIT 10
) AS top
ORDER BY rank DESC;
```

In a single-level query with `ORDER BY … LIMIT`, the planner already postpones expensive select-list functions until after the sort (anything costing more than 10 × `cpu_operator_cost`; `ts_headline` is declared with cost 100) [54]. The explicit subquery is still the safer form: the optimization does not apply without a `LIMIT`, when the headline is used in `WHERE`, `ORDER BY` or `DISTINCT`, or when it is computed inside a `MATERIALIZED` CTE.

Options: `MaxWords`/`MinWords` (defaults 35/15), `MaxFragments` (0 = one headline; > 0 = fragment mode), `StartSel`/`StopSel` (default `<b>`/`</b>`), `FragmentDelimiter`, `HighlightAll` [9]. **The output is not safe HTML**: sanitize the input or escape the output before rendering (XSS risk) [9].

### 2.10 Multilingual content

Options, from simplest to most precise:

1. **One language column + per-row configuration.** The manual shows `to_tsvector(config_column, body)` [2], but do not store the configuration in a `regconfig` column: `pg_upgrade` refuses databases with table columns of type `regconfig` [56]. Store a language code as `text` and map it with an immutable function:

   ```sql
   CREATE FUNCTION public.ts_config_for(lang text) RETURNS regconfig
   LANGUAGE sql IMMUTABLE PARALLEL SAFE
   RETURN CASE lang WHEN 'fr' THEN 'pg_catalog.french'::regconfig
                    WHEN 'de' THEN 'pg_catalog.german'::regconfig
                    ELSE 'pg_catalog.english'::regconfig END;

   ALTER TABLE documents ADD COLUMN lang text NOT NULL DEFAULT 'en';
   ALTER TABLE documents ADD COLUMN search_tsv tsvector
     GENERATED ALWAYS AS (to_tsvector(public.ts_config_for(lang),
                                      coalesce(title, '') || ' ' || coalesce(body, ''))) STORED;
   -- Query in the user's language, and filter on it:
   SELECT id FROM documents
   WHERE lang = 'fr'
     AND search_tsv @@ websearch_to_tsquery('french', $1);
   ```

   Filter on `lang` too: a French query parsed with French rules should not be compared to English stems.

2. **`simple` configuration for everything.** No stemming, no stop words: works for any language, codes and names, at the price of recall ("running" does not match "run"). Pair it with vector search, which handles meaning across forms and languages.
3. **Two vectors per row** (`simple` + language-specific), queried with OR, when you need both exact tokens and stemmed matches.
4. **Languages without spaces** (Chinese, Japanese) need an extra parser such as `zhparser` (third-party), the PGroonga extension (Groonga-based full-text search "for all languages", PostgreSQL License, active in 2026) [59], or a BM25 extension with suitable tokenizers [14][15].

### 2.11 Limits of core full-text search

- **No BM25 and no global statistics.** `ts_rank`/`ts_rank_cd` use only the row's own `tsvector` and do not know how rare a term is across the table (no inverse document frequency), so a common word like "database" counts as much as a rare one like "pgvector" [9][16].
- **Ranking cost** grows with the number of matches, as shown above.
- **No fuzzy matching**: a typo finds nothing. Add `pg_trgm` (section 4) for spelling suggestions.
- **Size limits**: `tsvector` < 1 MB, 256 positions per lexeme, positions ≤ 16,383 [13].
- **Language quality** depends on Snowball stemmers and stop-word lists; no lemmatization, no compound-word splitting by default.
- **Collation (PG 18+)**: full-text search now reads configuration files with the cluster's default collation provider. After `pg_upgrade` of an ICU- or builtin-provider cluster, reindex FTS and `pg_trgm` indexes [4].

These limits are acceptable for many apps (filtering, admin search, "contains these words"). For relevance ranking at scale, see BM25 (section 3) and hybrid search (section 9).

## 3. BM25 ranking inside PostgreSQL

### 3.1 What BM25 adds

**BM25** ("Best Match 25") is the ranking formula used by Lucene, Elasticsearch and most search engines. Compared with `ts_rank`, it adds three things [16]:

- **Inverse document frequency (IDF):** a rare term counts more than a common one. This needs *global* statistics (how many rows contain each term), which core PostgreSQL ranking does not have.
- **Term-frequency saturation (parameter `k1`):** the 50th repetition of a word adds almost nothing.
- **Length normalization (parameter `b`):** a match in a short text counts more than the same match in a long one.

BM25 extensions also add **top-k index scans** (for example Block-Max WAND): the index returns the best k rows directly, instead of ranking every match [14]. Core PostgreSQL has no BM25; you need an extension.

### 3.2 The options (status as of October 2026)

| Extension | Maintainer | License | Latest release | PostgreSQL | Notes |
|---|---|---|---|---|---|
| `pg_textsearch` | Tiger Data (formerly Timescale) | PostgreSQL License | v1.5.1 (2026-10-02); GA v1.0.0 on 2026-03-27 | 17, 18 | Native C index `USING bm25`, uses PostgreSQL text search configurations; needs `shared_preload_libraries` [14][17] |
| `pg_search` (ParadeDB) | ParadeDB | AGPL-3.0 (commercial Enterprise edition exists) | v0.26.0 (2026-10-03) | 15+ (prebuilt binaries) | Rust + Tantivy index `USING paradedb` (`bm25` kept as alias since 0.25.0); also facets, aggregates, vector search (beta); needs `shared_preload_libraries` [18][19][20] |
| VectorChord-bm25 (`vchord_bm25`) | TensorChord | AGPL-3.0 or Elastic License 2.0 | 0.3.0 (2025-12-15) | 14–18 (build features) | `bm25vector` type + `pg_tokenizer` extension; README says only English is tested; index returns at most `bm25_catalog.bm25_limit` rows (default 100) [15] |
| `lakebase_text` | Neon (Databricks) | Neon-only managed extension | managed by Neon | 16+ | `lakebase_bm25` index on plain `tsvector`; Neon removed `pg_search` on 2026-09-21 [21] |

Notes:

- **Maturity.** `pg_textsearch` declared general availability with v1.0.0 (March 2026) and requires PG 17+. ParadeDB is still versioned 0.x and its SQL API has changed between releases. VectorChord-bm25 is early (0.3.0, English-only testing, last release December 2025).
- **Licenses matter.** AGPL-3.0 is fine for many self-hosted apps but some companies ban it; read your legal policy. The PostgreSQL License is permissive.
- **Managed databases** rarely ship BM25 extensions. For example, the Amazon RDS for PostgreSQL extension list includes `pg_trgm`, `pg_bigm` and `rum`, but not `pg_search`, `pg_textsearch` or `pgvectorscale` [22]. Check your provider before you design around one.
- **Older names:** ParadeDB's BM25 extension was called `pg_bm25` until it was renamed `pg_search` in March 2024 [23]. TensorChord's earlier `pg_bestmatch` (BM25 as sparse vectors) has had no release since October 2024 [25].

### 3.3 `pg_textsearch` example

```sql
-- postgresql.conf: shared_preload_libraries = 'pg_textsearch'
CREATE EXTENSION pg_textsearch;

CREATE INDEX chunks_content_bm25_idx ON chunks
  USING bm25 (content) WITH (text_config = 'english');   -- k1 = 1.2, b = 0.75 by default

-- <@> returns a NEGATIVE BM25 score, so ascending order = most relevant first
SELECT id, content, content <@> 'refund policy' AS score
FROM chunks
ORDER BY content <@> 'refund policy'
LIMIT 10;

-- Name the index explicitly (required for partial indexes and inside PL/pgSQL)
SELECT id
FROM chunks
ORDER BY content <@> to_bm25query('refund policy', 'chunks_content_bm25_idx')
LIMIT 10;
```

Facts from the README [14]: one partial index per language is the documented multilingual pattern; boolean filters use the standard `@@` operator with `tsquery` syntax (v1.5); BM25 statistics are **per partition** on partitioned tables; and corpus statistics **include rows hidden by row-level security** — a user who knows a term can infer its frequency in rows they cannot see. Set `pg_textsearch.allow_rls = off` (superuser) to forbid BM25 indexes on RLS-protected tables if that matters.

### 3.4 ParadeDB `pg_search` example

```sql
-- postgresql.conf: shared_preload_libraries = 'pg_search'
CREATE EXTENSION pg_search;

CREATE INDEX chunks_search_idx ON chunks
  USING paradedb (id, content, document_id)     -- "USING bm25" still works as an alias
  WITH (key_field = 'id');

SELECT id, pdb.score(id) AS score
FROM chunks
WHERE content ||| 'refund policy'       -- match ANY term;  &&& = ALL terms; ### = phrase; === = exact token
ORDER BY pdb.score(id) DESC
LIMIT 10;
```

Syntax from the ParadeDB docs [19][20]. Advanced queries (regex, fuzzy, …) use `col @@@ pdb.<builder>(…)`, for example `pdb.regex('key.*rd')` [20]. ParadeDB's SQL API has changed across releases (the extension itself was renamed from `pg_bm25` to `pg_search` in 2024 [23]); pin the version and read the docs for that version.

### 3.5 When to use a BM25 extension

| Situation | Recommendation |
|---|---|
| Keyword search is a filter ("documents containing X") | Core FTS + GIN is enough |
| Relevance matters, corpus is large, you can install extensions | `pg_textsearch` (permissive license, uses PostgreSQL configurations) or `pg_search` (richer features, AGPL) |
| Managed service without these extensions | Core FTS + hybrid with vectors (section 9); the vector side compensates for weak lexical ranking |
| Strict per-user permissions with RLS | Check how the extension computes statistics under RLS (see `pg_textsearch` note above) |

## 4. Fuzzy and substring search with `pg_trgm`

### 4.1 Trigram concepts

A **trigram** is a group of three consecutive characters. `pg_trgm` splits each word (padded with two spaces before and one after) into trigrams and measures how many two strings share: "cat" → `"  c"`, `" ca"`, `"cat"`, `"at "` [24]. This gives typo tolerance and substring matching that full-text search cannot do. Comparisons are case-insensitive in a default build, and non-alphanumeric characters are ignored [24].

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trusted extension
SELECT show_trgm('cat');                   -- {"  c"," ca","at ","cat"}
SELECT similarity('postgres', 'postgrse');   -- a number between 0 and 1
```

### 4.2 Functions, operators and thresholds

| Function / operator | Meaning | Threshold setting (default) |
|---|---|---|
| `similarity(a, b)` / `a % b` | whole-string similarity | `pg_trgm.similarity_threshold` (0.3) |
| `word_similarity(a, b)` / `a <% b` | best match of `a` inside any part of `b` | `pg_trgm.word_similarity_threshold` (0.6) |
| `strict_word_similarity(a, b)` / `a <<% b` | like above, but aligned to whole words of `b` | `pg_trgm.strict_word_similarity_threshold` (0.5) |
| `a <-> b`, `a <<-> b`, `a <<<-> b` | distance = 1 − the matching similarity (for `ORDER BY … LIMIT`) | — |

Sources: [24]. Use `word_similarity` to find a short search term inside a longer text (a name inside a title), `strict_word_similarity` for whole-word matches, and `similarity` to compare two short strings. Set thresholds per query with `SET LOCAL` (the older `set_limit()` function is deprecated) [24].

### 4.3 Indexes: GIN vs GiST

Both `gin_trgm_ops` and `gist_trgm_ops` accelerate `%`, `<%`, `<<%`, `LIKE`, `ILIKE`, `~`, `~*` and `=` [24].

| | GIN (`gin_trgm_ops`) | GiST (`gist_trgm_ops`) |
|---|---|---|
| Structure | inverted index: one entry per trigram, listing the rows | one fixed-size signature per row: lossy (`siglen`, default 12 bytes, max 2024) |
| Filtering (`%`, `LIKE '%x%'`, regex) | the common choice | works; more false matches to recheck with short signatures |
| `ORDER BY col <-> 'term' LIMIT k` (nearest by distance) | **not supported** | supported (k-nearest-neighbor scan) |
| Updates | slower: one row change touches many index entries (eased by the pending list) [55] | one entry per row |

```sql
-- Substring and ILIKE search on titles
CREATE INDEX CONCURRENTLY documents_title_trgm_idx ON documents USING gin (title gin_trgm_ops);

SELECT id, title FROM documents WHERE title ILIKE '%invoice%';     -- can use the index
SELECT id, title FROM documents WHERE title ~* 'inv(oice|oicing)';  -- regex can use it too

-- "Did you mean": nearest titles by distance (needs GiST)
CREATE INDEX CONCURRENTLY documents_title_trgm_gist_idx ON documents USING gist (title gist_trgm_ops);
SELECT id, title, title <-> 'postgress replicaton' AS dist
FROM documents
ORDER BY title <-> 'postgress replicaton'
LIMIT 5;
```

Limits: a pattern with no extractable trigram (for example `LIKE '%ab%'`, fewer than three characters) degenerates to a full index scan [24]. The more trigrams a pattern has, the more selective the search.

### 4.4 Typo-tolerant search and spelling suggestions

Combine `pg_trgm` with full-text search: build a table of the distinct words in your corpus (with the `simple` configuration, so words are not stemmed), index it with trigrams, and suggest corrections for query words that return nothing [24].

```sql
CREATE TABLE search_words AS
SELECT word FROM ts_stat($$SELECT to_tsvector('simple', content) FROM chunks$$);
CREATE INDEX search_words_trgm_idx ON search_words USING gin (word gin_trgm_ops);

-- Suggest corrections for a misspelled word
SELECT word, similarity(word, 'replicaton') AS sim
FROM search_words
WHERE word % 'replicaton'
ORDER BY sim DESC, word
LIMIT 5;
```

Refresh the word table periodically; it does not need to be exactly current [24]. For autocomplete on names, a GIN trigram index on the name column (optionally on `immutable_unaccent(name)`, section 2.4) is usually enough.

## 5. Vector search with `pgvector`

### 5.1 Concepts in one minute

An **embedding model** turns a text (a query, a chunk of a document) into a vector of a fixed number of **dimensions** (for example 1,536). Texts with similar meaning get vectors that are close. A search computes the distance between the query vector and stored vectors and returns the k closest.

- **Exact search (k-NN):** compute the distance to every row; perfect recall, cost grows linearly with rows.
- **Approximate search (ANN):** an index (HNSW or IVFFlat) visits only part of the data; much faster, but may miss some true neighbors. "Unlike typical indexes, you will see different results for queries after adding an approximate index" [26].

`pgvector` is the standard extension. It is open source (PostgreSQL License), and most managed PostgreSQL services offer it [26][22].

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extversion FROM pg_extension WHERE extname = 'vector';   -- know your version
ALTER EXTENSION vector UPDATE;                                   -- after installing a newer build
```

**Versions (October 2026).** The latest release is **0.8.7** (2026-10-01) [27]. Important milestones: HNSW (0.5.0), parallel HNSW builds (0.6.0), `halfvec`/`sparsevec`/bit indexing and `binary_quantize` (0.7.0), iterative index scans and better filtered-query cost estimates (0.8.0), PostgreSQL 18 support (0.8.1). Releases 0.8.3 and 0.8.4 fixed possible index corruption and errors during HNSW vacuuming: run at least 0.8.4 if your provider allows it [27]. Managed services lag behind (for example Amazon RDS listed 0.8.2 in October 2026 [22]).

### 5.2 Types and dimension limits

| Type | Element | Storage per value | Max dimensions stored | Max dimensions in an HNSW/IVFFlat index |
|---|---|---|---|---|
| `vector(n)` | 4-byte float | 4 × n + 8 bytes | 16,000 | **2,000** |
| `halfvec(n)` | 2-byte float | 2 × n + 8 bytes | 16,000 | **4,000** |
| `bit(n)` | 1 bit | n / 8 + 8 bytes | PostgreSQL `bit` limits | **64,000** |
| `sparsevec(n)` | non-zero float4 entries | 8 × non-zeros + 16 bytes | 16,000 non-zero elements | **1,000 non-zero** (HNSW only) |

Sources: [26][28]. All elements must be finite (no `NaN` or infinity). `NULL` vectors are not indexed, and zero vectors are not indexed for cosine distance [26].

Practical consequences:

- 1,536 dimensions (OpenAI `text-embedding-3-small`) fit `vector(1536)` and its index.
- 3,072 dimensions (`text-embedding-3-large`) do **not** fit a `vector` index. Use `halfvec(3072)` (column or index expression), ask the API for fewer dimensions, or index a subvector (section 8) [26][29].
- Declare the dimension (`vector(1536)`, not `vector`) unless you store several models in one column on purpose (section 10.3).
- A 1,536-dimension `vector` takes about 6 KB [30], more than the ~2 KB at which PostgreSQL moves values out of line (TOAST). pgvector uses `EXTERNAL` storage (out of line, no compression) since 0.6.0 [27].

### 5.3 Distance operators and which one to use

| Operator | Distance | Index operator class (`vector` / `halfvec` / `sparsevec`) | HNSW | IVFFlat |
|---|---|---|---|---|
| `<->` | Euclidean (L2) | `vector_l2_ops`, `halfvec_l2_ops`, `sparsevec_l2_ops` | yes | yes (not sparsevec) |
| `<#>` | **negative** inner product | `vector_ip_ops`, … | yes | yes (not sparsevec) |
| `<=>` | cosine distance (1 − cosine similarity) | `vector_cosine_ops`, … | yes | yes (not sparsevec) |
| `<+>` | L1 / taxicab (0.7.0+) | `vector_l1_ops`, … | yes | no |
| `<~>` | Hamming (bit vectors) | `bit_hamming_ops` | yes | yes |
| `<%>` | Jaccard (bit vectors) | `bit_jaccard_ops` | yes | no |

Sources: [26]. An index serves **one** operator: the opclass in `CREATE INDEX` must match the operator in `ORDER BY`. `<#>` returns the negative inner product because PostgreSQL index scans only order ascending; multiply by −1 to display it. Cosine similarity = `1 - (a <=> b)` [26].

How to choose:

- **Follow the model card.** It says which similarity the model was trained for.
- **Cosine (`<=>`)** is the safe default for text embeddings. OpenAI recommends cosine similarity and says the choice "typically doesn't matter much" [29].
- **Inner product (`<#>`) for normalized vectors.** If vectors have length 1 (OpenAI embeddings are normalized [29]), inner product gives the same ranking as cosine and is cheaper to compute; the pgvector README recommends it "for best performance" in that case [26]. Normalize yourself with `l2_normalize()` if needed (for example after truncating dimensions — truncated vectors are no longer normalized [29]).
- **L2 (`<->`)** when the model card or your data is defined by Euclidean distance.
- **Hamming/Jaccard** for binary vectors (binary embeddings, image hashes, binary quantization).

```sql
-- Bad: index built for cosine, query sorts by L2 -> the index cannot be used
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
SELECT id FROM chunks ORDER BY embedding <-> $1 LIMIT 10;
-- Good: same distance in index and query
SELECT id FROM chunks ORDER BY embedding <=> $1 LIMIT 10;
```

### 5.4 The query shape that uses a vector index

The index is used only when the query has `ORDER BY <column> <operator> <query vector>` (ascending) and a `LIMIT` [26]:

```sql
-- Good: index-friendly; compute the distance once with an alias
SELECT id, content, embedding <=> $1 AS distance
FROM chunks
ORDER BY distance
LIMIT 10;

-- Bad: ORDER BY an expression (similarity, DESC) -> no index, full scan + sort
SELECT id, 1 - (embedding <=> $1) AS similarity
FROM chunks
ORDER BY similarity DESC
LIMIT 10;

-- Bad: distance threshold without ORDER BY/LIMIT -> exact scan of every row
SELECT id FROM chunks WHERE embedding <=> $1 < 0.3;
```

Return a similarity for display in the outer query if you need one. Check every vector query with `EXPLAIN (ANALYZE, BUFFERS)`: you want `Index Scan using … on chunks … Order By: (embedding <=> …)` (see [query optimization](06-query-optimization-and-explain.md)). On a small table the planner may correctly prefer a sequential scan [26].

**Distance thresholds.** If you also need "only results closer than X", do not put the threshold in the same `WHERE`: the executor cannot stop the ordered index scan early and keeps scanning [34]. Use the pattern from the pgvector README [26]:

```sql
WITH nearest AS MATERIALIZED (
  SELECT id, embedding <=> $1 AS distance
  FROM chunks
  ORDER BY distance
  LIMIT 20                         -- other filters go INSIDE the CTE
)
SELECT * FROM nearest
WHERE distance < 0.35              -- threshold OUTSIDE the CTE
ORDER BY distance;
```

**Results capped by `ef_search`.** With HNSW, one index scan returns at most `hnsw.ef_search` rows (default 40). `LIMIT 100` with the default returns at most 40 rows unless you raise `ef_search` or enable iterative scans [26][33].

### 5.5 Exact search

Exact search is right for small tables, for very selective filters (section 7), and as the reference to measure recall.

- Without a vector index, `ORDER BY embedding <=> $1 LIMIT k` is exact.
- Speed it up with parallel workers (`SET max_parallel_workers_per_gather = 4`). The planner ignores TOAST in its costs and may pick a serial plan; lower `min_parallel_table_scan_size` and `parallel_setup_cost` for the query, or store vectors inline with `ALTER TABLE … ALTER COLUMN embedding SET STORAGE PLAIN` (only when the whole row fits in an 8 KB page) [26].
- Force exact search on a table that has an index: `SET LOCAL enable_indexscan = off` in a transaction [26].

## 6. Vector indexes: HNSW and IVFFlat

### 6.1 HNSW

**HNSW** (Hierarchical Navigable Small World) builds a multi-layer graph. It has a better speed/recall trade-off than IVFFlat but builds more slowly and uses more memory; it needs no training step, so it can be created on an empty table [26].

| Parameter | Kind | Default | Range | Effect |
|---|---|---|---|---|
| `m` | build (`WITH`) | 16 | 2–100 | max connections per node per layer; higher = better recall, bigger index |
| `ef_construction` | build (`WITH`) | 64 | 4–1000, and ≥ 2 × `m` | candidate list while building; higher = better graph, slower build/insert |
| `hnsw.ef_search` | query (`SET`) | 40 | 1–1000 | candidate list while searching; higher = better recall, slower; also caps rows per scan |

Sources: [26][28].

```sql
SET maintenance_work_mem = '4GB';            -- session only; never more than the server can spare
SET max_parallel_maintenance_workers = 7;    -- plus the leader (default 2); may need max_parallel_workers > 8

CREATE INDEX CONCURRENTLY chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Per query (inside a transaction): trade speed for recall
BEGIN;
SET LOCAL hnsw.ef_search = 100;
SELECT id FROM chunks ORDER BY embedding <=> $1 LIMIT 10;
COMMIT;
```

Rules of thumb:

- Start with the defaults; raise `ef_search` first (cheap, per query), then `m`/`ef_construction` only if recall is still too low (requires a rebuild) [26]. Jonathan Katz recommends `ef_construction = 256` when you use parallel builds [30].
- The build is much faster when the graph fits in `maintenance_work_mem`; PostgreSQL prints a NOTICE ("hnsw graph no longer fits into maintenance_work_mem") when it does not [26].
- Size: the index for 1 million 1,536-dimension OpenAI vectors was about 7.7 GB with `m = 16` in Katz's tests [30]; Crunchy Data reports "8GB or larger" for 1M rows and recommends keeping it all in memory [33].

### 6.2 IVFFlat

**IVFFlat** clusters vectors into `lists` with k-means at build time, then searches only the `probes` lists closest to the query. It builds faster and uses less memory than HNSW, but has a worse speed/recall trade-off [26].

```sql
-- Build only AFTER the table holds representative data (k-means needs it)
CREATE INDEX CONCURRENTLY chunks_embedding_ivf_idx
  ON chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 1000);                      -- rows/1000 up to 1M rows, sqrt(rows) above

BEGIN;
SET LOCAL ivfflat.probes = 32;              -- default 1; start near sqrt(lists)
SELECT id FROM chunks ORDER BY embedding <=> $1 LIMIT 10;
COMMIT;
```

Rules: create the index after loading data; too many lists for too little data loses results ("drop the index until the table has more data") [26]. The centroids are fixed at build time, so recall degrades when the data distribution changes; plan periodic rebuilds (`REINDEX INDEX CONCURRENTLY`) [32]. `lists` range is 1–32,768 (default 100) [28].

### 6.3 Comparison

| | HNSW | IVFFlat |
|---|---|---|
| Speed/recall trade-off | better | worse |
| Build time and memory | slower, more memory | faster, less memory |
| Can be built on an empty table | yes | no (needs representative data) |
| Inserts after build | handled well (graph updated) | added to existing lists; quality drifts → rebuild |
| Query knob | `hnsw.ef_search` (default 40) | `ivfflat.probes` (default 1) |
| Iterative scans (0.8.0+) | `strict_order` or `relaxed_order` | `relaxed_order` only |
| Supports `sparsevec`, L1, Jaccard | yes | no |
| Use when | default choice for production search and RAG | fast builds of large, mostly static data; memory is tight |

Sources: [26][28][32].

### 6.4 Build tips

1. **Load first, index after.** Bulk-load with `COPY` (section 11.4), then create the index; building is faster than maintaining it row by row [26].
2. **Give the build memory and workers** in its own session (`maintenance_work_mem`, `max_parallel_maintenance_workers`, as in 6.1), not globally; watch for the NOTICE [26].
3. **Use `CREATE INDEX CONCURRENTLY` in production** so writes are not blocked [26]. It cannot run inside a transaction block, so your migration tool must run it outside one (see [safe migrations](10-safe-schema-migrations.md)). A failed concurrent build leaves an `INVALID` index to drop and retry.
4. **Monitor progress** from another session [26]:

   ```sql
   SELECT phase,
          round(100.0 * blocks_done / nullif(blocks_total, 0), 1) AS "%"   -- HNSW: use blocks_*
   FROM pg_stat_progress_create_index;
   -- IVFFlat: use tuples_done / tuples_total; phases: initializing, performing k-means,
   -- assigning tuples, loading tuples ("%" only filled during loading tuples)
   ```

5. **One index per distance** you query with, and one per model/dimension.

## 7. Filtering with approximate search

### 7.1 The post-filtering problem

With an approximate index, `WHERE` conditions are applied **after** the index scan. If a filter matches 10% of rows, an HNSW scan with `ef_search = 40` yields about 4 matching rows on average [26]. Ask for 10, get 4 — or 0. AWS calls this **overfiltering** [31]. Row-level security policies behave like such filters too.

```sql
-- Looks right, but may return fewer than 10 rows with an HNSW index:
SELECT id, content
FROM chunks
WHERE tenant_id = $2 AND metadata @> '{"lang": "fr"}'
ORDER BY embedding <=> $1
LIMIT 10;
```

### 7.2 The tools, from simplest to strongest

| Situation | Solution |
|---|---|
| Filter matches few rows (one small tenant, one document) | B-tree index on the filter column → the planner can do an **exact** search over the filtered rows; pgvector 0.8.0 improved this cost estimate [26][27] |
| Filter matches a moderate share of rows | **Iterative index scans** (pgvector 0.8.0+) [26] |
| Few distinct filter values (a handful of categories, languages) | **Partial HNSW index** per value [26] |
| Many tenants that must not affect each other | **List partitioning** by tenant (each partition has its own index) or separate tables [26] |
| Very large data with label filters | Extensions with filter-aware indexes (pgvectorscale labels, section 12) |

**Iterative index scans (pgvector 0.8.0+).** When the filter removes too many rows, the scan continues automatically until it finds enough rows or reaches a limit [26]:

| Setting | Values (default) | Meaning |
|---|---|---|
| `hnsw.iterative_scan` | `off` (default), `strict_order`, `relaxed_order` | keep scanning; strict keeps exact distance order, relaxed allows small disorder but gives better recall |
| `hnsw.max_scan_tuples` | 20,000 | approximate max tuples visited (does not limit the first scan) |
| `hnsw.scan_mem_multiplier` | 1 (× `work_mem`) | memory for the scan; raise if raising `max_scan_tuples` does not help |
| `ivfflat.iterative_scan` | `off` (default), `relaxed_order` | IVFFlat supports relaxed order only |
| `ivfflat.max_probes` | 32,768 (= all lists) | max probes for iterative scans (if lower than `ivfflat.probes`, `probes` wins) |

Sources: [26][28].

```sql
BEGIN;
SET LOCAL hnsw.iterative_scan = relaxed_order;
SET LOCAL hnsw.ef_search = 100;
WITH candidates AS MATERIALIZED (
  SELECT id, document_id, embedding <=> $1 AS distance
  FROM chunks
  WHERE tenant_id = $2
  ORDER BY distance
  LIMIT 10
)
SELECT * FROM candidates
ORDER BY distance + 0;     -- re-sort strictly; "+ 0" is needed on PostgreSQL 17+ [26]
COMMIT;
```

`SET LOCAL` lasts until the end of the transaction, so it is safe with connection pools in transaction mode (see [transactions](08-transactions-concurrency-locking.md)). From Node.js, run these statements on one client inside `BEGIN … COMMIT` (see [Postgres from TypeScript](15-postgres-from-typescript.md)). AWS reports that `relaxed_order` is the best balance for most production cases [31].

**Partial indexes and partitions:**

```sql
-- A handful of languages: one partial index each; the query must repeat the predicate
CREATE INDEX CONCURRENTLY chunks_embedding_fr_idx ON chunks
  USING hnsw (embedding vector_cosine_ops) WHERE (lang = 'fr');
SELECT id FROM chunks WHERE lang = 'fr' ORDER BY embedding <=> $1 LIMIT 10;

-- Strong tenant isolation: one partition (and one HNSW index) per large tenant
CREATE TABLE tenant_chunks (
  tenant_id bigint NOT NULL,
  id        bigint NOT NULL,
  content   text   NOT NULL,
  embedding vector(1536) NOT NULL,
  PRIMARY KEY (tenant_id, id)
) PARTITION BY LIST (tenant_id);
```

Write partial-index predicates as **literals** in the SQL text (they are not user input). With a bind parameter, a generic plan cannot prove that the query matches the index predicate. Partitioning design (how many partitions, default partition, many small tenants) is covered in [schema design](07-schema-design-and-patterns.md).

### 7.3 Choosing exact search on purpose

When the filter leaves a few thousand rows (one document, one small tenant), exact search over those rows is fast and has perfect recall. Make sure the planner can find them through a B-tree index (for example on `(tenant_id)` or `(document_id)`), then check with `EXPLAIN` that it chose a `Bitmap Heap Scan`/`Index Scan` on that index followed by a `Sort` rather than the HNSW index. If it still picks HNSW and returns too few rows, force the exact plan for that query. `SET LOCAL enable_indexscan = off` also disables the B-tree index scans you want, so prefer a materialized CTE: the outer `ORDER BY` runs on the CTE result, where no vector index exists.

```sql
-- Exact top 10 inside one document (uses the B-tree on document_id, never HNSW)
WITH candidates AS MATERIALIZED (
  SELECT id, content, embedding
  FROM chunks
  WHERE document_id = $2
)
SELECT id, content, embedding <=> $1 AS distance
FROM candidates
ORDER BY distance
LIMIT 10;
```

### 7.4 Row-level security and search indexes: a trap

Row-level security (RLS) is the recommended way to enforce "a user sees only their documents" in a RAG app [40] (policies are covered in [security](11-security.md)). Two consequences for search:

1. **The policy is a post-filter** for the HNSW scan: the same overfiltering problem as above. Combine with iterative scans or tenant partitions.
2. **Non-leakproof operators cannot use indexes under RLS.** PostgreSQL evaluates security-policy conditions before any user condition that uses a non-`LEAKPROOF` function [41]. The planner refuses to use such a user condition as an index condition while RLS conditions exist [42]. In PostgreSQL 18, `tsvector @@ tsquery`, `jsonb @>`, array `&&`, `LIKE`/`ILIKE`/regex and all `pg_trgm` operators are not leakproof, while built-in equality on `int`, `bigint`, `text` and `uuid` is [43]. Result: under RLS, a full-text or trigram filter may fall back to scanning far more rows.

   What to do: test `EXPLAIN` **as the application role** (superusers, `BYPASSRLS` roles and, unless `FORCE ROW LEVEL SECURITY` is set, table owners bypass RLS [57], so a test as the owner hides the problem); keep RLS as the safety net but make the policy cheap (`tenant_id = …` with leakproof equality); and if a search path is still too slow, run it in a carefully reviewed `SECURITY DEFINER` function that applies the permission filter explicitly. Marking built-in functions `LEAKPROOF` requires superuser and is risky.

## 8. Storage and cost reduction

Memory is the main cost of vector search: an HNSW index is fast when it is in RAM. Three techniques shrink it. Always **re-rank** the shortlisted candidates with the full-precision vector.

### 8.1 Half precision (`halfvec`)

Store or index vectors as 2-byte floats. In Jonathan Katz's benchmarks, indexing as `halfvec` made the HNSW index about 2× smaller for 1,536 dimensions (7,734 MB → 3,867 MB for 1M vectors), built 2–3× faster, and kept recall nearly identical [30]. He recommends trying `halfvec` indexing first [30].

```sql
-- Option A: keep full precision in the table, index at half precision (expression index)
CREATE INDEX CONCURRENTLY chunks_embedding_half_idx ON chunks
  USING hnsw ((embedding::halfvec(1536)) halfvec_cosine_ops);
SELECT id FROM chunks
ORDER BY embedding::halfvec(1536) <=> $1::halfvec(1536)     -- same expression as the index
LIMIT 10;

-- Option B: store halfvec directly (smaller table too); required above 2,000 dimensions
ALTER TABLE chunks ADD COLUMN embedding_large halfvec(3072);
CREATE INDEX CONCURRENTLY ON chunks USING hnsw (embedding_large halfvec_cosine_ops);
```

### 8.2 Binary quantization + re-ranking

`binary_quantize()` turns each dimension into one bit (positive → 1). The index becomes tiny (473 MB instead of 7,734 MB for 1M × 1,536 dimensions in Katz's tests [30]), but recall alone is poor. Re-ranking with the original vectors recovered most of it for embeddings with enough "bit diversity" (the 1,536-dimension OpenAI dataset), while other datasets (SIFT-128, GIST-960) stayed poor even with re-ranking [30]. Measure on your data.

```sql
CREATE INDEX CONCURRENTLY chunks_embedding_bq_idx ON chunks
  USING hnsw ((binary_quantize(embedding)::bit(1536)) bit_hamming_ops);

BEGIN;
SET LOCAL hnsw.ef_search = 200;           -- must be >= the inner LIMIT
SELECT id, content
FROM (
  SELECT id, content, embedding
  FROM chunks
  ORDER BY binary_quantize(embedding)::bit(1536) <~> binary_quantize($1::vector(1536))
  LIMIT 200                               -- shortlist with the bit index
) AS shortlist
ORDER BY embedding <=> $1                 -- re-rank with full precision
LIMIT 10;
COMMIT;
```

### 8.3 Subvectors (Matryoshka embeddings)

Some models are trained so that the first N dimensions are a good embedding on their own ("Matryoshka" representation; OpenAI's `text-embedding-3` models support shortening with the `dimensions` parameter [29]). Index a prefix, then re-rank with the full vector [26]:

```sql
CREATE INDEX CONCURRENTLY chunks_embedding_sub_idx ON chunks
  USING hnsw ((subvector(embedding, 1, 512)::vector(512)) vector_cosine_ops);

SELECT id, content
FROM (
  SELECT id, content, embedding
  FROM chunks
  ORDER BY subvector(embedding, 1, 512)::vector(512) <=> subvector($1::vector, 1, 512)
  LIMIT 100
) AS shortlist
ORDER BY embedding <=> $1
LIMIT 10;
```

Use cosine for truncated prefixes, or re-normalize with `l2_normalize()` before using inner product: a truncated normalized vector is no longer of length 1 [29].

### 8.4 Sparse vectors

Learned sparse models (SPLADE-style) and BM25-as-vectors produce vectors with tens of thousands of dimensions but few non-zero values. `sparsevec` stores only the non-zero entries (text format `{index:value,…}/dimensions`, 1-based indices) and HNSW can index up to 1,000 non-zero elements [26]:

```sql
CREATE TABLE chunk_sparse (
  chunk_id  bigint PRIMARY KEY REFERENCES chunks (id) ON DELETE CASCADE,
  embedding sparsevec(30522) NOT NULL          -- vocabulary-sized dimension
);
CREATE INDEX ON chunk_sparse USING hnsw (embedding sparsevec_ip_ops);
SELECT chunk_id FROM chunk_sparse ORDER BY embedding <#> $1::sparsevec LIMIT 20;
```

### 8.5 Summary

| Technique | Memory saving (index) | Recall impact | Effort |
|---|---|---|---|
| `halfvec` index or column | ~2× | nearly none in published tests [30] | low — try first |
| Binary quantization + re-rank | ~16× for 1,536 dims [30] | depends on the model; needs re-ranking and higher `ef_search` | medium |
| Subvector (Matryoshka) + re-rank | proportional to dimensions dropped | model must support it | medium |
| Fewer dimensions from the API | proportional | small, model-dependent | low, but requires re-embedding |

## 9. Hybrid search: keywords + vectors

### 9.1 Why hybrid

Vector search finds paraphrases ("get my money back" → "refund policy") but is weak on exact tokens: product codes, error numbers, names, rare words. Keyword search is the opposite. Running both and **fusing** the two ranked lists gives results that are both directly and contextually relevant [38]. For RAG, hybrid retrieval is the usual default.

### 9.2 Reciprocal Rank Fusion (RRF)

RRF ignores raw scores and uses only ranks: each list gives a row `1 / (k + rank)`, and the contributions are summed. `k = 60` comes from the original paper, where it was "near-optimal, but … not critical" [36]. Because only ranks are used, you never have to compare a `ts_rank` value with a cosine distance. One caveat: a later study found RRF more sensitive to its parameters than first reported, and a tuned weighted sum of normalized scores (convex combination) beat it when a few labeled queries were available [37].

Complete query: top 10 chunks for one tenant, keyword list and vector list of 50 each, RRF with k = 60.

```sql
-- $1 = user query text, $2 = query embedding (same model as the stored vectors), $3 = tenant id
BEGIN;
SET LOCAL hnsw.ef_search = 100;                 -- >= the vector branch LIMIT
SET LOCAL hnsw.iterative_scan = strict_order;   -- the tenant filter is a post-filter for HNSW;
                                                -- strict keeps exact distance order for the ranks

WITH keyword AS (
  SELECT c.id,
         row_number() OVER (ORDER BY ts_rank_cd(c.search_tsv, q) DESC) AS kw_rank
  FROM chunks AS c,
       websearch_to_tsquery('english', $1) AS q
  WHERE c.tenant_id = $3
    AND c.search_tsv @@ q                       -- GIN index
  ORDER BY kw_rank
  LIMIT 50
),
semantic AS (
  SELECT id,
         row_number() OVER (ORDER BY distance) AS vec_rank
  FROM (
    SELECT c.id, c.embedding <=> $2 AS distance
    FROM chunks AS c
    WHERE c.tenant_id = $3
    ORDER BY distance                           -- HNSW index (ORDER BY … LIMIT shape)
    LIMIT 50
  ) AS nearest
),
fused AS (
  SELECT coalesce(k.id, s.id) AS id,
         coalesce(1.0 / (60 + k.kw_rank), 0)
       + coalesce(1.0 / (60 + s.vec_rank), 0) AS rrf_score,
         k.kw_rank,
         s.vec_rank
  FROM keyword AS k
  FULL OUTER JOIN semantic AS s ON s.id = k.id
)
SELECT c.id, c.document_id, c.chunk_index, c.content,
       f.rrf_score, f.kw_rank, f.vec_rank        -- keep both ranks: useful for debugging
FROM fused AS f
JOIN chunks AS c ON c.id = f.id
ORDER BY f.rrf_score DESC, c.id
LIMIT 10;
COMMIT;
```

Notes:

- `FULL OUTER JOIN` keeps rows found by only one method; `coalesce(…, 0)` gives them 0 for the other list [38][39].
- The candidate depth (50 per list here) matters more than k: a row that is not in either list cannot be found. The pgvector example uses 20 per list and Supabase's function up to 60 [38][39]; tune it with your evaluation set.
- The keyword branch still ranks **every** match (section 2.8). With very common words this is the slowest part; a BM25 extension with top-k scans replaces it with `ORDER BY content <@> $1 LIMIT 50` (`pg_textsearch`) or `WHERE content ||| $1 ORDER BY pdb.score(id) DESC LIMIT 50` (ParadeDB).
- Wrap the query in a SQL function if several services need it (Supabase's `hybrid_search` function is a good template; it uses `rrf_k = 50` and inner product) [38].
- With `relaxed_order` instead of `strict_order`, the vector branch may return rows slightly out of distance order, and the outer `row_number() OVER (ORDER BY distance)` can reuse the subquery's order without re-sorting (the same reason the README adds `+ 0` after a materialized CTE on PG 17+ [26]). Harmless for RRF; use `strict_order` (as here) or `ORDER BY distance + 0` when exact ranks matter.

### 9.3 Weighted fusion

To favor one method, multiply each RRF term by a weight (Supabase exposes `full_text_weight` and `semantic_weight`) [38]:

```sql
  coalesce(1.0 / (60 + k.kw_rank), 0) * 1.0     -- full_text_weight
+ coalesce(1.0 / (60 + s.vec_rank), 0) * 1.5     -- semantic_weight
```

**Score fusion** (min-max normalize each score to 0..1, then `α · vector_score + (1 − α) · keyword_score`) can beat RRF when α is tuned on labeled queries [37]. Without an evaluation set, prefer RRF: it needs no score normalization and no tuning.

### 9.4 Re-ranking with a cross-encoder (outside the database)

A **cross-encoder** reads the query and each candidate text together and outputs a relevance score. It is more accurate than embedding distance but too slow to run on the whole corpus. Pattern: hybrid retrieval returns a few dozen candidates → the application sends `(query, chunk)` pairs to a re-ranking model (local or hosted) → keep only the best few for the LLM prompt [26][39]. PostgreSQL's job ends at producing good candidates; store the re-ranker name/version in your logs so results are reproducible.

## 10. RAG schema design

### 10.1 Documents and chunks

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     bigint      NOT NULL,
  source_uri    text        NOT NULL,              -- file path, URL, external id
  title         text,
  lang          text        NOT NULL DEFAULT 'en',   -- language code; not regconfig (pg_upgrade, section 2.10)
  content_hash  bytea       NOT NULL,              -- sha256 of the source: skip unchanged files
  metadata      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_uri)
);

CREATE TABLE chunks (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id    bigint      NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  tenant_id      bigint      NOT NULL,             -- copied from documents: filters, RLS, partitioning
  chunk_index    integer     NOT NULL,             -- order inside the document: 0, 1, 2, ...
  content        text        NOT NULL,
  token_count    integer     NOT NULL CHECK (token_count > 0),
  content_hash   bytea       NOT NULL,             -- sha256(content): de-duplication, embedding cache key
  metadata       jsonb       NOT NULL DEFAULT '{}',-- page, heading path, section title, ...
  search_tsv     tsvector    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding      vector(1536),                     -- NULL until the embedding worker fills it
  embedding_model text,                            -- e.g. 'text-embedding-3-small'
  embedding_model_version text,                    -- your tag: provider version, date, preprocessing
  embedded_at    timestamptz,
  UNIQUE (document_id, chunk_index),
  CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);

CREATE INDEX chunks_tenant_idx ON chunks (tenant_id);
CREATE INDEX chunks_search_tsv_idx ON chunks USING gin (search_tsv);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);  -- after the initial bulk load
-- chunks (document_id) is already covered by the UNIQUE (document_id, chunk_index) index
```

Why each column exists:

| Column | Purpose |
|---|---|
| `chunk_index` | rebuild context (neighbor chunks), stable ordering, idempotent re-chunking via `UNIQUE (document_id, chunk_index)` |
| `token_count` | budget the LLM context window without re-tokenizing; find oversize chunks |
| `content_hash` | skip re-embedding unchanged chunks; reuse embeddings for identical text; detect duplicates |
| `metadata jsonb` | citations (page, heading), filters; keep hot filters as real columns with B-tree indexes |
| `embedding_model`, `embedding_model_version` | never mix vectors from different models; know what to re-embed |
| `tenant_id` (denormalized) | cheap filters, RLS policies with leakproof equality, partitioning |
| `search_tsv` | keyword branch of hybrid search |

Design notes:

- **Chunk size and overlap** are application decisions; measure them with your evaluation set, and record the chunking settings (for example in a `chunking_version` column) so you can re-chunk deliberately.
- **Language per document:** if you index several languages, compute `search_tsv` with the document's configuration (section 2.10), which means copying `lang` to `chunks`.
- **Keep hot metadata filters as columns.** A `jsonb @>` filter needs a GIN index, does not combine well with HNSW, and is not leakproof under RLS (section 7.4).
- **ORMs:** Prisma has no native vector type (`Unsupported("vector(1536)")`), uses raw SQL for vector queries, and `prisma migrate dev` does not handle pgvector indexes [44]; write vector indexes as raw SQL migrations. See [Postgres from TypeScript](15-postgres-from-typescript.md).

### 10.2 De-duplication with content hashes

```sql
-- Re-ingesting a document: skip chunks whose text did not change
INSERT INTO chunks (document_id, tenant_id, chunk_index, content, token_count, content_hash, metadata)
VALUES ($1, $2, $3, $4, $5, sha256(convert_to($4, 'UTF8')), $6)
ON CONFLICT (document_id, chunk_index) DO UPDATE
  SET content = EXCLUDED.content,
      token_count = EXCLUDED.token_count,
      content_hash = EXCLUDED.content_hash,
      metadata = EXCLUDED.metadata,
      embedding = NULL, embedding_model = NULL,           -- force re-embedding
      embedding_model_version = NULL, embedded_at = NULL
  WHERE chunks.content_hash IS DISTINCT FROM EXCLUDED.content_hash;   -- unchanged text: no write
```

`sha256()` is built in (PG 11+). Delete chunks beyond the new last `chunk_index` in the same transaction. For upsert details see [query patterns](04-query-patterns-and-antipatterns.md). An embedding cache keyed by `(embedding_model, embedding_model_version, content_hash)` avoids paying twice for identical text across documents.

### 10.3 Several embedding models side by side

| Design | How | Pros | Cons |
|---|---|---|---|
| Column per model on `chunks` | `embedding_v2 halfvec(3072)` + its own index | simple queries, typed columns | wide table; adding a model = `ALTER TABLE` |
| **Table per model** (recommended for migrations) | `chunk_embeddings_te3l (chunk_id PK/FK, embedding halfvec(3072))` | typed; build/drop independently; old model dropped instantly | one more join |
| One generic table, untyped `vector` | `(chunk_id, model, embedding vector)` + partial expression index per model | flexible | every query must repeat the cast and the literal predicate |

The generic form from the pgvector FAQ [26]:

```sql
CREATE TABLE chunk_embeddings (
  chunk_id  bigint NOT NULL REFERENCES chunks (id) ON DELETE CASCADE,
  model_id  integer NOT NULL,                     -- id in your own embedding-model lookup table
  embedding vector NOT NULL,                      -- no dimension: models differ
  PRIMARY KEY (chunk_id, model_id)
);
CREATE INDEX ON chunk_embeddings USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
  WHERE (model_id = 2);                           -- one index per model, literal predicate

SELECT chunk_id FROM chunk_embeddings
WHERE model_id = 2                                -- literal, matches the partial index
ORDER BY embedding::vector(1024) <=> $1::vector(1024)
LIMIT 10;
```

### 10.4 Re-embedding migrations (new model)

1. Create the new storage (table per model, or a new column) — no index yet.
2. Backfill in batches from a worker, ordered by `chunk_id`, idempotent (`ON CONFLICT DO NOTHING`); new and changed chunks are embedded with **both** models during the migration.
3. Build the new HNSW index `CONCURRENTLY` after the backfill (section 6.4).
4. Evaluate on a set of real queries (recall@k against exact search, and answer quality).
5. Switch reads behind a feature flag. The **query** embedding must come from the new model too.
6. Stop writing the old model; drop its index and table.

Never update vectors of the old model in place to the new model under the same index: during the backfill the index would mix two vector spaces and return nonsense.

### 10.5 Permissions and deletes

- **Permission filtering:** enforce it in the database, not only in the app. RLS on `chunks` (policy on `tenant_id` or document access) is the safety net; see [security](11-security.md) and the RLS caveats in section 7.4. Remember that BM25 statistics may include rows the user cannot see (section 3.3).
- **Cascading deletes:** `ON DELETE CASCADE` from `documents` to `chunks` (and to per-model embedding tables) removes everything in one statement. Index every foreign-key column on the child side (the `UNIQUE (document_id, chunk_index)` and primary keys above do this), or each parent delete scans the child table. Deleted vectors stay in the HNSW index as dead entries until `VACUUM` (section 11.3).
- **Right to erasure:** after deleting a user's documents, run `VACUUM` (and consider `REINDEX CONCURRENTLY` on the vector index) so the vectors are physically removed; backups keep them until they expire (see [operations](09-operations-and-server-tuning.md)).

Queue tables for the embedding worker, soft delete and audit patterns are in [schema design](07-schema-design-and-patterns.md).

## 11. Performance and operations

### 11.1 Keep the vector index in memory

HNSW search jumps between random pages of the graph; when those pages must come from disk, latency rises sharply. Indexes do not *have* to fit in memory, but they perform better when they do, and Crunchy Data recommends keeping the whole HNSW index in memory [26][33].

```sql
SELECT pg_size_pretty(pg_relation_size('chunks_embedding_idx'));      -- index size

-- Load it into shared buffers after a restart or failover
CREATE EXTENSION IF NOT EXISTS pg_prewarm;
SELECT pg_prewarm('chunks_embedding_idx');                            -- returns blocks read
```

- Size RAM for "index + hot table data + working memory". `shared_buffers` is typically about 25% of RAM; the OS page cache holds more [26] (see [operations](09-operations-and-server-tuning.md)).
- `pg_prewarm` can also run automatically: with `shared_preload_libraries = 'pg_prewarm'`, a background worker saves the list of cached blocks every 300 s (default) and reloads it at startup [35].
- Prewarmed pages get no special protection from eviction [35]: if the index is bigger than the cache, prewarming does not help. Shrink the index (section 8) or add memory.
- In `EXPLAIN (ANALYZE, BUFFERS)`, many `shared read` blocks on the index scan mean the index is not cached.

### 11.2 Avoid computing distances more than needed

- Write the distance once (`embedding <=> $1 AS distance … ORDER BY distance`); the index computes distances during traversal and the select list computes it again only for the returned rows.
- Do not filter on the distance in the same query level as the ordered index scan; use the materialized-CTE pattern (section 5.4) [26][34].
- Do not compute vector distances for every keyword match in hybrid search; fuse two independent top-k lists instead (section 9).
- In re-ranking queries, the full-precision distance runs only on the shortlist (the inner `LIMIT`), never on the whole table.

### 11.3 Vacuum and maintenance

- `UPDATE` and `DELETE` leave dead index entries; HNSW scans can return fewer rows until `VACUUM` cleans them [26].
- Vacuuming an HNSW index can take a long time. For a large cleanup, rebuild first: `REINDEX INDEX CONCURRENTLY chunks_embedding_idx;` then `VACUUM chunks;` [26].
- Keep pgvector ≥ 0.8.4 (HNSW vacuum corruption and error fixes) [27].
- Re-embedding a whole table rewrites every row: expect large WAL volume, replication lag and bloat; batch it and let autovacuum keep up (tuning in [operations](09-operations-and-server-tuning.md)).
- IVFFlat indexes need periodic rebuilds as data drifts (section 6.2).

### 11.4 Bulk loading

```sql
-- Fastest: COPY, then build indexes
COPY chunks (document_id, tenant_id, chunk_index, content, token_count, content_hash, embedding)
FROM STDIN WITH (FORMAT BINARY);
```

`COPY … (FORMAT BINARY)` is the fastest path [26]; drivers must encode vectors in pgvector's binary format (the Python library does). From Node.js, the pgvector-node example streams **text** `COPY` with `pg-copy-streams` and `pgvector.toSql()` [44] — still far faster than row-by-row `INSERT`s. For the initial load: create the table without the vector index, `COPY`, then `CREATE INDEX` with a large `maintenance_work_mem` (section 6.4).

### 11.5 Recall vs latency: tune `ef_search` with measurements

1. Collect a representative sample of real query embeddings (from logs, not invented questions).
2. For each, compute the exact top k and the approximate top k.
3. recall@k = |approx ∩ exact| / k, averaged over the sample.
4. Increase `hnsw.ef_search` (or `ivfflat.probes`) until recall is good enough for your product; record latency (p95/p99) at each value.

```sql
-- recall@10 for one query vector $1 (run in a transaction with your production settings)
WITH approx AS (
  SELECT id FROM chunks ORDER BY embedding <=> $1 LIMIT 10                 -- HNSW
),
exact AS (
  SELECT id FROM chunks ORDER BY (embedding <=> $1) + 0 LIMIT 10           -- expression: no index, exact
)
SELECT count(a.id)::float8 / 10 AS recall_at_10
FROM exact AS e
LEFT JOIN approx AS a USING (id);
```

The pgvector README suggests the same comparison with `SET LOCAL enable_indexscan = off` for the exact side [26]. Re-measure after changing models, quantization, index parameters, or filters (filtered queries usually have lower recall). Recall is not answer quality: also evaluate retrieval with labeled questions.

### 11.6 Checklist for a slow vector query

| Symptom | Likely cause | Fix |
|---|---|---|
| `Seq Scan` + `Sort` | no `LIMIT`, `ORDER BY` on an expression or DESC, opclass ≠ operator, small table | section 5.4 shape; matching opclass |
| Fewer rows than `LIMIT` | `ef_search` < k, filter/RLS post-filtering, dead tuples | raise `ef_search`, iterative scan, `VACUUM` |
| Index scan but slow | index not in memory (`shared read` high) | halfvec/BQ, more RAM, `pg_prewarm` |
| Good speed, bad results | wrong distance, mixed models, low recall | check opclass/model, measure recall |
| Fast in dev, slow in prod | dev runs as table owner (RLS bypassed) | `EXPLAIN` as the application role (section 7.4) |

## 12. Ecosystem and when to leave PostgreSQL

### 12.1 Other vector extensions (status October 2026)

| Project | What it is | License | Status |
|---|---|---|---|
| `pgvector` | the standard: types, HNSW, IVFFlat | PostgreSQL License | active; 0.8.7 (2026-10-01) [27] |
| `pgvectorscale` (Tiger Data) | StreamingDiskANN index (`USING diskann`) on pgvector types, Statistical Binary Quantization, label filtering on `smallint[]` | PostgreSQL License | active; 0.9.1 (2026-09-04) [45] |
| VectorChord (TensorChord) | `vchordrq` index (lists, like IVF, with RaBitQ quantization) and `vchordg` disk-based graph index, on pgvector types; successor of `pgvecto.rs` | AGPL-3.0 or ELv2 | active; 1.1.1 (2026-02-28) [46] |
| ParadeDB `pg_search` | vector search inside the ParadeDB index | AGPL-3.0 | beta since 0.25.0 [47] |
| `pgai` (Timescale) | Python library/extension for embedding pipelines | PostgreSQL License | **archived**: "As of February 2026, this project is no longer being maintained or supported" [48] |
| Lantern | `lantern_hnsw` index (usearch) | AGPL-3.0 | inactive: last release v0.5.0 (Nov 2024), no commits since Dec 2024 [49] |
| `pg_embedding` (Neon) | early HNSW extension | Apache-2.0 | **archived**; Neon stopped work on 2023-09-29 and recommends pgvector [50] |

`pgvectorscale` details [45]: `CREATE EXTENSION vectorscale CASCADE` installs pgvector; it supports `<=>`, `<->` and `<#>`; filtered label search uses `labels smallint[]` in the index and the `&&` operator; ordering is relaxed (use a materialized CTE for strict order); unlogged tables are not supported; tuning with `diskann.query_search_list_size` (default 100) and `diskann.query_rescore` (default 50). Vendor benchmarks for these extensions exist; reproduce them on your data before deciding.

Adopt an alternative index only for a measured problem (index too big for RAM, build too slow, filtered recall too low) and check that your hosting allows the extension.

### 12.2 When PostgreSQL is enough — and when it is not

Stay in PostgreSQL when:

- The vector index (after `halfvec` or quantization, section 8) fits in the RAM of one server, and one server (plus read replicas) handles the query rate.
- You need **transactions** (a document and its chunks appear and disappear atomically), **joins** with application data, **permissions** with RLS, and **one system** to back up, monitor and secure.
- Filters are mostly by tenant, document or a few categories (partitioning, partial indexes, iterative scans cover them).

Consider a dedicated engine (Elasticsearch/OpenSearch, Qdrant, Vespa, …) when you measure needs PostgreSQL cannot meet:

- Vector counts or query rates beyond one large node's memory, with a need to shard and replicate the search tier independently.
- Heavy filtered vector search on many dynamic attributes: some engines build filter-aware indexes (Qdrant adds filter-aware HNSW edges for indexed payload fields and estimates filter cardinality [51]).
- Rich search features at scale: many language analyzers, synonyms, typo tolerance, facets, learning-to-rank.
- Isolation: index builds and re-embedding must not compete with OLTP traffic (a read replica dedicated to search is the intermediate step).

The price of a second system: a synchronization pipeline (outbox/CDC — see [schema design](07-schema-design-and-patterns.md)), eventual consistency, duplicated permission logic, and another service to operate.

## Sources

1. [12.1 Introduction (Full Text Search)](https://www.postgresql.org/docs/current/textsearch-intro.html) — PostgreSQL 18 docs: why `LIKE`/regex are not enough, lexemes, `tsvector`/`tsquery`, `@@`.
2. [12.2 Tables and Indexes](https://www.postgresql.org/docs/current/textsearch-tables.html) — PostgreSQL 18 docs: expression indexes, generated `tsvector` column, two-argument rule.
3. [12.6 Dictionaries](https://www.postgresql.org/docs/current/textsearch-dictionaries.html) — PostgreSQL 18 docs: stop words, simple and Snowball dictionaries, dictionary order, reindexing.
4. [PostgreSQL 18 release notes](https://www.postgresql.org/docs/release/18.0/) — postgresql.org: parallel GIN builds, Estonian stemmer, FTS collation change.
5. [PostgreSQL 19 release notes (beta)](https://www.postgresql.org/docs/19/release-19.html) — postgresql.org: Polish/Esperanto stemmers, Dutch stemmer update.
6. [F.48 unaccent](https://www.postgresql.org/docs/current/unaccent.html) — PostgreSQL 18 docs: filtering dictionary, French configuration example.
7. [unaccent--1.1.sql (REL_18_STABLE)](https://github.com/postgres/postgres/blob/REL_18_STABLE/contrib/unaccent/unaccent--1.1.sql) — PostgreSQL source: `unaccent()` is `STABLE`.
8. [PostgreSQL 17 release notes](https://www.postgresql.org/docs/release/17.0/) — postgresql.org: unaccent rules syntax change.
9. [12.3 Controlling Text Search](https://www.postgresql.org/docs/current/textsearch-controls.html) — PostgreSQL 18 docs: query functions, ranking, weights, normalization, `ts_headline`, XSS warning.
10. [5.4 Generated Columns](https://www.postgresql.org/docs/18/ddl-generated-columns.html) — PostgreSQL 18 docs: virtual is the default kind.
11. [indexcmds.c (REL_18_STABLE)](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/indexcmds.c) — PostgreSQL source: "indexes on virtual generated columns are not supported".
12. [12.9 Preferred Index Types for Text Search](https://www.postgresql.org/docs/current/textsearch-indexes.html) — PostgreSQL 18 docs: GIN vs GiST, `siglen`.
13. [12.11 Limitations](https://www.postgresql.org/docs/current/textsearch-limitations.html) — PostgreSQL 18 docs: size limits.
14. [pg_textsearch README](https://github.com/timescale/pg_textsearch) — Tiger Data: BM25 index, syntax, limits, versions.
15. [VectorChord-bm25 README](https://github.com/tensorchord/VectorChord-bm25) — TensorChord: `bm25vector`, tokenizers, `bm25_limit`, dual AGPL/ELv2 license, release 0.3.0.
16. [pg_textsearch 1.0: How We Built a BM25 Search Engine on Postgres Pages](https://www.tigerdata.com/blog/pg-textsearch-bm25-full-text-search-postgres) — Tiger Data (Todd J. Green, 2026-03-31): IDF, saturation, length normalization vs `ts_rank`.
17. [pg_textsearch releases](https://github.com/timescale/pg_textsearch/releases) — GitHub: v1.0.0 (2026-03-27) to v1.5.1 (2026-10-02), PostgreSQL License.
18. [ParadeDB repository and releases](https://github.com/paradedb/paradedb) — GitHub: AGPL-3.0, v0.26.0 (2026-10-03), Tantivy-based.
19. [ParadeDB: Create an Index](https://www.paradedb.com/docs/reference/indexing/create-index) — ParadeDB docs: `USING paradedb`, `bm25` alias since 0.25.0, `key_field`, k1/b.
20. [ParadeDB: Match / Phrase / Term / BM25 Scoring / Query builder](https://www.paradedb.com/docs/reference/full-text/match) — ParadeDB docs: `|||`, `&&&`, `###`, `===`, `@@@`, `pdb.score()`; install page: PG 15+, `shared_preload_libraries`.
21. [pg_search (deprecated) and lakebase_text](https://neon.com/docs/extensions/pg_search) — Neon docs: pg_search deprecated 2026-03-19, retired 2026-09-21; `lakebase_bm25` index, PG 16+.
22. [Extension versions for Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html) — AWS docs: available extensions (pgvector 0.8.2, pg_trgm, pg_bigm, rum).
23. [Rename pg_bm25 to pg_search (PR #985)](https://github.com/paradedb/paradedb/pull/985) — GitHub: rename in March 2024.
24. [F.35 pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) — PostgreSQL 18 docs: functions, operators, thresholds, GIN/GiST, LIKE/regex, spelling suggestions.
25. [pg_bestmatch.rs](https://github.com/tensorchord/pg_bestmatch.rs) — GitHub: last release v0.0.1 (2024-10-10).
26. [pgvector README](https://github.com/pgvector/pgvector) — Andrew Kane / pgvector: types, limits, operators, HNSW/IVFFlat options, filtering, iterative scans, quantization, subvectors, performance, troubleshooting, FAQ.
27. [pgvector CHANGELOG](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md) — pgvector: 0.8.7 (2026-10-01), HNSW vacuum fixes in 0.8.3/0.8.4, features per version.
28. [pgvector source: hnsw.h, hnsw.c, ivfflat.h, ivfflat.c, sparsevec.h](https://github.com/pgvector/pgvector/tree/master/src) — pgvector: parameter ranges, `ef_construction ≥ 2 × m`, iterative-scan enum values, dimension limits.
29. [Vector embeddings guide](https://developers.openai.com/api/docs/guides/embeddings) — OpenAI docs: normalized embeddings, cosine recommendation, model dimensions, `dimensions` parameter and re-normalization.
30. [Scalar and Binary Quantization for Pgvector Vector Search and Storage](https://jkatz05.com/post/postgres/pgvector-scalar-binary-quantization/) — Jonathan Katz (2024-04-09): halfvec and bit index sizes, build times, recall, re-ranking.
31. [Supercharging vector search performance and relevance with pgvector 0.8.0 on Amazon Aurora PostgreSQL](https://aws.amazon.com/blogs/database/supercharging-vector-search-performance-and-relevance-with-pgvector-0-8-0-on-amazon-aurora-postgresql/) — AWS (Shayon Sanyal, 2025-05-28): overfiltering, iterative scan modes.
32. [Optimize generative AI applications with pgvector indexing: a deep dive into IVFFlat and HNSW](https://aws.amazon.com/blogs/database/optimize-generative-ai-applications-with-pgvector-indexing-a-deep-dive-into-ivfflat-and-hnsw-techniques/) — AWS (2024-03-15): IVFFlat needs data first, may need rebuilds.
33. [HNSW Indexes with Postgres and pgvector](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector) — Crunchy Data: index size (~8 GB per 1M embeddings), keep in memory, `ef_search` caps results.
34. [ORDER BY operator index scans and filtering](https://www.postgresql.org/message-id/flat/CAOdR5yGUoMQ6j7M5hNUXrySzaqZVGf_Ne%2B8fwZMRKTFxU1nbJg%40mail.gmail.com) — pgsql-hackers (Andrew Kane): distance filter + ordered index scan scans the whole index.
35. [F.30 pg_prewarm](https://www.postgresql.org/docs/current/pgprewarm.html) — PostgreSQL 18 docs: prewarm modes, autoprewarm, interval default, no eviction protection.
36. [Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) — Cormack, Clarke, Büttcher (SIGIR 2009): RRF formula, k = 60 near-optimal but not critical.
37. [An Analysis of Fusion Functions for Hybrid Retrieval](https://arxiv.org/abs/2210.11934) — Bruch, Gai, Ingber (2022/2023): convex combination beats RRF when tuned; RRF sensitive to parameters.
38. [Hybrid search](https://supabase.com/docs/guides/ai/hybrid-search) — Supabase docs: RRF function with CTEs, weights, `rrf_k`, GIN + HNSW indexes.
39. [pgvector-python hybrid search examples (rrf.py, cross_encoder.py)](https://github.com/pgvector/pgvector-python/tree/master/examples/hybrid_search) — pgvector: RRF with k = 60, cross-encoder re-ranking.
40. [RAG with Permissions](https://supabase.com/docs/guides/ai/rag-with-permissions) — Supabase docs: RLS on document sections for vector search.
41. [CREATE FUNCTION — LEAKPROOF](https://www.postgresql.org/docs/current/sql-createfunction.html) — PostgreSQL 18 docs: policies evaluated before non-leakproof user conditions.
42. [restrictinfo.c / indxpath.c (REL_18_STABLE)](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/optimizer/path/indxpath.c) — PostgreSQL source: non-promotable (non-leakproof) clauses are rejected as index quals.
43. [pg_proc.dat (REL_18_STABLE)](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/include/catalog/pg_proc.dat) — PostgreSQL source: `proleakproof` flags of `int8eq`, `texteq`, `uuid_eq` (true) vs `ts_match_vq`, `jsonb_contains`, `textlike` (false); volatility of `to_tsvector` variants.
44. [pgvector-node README and loading example](https://github.com/pgvector/pgvector-node) — pgvector: Prisma `Unsupported("vector(n)")`, raw queries, migrate limitation, text `COPY` with pg-copy-streams.
45. [pgvectorscale README](https://github.com/timescale/pgvectorscale) — Tiger Data: StreamingDiskANN, SBQ, label filtering, parameters, relaxed ordering, 0.9.1.
46. [VectorChord README](https://github.com/tensorchord/VectorChord) and [indexing docs](https://docs.vectorchord.ai/vectorchord/usage/indexing.html) — TensorChord: `vchordrq` lists + RaBitQ, `vchordg` graph index, pgvector compatibility, dual license, 1.1.1.
47. [ParadeDB: Hybrid Search](https://www.paradedb.com/docs/reference/hybrid/overview) — ParadeDB docs: vector search beta since 0.25.0.
48. [pgai README](https://github.com/timescale/pgai) — Timescale/Tiger Data: archived, unmaintained since February 2026.
49. [Lantern repository](https://github.com/lanterndata/lantern) — Lantern: last release v0.5.0 (2024-11-15), last push December 2024.
50. [pg_embedding README](https://github.com/neondatabase-labs/pg_embedding) — Neon: archived, not maintained since 2023-09-29, migrate to pgvector.
51. [Qdrant: Indexing](https://qdrant.tech/documentation/concepts/indexing/) — Qdrant docs: payload indexes, filter-aware HNSW edges, cardinality estimation.
52. [Does PostgreSQL support "accent insensitive" collations?](https://stackoverflow.com/questions/11005036/does-postgresql-support-accent-insensitive-collations) — Stack Overflow (Erwin Brandstetter): why `unaccent()` is STABLE, immutable wrapper pattern.
53. [ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html) — PostgreSQL 18 docs: adding a stored generated column rewrites the table and its indexes.
54. [planner.c `make_sort_input_target` (REL_18_STABLE)](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/optimizer/plan/planner.c) — PostgreSQL source: expensive select-list expressions postponed past Sort when a LIMIT exists; `ts_headline` procost 100 in `pg_proc.dat`.
55. [65.4 GIN Indexes](https://www.postgresql.org/docs/current/gin.html) — PostgreSQL 18 docs: GIN updates are slow by nature, pending list, `gin_pending_list_limit`.
56. [pg_upgrade](https://www.postgresql.org/docs/18/pgupgrade.html) — PostgreSQL 18 docs: databases with table columns of type `regconfig` (and other reg* types) cannot be upgraded.
57. [5.9 Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — PostgreSQL 18 docs: who bypasses RLS (superusers, `BYPASSRLS`, table owners without `FORCE`).
58. [RUM README](https://github.com/postgrespro/rum) — Postgres Professional: positions in the index, `<=>` ordering, faster ranking/phrase search, slower build/insert, license; release 1.3.15 (2025-10-23).
59. [PGroonga README](https://github.com/pgroonga/pgroonga) — PGroonga: full-text search for all languages, PostgreSQL License; release 4.0.9 (2026-09-23).
