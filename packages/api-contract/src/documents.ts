import { z } from 'zod';
import { EmailAddressSchema, GmailIdSchema, IdSchema, InstantSchema, IsoSchema } from './common.js';

/**
 * Tracked documents: a PDF stored privately by PigeonBox Cloud and shared as
 * per-recipient links. Analytics only report what the PigeonBox viewer
 * observed; `precision` says what kind of observation backs each number.
 */
export const DocumentSummarySchema = z.object({
  id: IdSchema,
  title: z.string().max(300),
  filename: z.string().max(255),
  sizeBytes: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable(),
  status: z.enum(['uploading', 'ready', 'failed', 'deleted']),
  createdAt: IsoSchema,
  links: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
  lastViewedAt: IsoSchema.nullable(),
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const DocumentsResponseSchema = z.object({ documents: z.array(DocumentSummarySchema).max(500) });
export const DocumentCreateRequestSchema = z.object({ title: z.string().min(1).max(300), filename: z.string().min(1).max(255) });
export const DocumentResponseSchema = z.object({ document: DocumentSummarySchema });
/** Binary PUT, authenticated by the service worker; never accept a caller-provided upload URL. */
export function documentUploadPath(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid document ID');
  return `/v1/documents/${id}/content`;
}

export const DocumentLinkSchema = z.object({
  id: IdSchema,
  documentId: IdSchema,
  url: z.string().url().max(2_000),
  recipientEmail: z.string().max(320).nullable(),
  expiresAt: IsoSchema.nullable(),
  allowDownload: z.boolean(),
  watermark: z.boolean(),
  revokedAt: IsoSchema.nullable(),
  threadId: GmailIdSchema.nullable(),
  createdAt: IsoSchema,
});
export type DocumentLink = z.infer<typeof DocumentLinkSchema>;

export const DocumentLinkCreateRequestSchema = z.object({
  documentId: IdSchema,
  recipientEmail: EmailAddressSchema.optional(),
  expiresAt: InstantSchema.optional(),
  allowDownload: z.boolean().default(false),
  watermark: z.boolean().default(true),
  threadId: GmailIdSchema.optional(),
});
export const DocumentLinkResponseSchema = z.object({ link: DocumentLinkSchema });
export const DocumentLinkRevokeRequestSchema = z.object({ linkId: IdSchema });

export const DocumentLinkStatsSchema = z.object({
  link: DocumentLinkSchema,
  firstViewedAt: IsoSchema.nullable(),
  lastViewedAt: IsoSchema.nullable(),
  views: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  /** Seconds the viewer tab was visible and focused. Null when not observed. */
  visibleSeconds: z.number().int().nonnegative().nullable(),
  pages: z.array(z.object({ page: z.number().int().positive(), views: z.number().int().nonnegative(), visibleSeconds: z.number().int().nonnegative() })).max(500).nullable(),
  /**
   * `pages_observed`: the PigeonBox viewer rendered pages and saw them on screen.
   * `session_only`: the viewer opened but page visibility was not reported.
   * `download_only`: only the file was fetched; nothing is known about reading.
   * `none`: never opened.
   */
  precision: z.enum(['pages_observed', 'session_only', 'download_only', 'none']),
});
export const DocumentAnalyticsRequestSchema = z.object({ documentId: IdSchema });
export const DocumentAnalyticsResponseSchema = z.object({
  document: DocumentSummarySchema,
  links: z.array(DocumentLinkStatsSchema).max(500),
  notes: z.array(z.string().max(300)).max(6),
});
