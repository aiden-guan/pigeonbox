import type { SecretBox } from '../platform/crypto.js';

/** Shared summary decryption without depending on the thread/draft UI view. */
export async function decryptSummary(
  box: SecretBox,
  userId: string,
  row: {
    id: string;
    summary_key_id: string | null;
    summary_iv: string | null;
    summary_ciphertext: string | null;
  },
) {
  if (!row.summary_key_id || !row.summary_iv || !row.summary_ciphertext) return null;
  try {
    const parsed = JSON.parse(
      await box.open(
        { keyId: row.summary_key_id, iv: row.summary_iv, ciphertext: row.summary_ciphertext },
        { purpose: 'thread_summary', userId, recordId: row.id },
      ),
    ) as { perspectiveVersion?: number; oneLine?: string; keyPoints?: string[] };
    if (parsed.perspectiveVersion !== 1) return null;
    return { oneLine: String(parsed.oneLine ?? '').slice(0, 400), keyPoints: (parsed.keyPoints ?? []).map((point) => String(point).slice(0, 300)).slice(0, 8) };
  } catch {
    return null;
  }
}
