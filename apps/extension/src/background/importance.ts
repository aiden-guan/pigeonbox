import {
  importanceFeatures,
  importanceModel,
  importanceReasons,
  importanceScore,
  learnImportance,
  type ImportanceModel,
  type ImportanceSignal,
  type MailboxDatabase,
  type ThreadRow,
} from '@pigeonbox/mailbox';

/** Stored in the mailbox settings table, next to the mail it learned from (cleared with it). */
const MODEL_KEY = 'importanceModel';

export type RankedThread = { importance: number; reasons: string[] };

/** Addresses the person has written to: their mail matters more than a stranger's. */
export function repliedToSet(threads: ThreadRow[]): Set<string> {
  const owners = new Set(threads.map((thread) => thread.mailboxEmail?.toLowerCase()).filter(Boolean));
  const out = new Set<string>();
  for (const thread of threads) {
    if (!thread.seenInSent && !thread.route?.startsWith('sent')) continue;
    for (const person of thread.participants) {
      const email = person.email.toLowerCase();
      if (!owners.has(email)) out.add(email);
    }
  }
  return out;
}

export function createImportanceRanker(db: MailboxDatabase, now: () => number = Date.now) {
  let cached: ImportanceModel | null = null;
  // One learning step at a time, so quick moves never overwrite each other.
  let chain: Promise<unknown> = Promise.resolve();

  async function model(): Promise<ImportanceModel> {
    if (!cached) cached = importanceModel((await db.settings.get(MODEL_KEY))?.value);
    return cached;
  }

  async function rank(matched: ThreadRow[], all: ThreadRow[]): Promise<Map<string, RankedThread>> {
    const current = await model();
    const repliedTo = repliedToSet(all);
    const classifications = await db.thread_classifications.bulkGet(matched.map((thread) => thread.threadId));
    const out = new Map<string, RankedThread>();
    matched.forEach((thread, index) => {
      const features = importanceFeatures({ ...thread, deadline: classifications[index]?.deadline }, { model: current, repliedTo, now: now() });
      out.set(thread.threadId, { importance: importanceScore(current, features), reasons: importanceReasons(current, features) });
    });
    return out;
  }

  function learn(threadId: string, signal: ImportanceSignal): Promise<void> {
    const step = chain.then(async () => {
      const thread = await db.threads.get(threadId);
      if (!thread) return;
      const current = await model();
      const [classification, all] = await Promise.all([db.thread_classifications.get(threadId), db.threads.toArray()]);
      const features = importanceFeatures({ ...thread, deadline: classification?.deadline }, { model: current, repliedTo: repliedToSet(all), now: now() });
      cached = learnImportance(current, features, signal, thread.latestSender?.email);
      await db.settings.put({ key: MODEL_KEY, value: cached });
    });
    chain = step.catch(() => undefined);
    return step;
  }

  /** Forget what was learned (the defaults stay). */
  async function reset(): Promise<void> {
    cached = null;
    await db.settings.delete(MODEL_KEY);
  }

  return { rank, learn, reset };
}
