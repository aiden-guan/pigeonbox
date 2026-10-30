/**
 * Encryption at rest for secrets and sensitive user content.
 *
 * One abstraction for everything the server encrypts: Google refresh
 * tokens, PKCE verifiers in flight, prepared draft text, thread summaries,
 * commitments and opt-in Fast Recall excerpts. Callers never touch keys.
 *
 * - AES-256-GCM with a random 96-bit IV per value.
 * - Per-purpose subkeys derived with HKDF-SHA256 from master keys in
 *   `DATA_ENCRYPTION_KEYS` (`kid:base64,kid2:base64`; the first is active).
 *   Older keys stay listed for decryption until data is re-encrypted.
 * - Additional authenticated data binds each ciphertext to its purpose, owner
 *   and record, so a ciphertext copied onto another user's row fails to open.
 */

export type SealPurpose =
  | 'google_refresh_token'
  | 'oauth_verifier'
  | 'draft'
  | 'thread_summary'
  | 'commitment'
  | 'fast_recall'
  | 'briefing'
  | 'personal_memory'
  | 'note'
  | 'ask_feedback'
  | 'ask_approval'
  | 'document_token'
  | 'document_preview';

export type SealContext = { purpose: SealPurpose; userId: string; recordId: string };

export type Sealed = { keyId: string; iv: string; ciphertext: string };

export interface SecretBox {
  readonly activeKeyId: string;
  seal(plaintext: string, context: SealContext): Promise<Sealed>;
  open(sealed: Sealed, context: SealContext): Promise<string>;
  /** True when the value was sealed with a key that is no longer the active one. */
  needsRotation(sealed: Pick<Sealed, 'keyId'>): boolean;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type MasterKey = { id: string; key: Uint8Array<ArrayBuffer> };

/** Parse `kid:base64,kid:base64`. Each key must be 32 bytes. */
export function parseKeyring(value: string | undefined): MasterKey[] {
  if (!value?.trim()) return [];
  const keys: MasterKey[] = [];
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new CryptoError('DATA_ENCRYPTION_KEYS entries must look like kid:base64key');
    const id = entry.slice(0, separator);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new CryptoError('DATA_ENCRYPTION_KEYS key IDs must be 1-32 letters, digits, _ or -');
    let key: Uint8Array<ArrayBuffer>;
    try {
      key = fromBase64(entry.slice(separator + 1));
    } catch {
      throw new CryptoError(`DATA_ENCRYPTION_KEYS key ${id} is not base64`);
    }
    if (key.length !== 32) throw new CryptoError(`DATA_ENCRYPTION_KEYS key ${id} must be 32 bytes`);
    if (keys.some((existing) => existing.id === id)) throw new CryptoError(`DATA_ENCRYPTION_KEYS has duplicate key ID ${id}`);
    keys.push({ id, key });
  }
  return keys;
}

function aad(context: SealContext): Uint8Array<ArrayBuffer> {
  return encoder.encode(`pigeonbox|${context.purpose}|${context.userId}|${context.recordId}`);
}

export class WebCryptoSecretBox implements SecretBox {
  readonly activeKeyId: string;
  private readonly masters: Map<string, CryptoKey | Promise<CryptoKey>>;
  private readonly derived = new Map<string, Promise<CryptoKey>>();

  constructor(keys: MasterKey[]) {
    if (!keys.length) throw new CryptoError('No data encryption key is configured');
    this.activeKeyId = keys[0]!.id;
    this.masters = new Map(
      keys.map((entry) => [entry.id, crypto.subtle.importKey('raw', entry.key, 'HKDF', false, ['deriveKey'])] as const),
    );
  }

  private subkey(keyId: string, purpose: SealPurpose): Promise<CryptoKey> {
    const cacheKey = `${keyId}/${purpose}`;
    let existing = this.derived.get(cacheKey);
    if (!existing) {
      const master = this.masters.get(keyId);
      if (!master) throw new CryptoError('Unknown encryption key');
      existing = Promise.resolve(master).then((base) =>
        crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('pigeonbox/at-rest/v1'), info: encoder.encode(purpose) },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
      this.derived.set(cacheKey, existing);
    }
    return existing;
  }

  async seal(plaintext: string, context: SealContext): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.subkey(this.activeKeyId, context.purpose);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context) }, key, encoder.encode(plaintext)),
    );
    return { keyId: this.activeKeyId, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
  }

  async open(sealed: Sealed, context: SealContext): Promise<string> {
    if (!this.masters.has(sealed.keyId)) throw new CryptoError('The value was encrypted with a key that is not configured');
    try {
      const key = await this.subkey(sealed.keyId, context.purpose);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: aad(context) },
        key,
        fromBase64(sealed.ciphertext),
      );
      return decoder.decode(plain);
    } catch {
      // Wrong key, wrong owner/record binding or tampering. Never say which.
      throw new CryptoError('The value could not be decrypted');
    }
  }

  needsRotation(sealed: Pick<Sealed, 'keyId'>): boolean {
    return sealed.keyId !== this.activeKeyId;
  }
}

// ---------------------------------------------------------------------------
// Hashing and random tokens
// ---------------------------------------------------------------------------

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A 32-byte key as base64, for DATA_ENCRYPTION_KEYS. */
export function generateMasterKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}
