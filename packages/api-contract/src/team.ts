import { z } from 'zod';
import { GmailIdSchema, IdSchema, IsoSchema, MailboxSelectorSchema, SourceRefSchema } from './common.js';

/**
 * Team collaboration. A shared thread is a permissioned PigeonBox record keyed
 * to the source Gmail thread; the Gmail thread itself is never copied into a
 * teammate's mailbox. The sharer chooses which fields teammates can see.
 */
export const WorkspaceRoleSchema = z.enum(['owner', 'admin', 'member']);

export const WorkspaceSummarySchema = z.object({
  id: IdSchema,
  name: z.string().max(120),
  role: WorkspaceRoleSchema,
  members: z.array(z.object({ userId: IdSchema, name: z.string().max(200), email: z.string().max(320), role: WorkspaceRoleSchema })).max(200),
});
export const WorkspacesResponseSchema = z.object({ workspaces: z.array(WorkspaceSummarySchema).max(50) });

export const SHARE_FIELDS = ['subject', 'participants', 'summary', 'state', 'commitments'] as const;
export const ShareFieldSchema = z.enum(SHARE_FIELDS);

export const CommentSchema = z.object({
  id: IdSchema,
  author: z.object({ userId: IdSchema, name: z.string().max(200) }),
  body: z.string().max(5_000),
  mentions: z.array(z.object({ userId: IdSchema, name: z.string().max(200) })).max(20),
  createdAt: IsoSchema,
  editedAt: IsoSchema.nullable(),
});

export const SharedThreadSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  workspaceName: z.string().max(120),
  threadId: GmailIdSchema,
  sharedBy: z.object({ userId: IdSchema, name: z.string().max(200) }),
  fields: z.array(ShareFieldSchema).max(SHARE_FIELDS.length),
  /** Only the fields the sharer chose. */
  subject: z.string().max(998).nullable(),
  participants: z.array(z.string().max(320)).max(50).nullable(),
  summary: z.string().max(400).nullable(),
  state: z.string().max(40).nullable(),
  assignment: z
    .object({
      id: IdSchema,
      assignee: z.object({ userId: IdSchema, name: z.string().max(200) }),
      status: z.enum(['open', 'done']),
      note: z.string().max(500).nullable(),
      updatedAt: IsoSchema,
    })
    .nullable(),
  comments: z.array(CommentSchema).max(200),
  sharedAt: IsoSchema,
});
export type SharedThread = z.infer<typeof SharedThreadSchema>;

export const ThreadTeamRequestSchema = MailboxSelectorSchema.extend({ threadId: GmailIdSchema });
export const ThreadTeamResponseSchema = z.object({ shares: z.array(SharedThreadSchema).max(20) });

export const AssignRequestSchema = MailboxSelectorSchema.extend({
  workspaceId: IdSchema,
  threadId: GmailIdSchema,
  assigneeUserId: IdSchema,
  fields: z.array(ShareFieldSchema).min(1).max(SHARE_FIELDS.length),
  note: z.string().max(500).optional(),
});
export const SharedThreadResponseSchema = z.object({ share: SharedThreadSchema });
export const AssignmentUpdateRequestSchema = z.object({ assignmentId: IdSchema, status: z.enum(['open', 'done']) });
export const CommentAddRequestSchema = z.object({
  shareId: IdSchema,
  body: z.string().min(1).max(5_000),
  mentions: z.array(IdSchema).max(20).default([]),
});

// ---------------------------------------------------------------------------
// AI snippets
// ---------------------------------------------------------------------------

/** Sources an AI directive in a snippet may read. Nothing else is available to it. */
export const SnippetSourceSchema = z.enum(['thread', 'calendar', 'contact', 'profile']);

export const SnippetSchema = z.object({
  id: IdSchema,
  name: z.string().max(120),
  /** Text with `{variable}` fields and `{AI: directive}` blocks. */
  body: z.string().max(10_000),
  scope: z.enum(['personal', 'workspace']),
  workspaceId: IdSchema.nullable(),
  variables: z.array(z.string().max(40)).max(30),
  directives: z.array(z.object({ prompt: z.string().max(500) })).max(10),
  allowedSources: z.array(SnippetSourceSchema).max(4),
  updatedAt: IsoSchema,
});
export type Snippet = z.infer<typeof SnippetSchema>;

export const SnippetsResponseSchema = z.object({ snippets: z.array(SnippetSchema).max(500) });
export const SnippetSaveRequestSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().min(1).max(120),
  body: z.string().min(1).max(10_000),
  workspaceId: IdSchema.nullable().default(null),
  allowedSources: z.array(SnippetSourceSchema).max(4).default(['thread', 'profile']),
});
export const SnippetResponseSchema = z.object({ snippet: SnippetSchema });
export const SnippetDeleteRequestSchema = z.object({ id: IdSchema });
export const SnippetRenderRequestSchema = MailboxSelectorSchema.extend({
  snippetId: IdSchema,
  threadId: GmailIdSchema.optional(),
  values: z.record(z.string().max(40), z.string().max(500)).default({}),
  timeZone: z.string().max(64).optional(),
});
export const SnippetRenderResponseSchema = z.object({
  text: z.string().max(20_000),
  /** Variables PigeonBox could not fill; they stay as placeholders in `text`. */
  unresolved: z.array(z.string().max(60)).max(30),
  sources: z.array(SourceRefSchema).max(20),
});
