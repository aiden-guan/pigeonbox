import MiniSearch from 'minisearch';
import { isSearchableTerm } from './ask-query.js';

export * from './ask-query.js';

export type SearchDoc = {
  id: string;
  threadId: string;
  subject: string;
  text: string;
  senders: string;
  recipients: string;
  labels: string;
  timestamp: string;
  fingerprint: string;
  quality?: 'ROW_STUB' | 'THREAD_PARTIAL' | 'THREAD_COMPLETE';
};

export type SearchHit = {
  threadId: string;
  subject: string;
  score: number;
  source: 'lexical' | 'semantic' | 'hybrid';
  snippet?: string;
  quality?: 'ROW_STUB' | 'THREAD_PARTIAL' | 'THREAD_COMPLETE';
};

export type CoverageInfo = {
  totalIndexedThreads: number;
  oldestIndexedDate: string | null;
  newestIndexedDate: string | null;
  state: string;
};

export function formatCoverageWarning(c: CoverageInfo): string {
  if (!c.totalIndexedThreads) {
    return 'No mail indexed yet. Coverage grows as you read Gmail.';
  }
  const since = c.oldestIndexedDate
    ? new Date(c.oldestIndexedDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : 'recently';
  return `Based on ${c.totalIndexedThreads.toLocaleString()} locally indexed threads since ${since}.`;
}

export class LexicalSearchIndex {
  private mini: MiniSearch<SearchDoc>;
  private docs = new Map<string, SearchDoc>();

  constructor() {
    this.mini = new MiniSearch({
      fields: ['subject', 'text', 'senders', 'recipients', 'labels'],
      storeFields: ['threadId', 'subject', 'timestamp', 'fingerprint', 'quality'],
      searchOptions: {
        boost: { subject: 3, senders: 2, recipients: 1.5 },
        // Filler words ("what", "have", "i") and short prefixes used to match nearly every thread.
        processTerm: (term) => {
          const lower = term.toLowerCase();
          return isSearchableTerm(lower) ? lower : null;
        },
        prefix: (term) => term.length >= 3,
        fuzzy: (term) => (term.length >= 5 ? 0.15 : false),
      },
    });
  }

  upsert(doc: SearchDoc): void {
    if (this.docs.has(doc.id)) {
      this.mini.discard(doc.id);
    }
    this.docs.set(doc.id, doc);
    this.mini.add(doc);
  }

  remove(id: string): void {
    if (this.docs.has(id)) {
      this.mini.discard(id);
      this.docs.delete(id);
    }
  }

  clear(): void {
    this.mini.removeAll();
    this.docs.clear();
  }

  search(query: string, limit = 20): SearchHit[] {
    if (!query.trim()) return [];
    const results = this.mini.search(query);
    return results.slice(0, limit).map((r) => {
      const quality = r.quality as SearchHit['quality'];
      const stub = quality === 'ROW_STUB';
      return {
        threadId: String(r.threadId),
        subject: String(r.subject),
        score: stub ? r.score * 0.25 : r.score,
        source: 'lexical' as const,
        quality,
      };
    });
  }

  size(): number {
    return this.docs.size;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export type EmbeddingRecord = {
  fingerprint: string;
  threadId: string;
  subject: string;
  vector: number[];
  timestamp: string;
};

/**
 * Hybrid retrieval: lexical + semantic + recency + contact relevance.
 * Top-k only — never send entire mailbox to the model.
 */
export class HybridRetriever {
  constructor(
    private readonly lexical: LexicalSearchIndex,
    private readonly embeddings: EmbeddingRecord[],
  ) {}

  retrieve(opts: {
    query: string;
    queryEmbedding?: number[];
    contactEmail?: string;
    limit?: number;
  }): SearchHit[] {
    const limit = opts.limit ?? 8;
    const lex = this.lexical.search(opts.query, limit * 2);
    const scores = new Map<string, SearchHit>();

    for (const h of lex) {
      scores.set(h.threadId, { ...h, score: h.score });
    }

    if (opts.queryEmbedding && this.embeddings.length) {
      const sem = this.embeddings
        .map((e) => ({
          threadId: e.threadId,
          subject: e.subject,
          score: cosineSimilarity(opts.queryEmbedding!, e.vector),
          source: 'semantic' as const,
          timestamp: e.timestamp,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit * 2);
      for (const s of sem) {
        const prev = scores.get(s.threadId);
        const recencyBoost = recencyScore(s.timestamp);
        const combined = (prev?.score || 0) * 0.5 + s.score * 0.4 + recencyBoost * 0.1;
        scores.set(s.threadId, {
          threadId: s.threadId,
          subject: s.subject,
          score: combined,
          source: 'hybrid',
        });
      }
    }

    if (opts.contactEmail) {
      const contactHits = this.lexical.search(opts.contactEmail, 10);
      for (const h of contactHits) {
        const prev = scores.get(h.threadId);
        scores.set(h.threadId, {
          threadId: h.threadId,
          subject: h.subject,
          score: (prev?.score || 0) + 1.5,
          source: prev ? 'hybrid' : 'lexical',
        });
      }
    }

    return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function recencyScore(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / (86400_000);
  return Math.max(0, 1 - days / 365);
}

export class AskPigeonEngine {
  constructor(
    private readonly retriever: HybridRetriever,
    private readonly coverage: () => Promise<CoverageInfo>,
    private readonly answerFn: (input: {
      query: string;
      chunks: SearchHit[];
      coverageNote: string;
    }) => Promise<{ answer: string; citations: Array<{ threadId: string; subject: string }>; incompleteIndex: boolean }>,
  ) {}

  async ask(query: string, queryEmbedding?: number[]) {
    const coverage = await this.coverage();
    const coverageNote = formatCoverageWarning(coverage);
    const hits = this.retriever.retrieve({ query, queryEmbedding, limit: 8 });
    if (!hits.length) {
      return {
        answer: `No matching threads in the local index. ${coverageNote}`,
        citations: [] as Array<{ threadId: string; subject: string }>,
        incompleteIndex: true,
        coverageNote,
      };
    }
    const stubsOnly = hits.every((hit) => hit.quality === 'ROW_STUB');
    const result = await this.answerFn({ query, chunks: hits, coverageNote });
    const answer = stubsOnly
      ? `${result.answer}\n\nThese matches use inbox previews, not full messages.`
      : result.answer;
    return { ...result, answer, coverageNote };
  }
}
