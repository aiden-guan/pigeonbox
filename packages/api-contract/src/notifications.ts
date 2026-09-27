import { z } from 'zod';
import { GmailIdSchema, IdSchema, IsoSchema } from './common.js';

/**
 * In-product notifications from Cloud: approvals waiting, follow-ups due,
 * briefings ready, sync problems, team mentions. The extension polls this with
 * its existing alarm and shows desktop notifications the user enabled.
 */
export const NotificationKindSchema = z.enum([
  'approval',
  'follow_up_due',
  'briefing',
  'draft_ready',
  'sync_problem',
  'mention',
  'assignment',
  'engagement',
]);

export const NotificationSchema = z.object({
  id: IdSchema,
  kind: NotificationKindSchema,
  title: z.string().max(200),
  body: z.string().max(500),
  threadId: GmailIdSchema.nullable(),
  accountId: IdSchema.nullable(),
  /** Related record, e.g. an approval or briefing ID. */
  refId: IdSchema.nullable(),
  createdAt: IsoSchema,
  readAt: IsoSchema.nullable(),
});
export type CloudNotification = z.infer<typeof NotificationSchema>;

export const NotificationsRequestSchema = z.object({
  since: IsoSchema.optional(),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
});
export const NotificationsResponseSchema = z.object({ notifications: z.array(NotificationSchema).max(100), unread: z.number().int().nonnegative() });
export const NotificationsAckRequestSchema = z.object({ ids: z.array(IdSchema).min(1).max(100) });
