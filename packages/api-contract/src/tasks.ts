import { z } from 'zod';
import { IdSchema, IsoSchema, MailboxSelectorSchema } from './common.js';
export const TaskSchema = z.object({ id: IdSchema, title: z.string().max(300), threadId: z.string().max(128).nullable(), accountId: IdSchema.nullable(), dueAt: IsoSchema.nullable(), status: z.enum(['open', 'done', 'cancelled']), createdAt: IsoSchema });
export const TasksSchema = z.object({ tasks: z.array(TaskSchema).max(200) });
export const TaskCreateSchema = MailboxSelectorSchema.extend({ id: IdSchema, title: z.string().trim().min(1).max(300), threadId: z.string().max(128).optional(), dueAt: IsoSchema.nullable().optional() });
export const TaskUpdateSchema = z.object({ id: IdSchema, status: z.enum(['open', 'done', 'cancelled']) });
export type SavedTask = z.infer<typeof TaskSchema>;
