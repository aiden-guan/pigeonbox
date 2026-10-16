/** Snippets live in this browser's extension storage; Gmail reads them through the worker. */
const KEY = 'snippets';
const MAX_SNIPPETS = 200;
const MAX_BODY = 5000;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type StoredSnippet = { id: string; name: string; body: string };

/** Keep only well-formed snippets: a unique `;name`, a body, bounded sizes. */
export function cleanSnippets(input: unknown): StoredSnippet[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: StoredSnippet[] = [];
  for (const raw of input.slice(0, MAX_SNIPPETS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim().toLowerCase().replace(/^;/, '') : '';
    const body = typeof item.body === 'string' ? item.body.slice(0, MAX_BODY) : '';
    if (!NAME.test(name) || !body.trim() || seen.has(name)) continue;
    seen.add(name);
    const id = typeof item.id === 'string' && /^[\w-]{1,64}$/.test(item.id) ? item.id : crypto.randomUUID();
    out.push({ id, name, body });
  }
  return out;
}

export async function readSnippets(): Promise<StoredSnippet[]> {
  const stored = await chrome.storage.local.get(KEY);
  return cleanSnippets(stored[KEY]);
}

export async function writeSnippets(input: unknown): Promise<StoredSnippet[]> {
  const snippets = cleanSnippets(input);
  await chrome.storage.local.set({ [KEY]: snippets });
  return snippets;
}
