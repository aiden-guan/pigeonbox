import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { GOOGLE_ISSUERS, googleJwks } from './oauth.js';

/**
 * Gmail push notifications arrive through a Google Cloud Pub/Sub push
 * subscription configured with an OIDC token. Each request carries
 * `Authorization: Bearer <Google-signed JWT>`; we verify the signature, the
 * issuer, the audience we configured, and the service account that signs.
 *
 * The notification says only "mailbox X has history up to Y". It is treated as
 * a hint to sync: the sync job uses the account's own stored cursor and its own
 * credentials, so a forged or replayed notification can at most cause an
 * idempotent sync of an account that already exists.
 */

export class PushAuthError extends Error {
  constructor(readonly code: 'missing_token' | 'invalid_token' | 'wrong_audience' | 'wrong_signer') {
    super(code);
    this.name = 'PushAuthError';
  }
}

export type PushVerifyOptions = {
  audience: string;
  serviceAccountEmail: string;
  keys?: JWTVerifyGetKey;
  jwksUrl?: string;
};

export async function verifyPushRequest(request: Request, options: PushVerifyOptions): Promise<void> {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) throw new PushAuthError('missing_token');
  const token = header.slice(7).trim();
  let payload;
  try {
    ({ payload } = await jwtVerify(token, options.keys ?? googleJwks(options.jwksUrl ?? 'https://www.googleapis.com/oauth2/v3/certs'), {
      issuer: GOOGLE_ISSUERS,
      audience: options.audience,
    }));
  } catch (error) {
    const code = (error as { code?: string })?.code;
    throw new PushAuthError(code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' ? 'wrong_audience' : 'invalid_token');
  }
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!verified || payload.email !== options.serviceAccountEmail) throw new PushAuthError('wrong_signer');
}

const PushBodySchema = z.object({
  message: z.object({
    data: z.string().max(10_000),
    messageId: z.string().max(200).optional(),
    message_id: z.string().max(200).optional(),
    publishTime: z.string().max(64).optional(),
  }),
  subscription: z.string().max(500).optional(),
});

const NotificationSchema = z.object({
  emailAddress: z.string().min(3).max(320),
  historyId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]),
});

export type GmailPushNotification = { emailAddress: string; historyId: string; pubsubMessageId: string | null };

export function parsePushBody(body: unknown): GmailPushNotification {
  const parsed = PushBodySchema.parse(body);
  const decoded = JSON.parse(atob(parsed.message.data.replace(/-/g, '+').replace(/_/g, '/')));
  const notification = NotificationSchema.parse(decoded);
  return {
    emailAddress: notification.emailAddress.toLowerCase(),
    historyId: String(notification.historyId),
    pubsubMessageId: parsed.message.messageId ?? parsed.message.message_id ?? null,
  };
}
