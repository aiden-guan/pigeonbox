# Chat permissions

Chat (the Ask Pigeon route on the wire) can organize Gmail: create, rename and delete labels, add or remove labels, archive, move to the inbox, mark read or unread, star, move to Trash and restore, and unsubscribe. It can also add Google Calendar events and set reminders or snoozes (see below). It asks first, the way Claude asks before running a command.

How it works:

1. The model finds the exact threads and labels with read-only tools (`list_labels`, `list_threads` with reply status, `search_mail`, `read_thread`), then calls `change_mail` once with every step. `unsubscribe` works the same way.
2. The tool does not change anything. `planMailChanges` (`intel/mail-changes.ts`) resolves every step to concrete Gmail thread IDs and label names (a query matches at most its newest 500 threads, one approval changes at most 800), checks labels exist and the inbox has the `organize` permission, and returns problems to the model instead of proposing when something is off.
3. The plan is sealed with the server's data key (`ask_approval` purpose, bound to the user, 30 minutes) into `approval.token` (`intel/ask-approval.ts`). The response carries `approval` with a title and one readable line per step, a few example subjects and a destructive flag. The turn ends there; the model writes one or two sentences and no follow-ups.
4. The side panel shows the steps with Allow and Deny. The choice is sent as the next request's `decision`. Deny returns without a model call. Allow opens the token and `applyMailChanges` carries out exactly the sealed plan, step by step, logging each step in the audit trail; the model then reports what changed and continues any remaining part of the request (another change needs another approval).

Guarantees: the model never sees or edits the token, so nothing it writes after proposing can widen what was approved. A token from another user, an altered token or an expired one changes nothing. Mail is never deleted for good: "delete" moves threads to Trash and deleting a label keeps its emails. Clients without the `approval` feature are not offered `change_mail`, and their `unsubscribe` keeps the earlier semantic review.

## Calendar events and reminders

`create_event` and `remind_me` use the same card. `create_event` resolves the calendar (named account, the current inbox's, or the first with Calendar), requires the `calendar_write` permission ("Add calendar events"; otherwise it tells the model how to allow it), reads the time as the user's local time, rejects past times, events over 12 hours and attendees that are not email addresses, drops the user's own addresses, and checks free/busy for overlaps (times only, no event details). The card shows the event line, any overlaps, and, with attendees, either "Email invitations… can't be unsent" (destructive) or "List guests without emailing them". Allow stores a prepared event and runs `create_event` through `performAction` as approved (Tier 3 with invitations, Tier 2 without), keyed by the approval ID so a repeated Allow does not create a second event. Optional Google Meet links use `conferenceDataVersion=1`. Events without invitations record an undo recipe in the audit trail (`undoAction`).

`remind_me` schedules a reminder (`remind`), or with `snooze` archives the thread and returns it to the inbox at that time (`snooze`, needs `organize`). Reminders the user sets are stored with source `manual` and notify at the chosen time even during quiet hours or with follow-up alerts switched off.

Tests: `packages/server/src/intel/ask-approval.test.ts` (server flow, against the fake Gmail), `packages/server/src/intel/ask-calendar.test.ts` (events, invitations, overlaps, missing permissions, reminders and snoozes) and `apps/extension/src/sidepanel/CloudAsk.test.tsx` (the card). Real-model judgment on which threads to pick, and live Google Calendar, are not covered by these tests.
