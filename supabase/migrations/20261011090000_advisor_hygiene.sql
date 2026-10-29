-- Database advisor hygiene (Supabase linter, checked 2026-10-11).
--
-- 1. The two trigger functions are SECURITY DEFINER and were executable through
--    /rest/v1/rpc. Postgres refuses to run a trigger function outside a trigger,
--    so this was never exploitable; revoking EXECUTE removes the exposure.
-- 2. app.protect_user_table runs only in migrations; pin its search_path.
--    app.current_user_id and app.acting_user are left as they are: they call
--    only pg_catalog functions and app.* by qualified name, and a SET clause
--    would stop the planner inlining them in every RLS policy.
-- 3. Every foreign key gets a covering index, so deleting an account or a
--    mailbox does not scan each child table.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.tracking_row_owner() from public, anon, authenticated;

alter function app.protect_user_table(regclass, boolean) set search_path = '';

create index if not exists approvals_mail_account_id_fk_idx on public.approvals (mail_account_id);
create index if not exists approvals_thread_id_fk_idx on public.approvals (thread_id);
create index if not exists assignments_assigned_by_fk_idx on public.assignments (assigned_by);
create index if not exists assignments_workspace_id_fk_idx on public.assignments (workspace_id);
create index if not exists audit_events_undo_of_fk_idx on public.audit_events (undo_of);
create index if not exists automation_runs_thread_id_fk_idx on public.automation_runs (thread_id);
create index if not exists automation_templates_created_by_fk_idx on public.automation_templates (created_by);
create index if not exists automation_templates_workspace_id_fk_idx on public.automation_templates (workspace_id);
create index if not exists calendar_accounts_user_id_fk_idx on public.calendar_accounts (user_id);
create index if not exists calendar_sync_state_user_id_fk_idx on public.calendar_sync_state (user_id);
create index if not exists classifications_user_id_fk_idx on public.classifications (user_id);
create index if not exists comments_author_id_fk_idx on public.comments (author_id);
create index if not exists comments_workspace_id_fk_idx on public.comments (workspace_id);
create index if not exists commitments_mail_account_id_fk_idx on public.commitments (mail_account_id);
create index if not exists contacts_company_id_fk_idx on public.contacts (company_id);
create index if not exists document_events_document_id_fk_idx on public.document_events (document_id);
create index if not exists document_events_recipient_id_document_id_user_id_fk_idx on public.document_events (recipient_id, document_id, user_id);
create index if not exists document_events_user_id_fk_idx on public.document_events (user_id);
create index if not exists document_recipients_document_id_user_id_fk_idx on public.document_recipients (document_id, user_id);
create index if not exists document_recipients_user_id_fk_idx on public.document_recipients (user_id);
create index if not exists document_viewer_sessions_f2f696be_fk_idx on public.document_viewer_sessions (recipient_id, document_id, user_id);
create index if not exists draft_sources_user_id_fk_idx on public.draft_sources (user_id);
create index if not exists draft_versions_user_id_fk_idx on public.draft_versions (user_id);
create index if not exists drafts_mail_account_id_fk_idx on public.drafts (mail_account_id);
create index if not exists encrypted_credentials_user_id_fk_idx on public.encrypted_credentials (user_id);
create index if not exists follow_ups_draft_id_fk_idx on public.follow_ups (draft_id);
create index if not exists follow_ups_mail_account_id_fk_idx on public.follow_ups (mail_account_id);
create index if not exists gmail_sync_state_user_id_fk_idx on public.gmail_sync_state (user_id);
create index if not exists mcp_clients_user_id_fk_idx on public.mcp_clients (user_id);
create index if not exists mentions_user_id_fk_idx on public.mentions (user_id);
create index if not exists mentions_workspace_id_fk_idx on public.mentions (workspace_id);
create index if not exists notes_thread_id_fk_idx on public.notes (thread_id);
create index if not exists notifications_mail_account_id_fk_idx on public.notifications (mail_account_id);
create index if not exists oauth_states_mail_account_id_fk_idx on public.oauth_states (mail_account_id);
create index if not exists oauth_states_user_id_fk_idx on public.oauth_states (user_id);
create index if not exists personal_memories_superseded_by_user_id_fk_idx on public.personal_memories (superseded_by, user_id);
create index if not exists personal_memory_entities_memory_id_user_id_fk_idx on public.personal_memory_entities (memory_id, user_id);
create index if not exists personal_memory_exclusions_thread_id_fk_idx on public.personal_memory_exclusions (thread_id);
create index if not exists personal_memory_extractions_thread_id_fk_idx on public.personal_memory_extractions (thread_id);
create index if not exists personal_memory_sources_mail_account_id_gmail_message_id_fk_idx on public.personal_memory_sources (mail_account_id, gmail_message_id);
create index if not exists personal_memory_sources_memory_id_user_id_fk_idx on public.personal_memory_sources (memory_id, user_id);
create index if not exists prepared_events_approval_id_fk_idx on public.prepared_events (approval_id);
create index if not exists prepared_events_mail_account_id_fk_idx on public.prepared_events (mail_account_id);
create index if not exists prepared_events_thread_id_fk_idx on public.prepared_events (thread_id);
create index if not exists prepared_events_user_id_fk_idx on public.prepared_events (user_id);
create index if not exists recall_chunks_mail_account_id_fk_idx on public.recall_chunks (mail_account_id);
create index if not exists relationship_events_thread_id_fk_idx on public.relationship_events (thread_id);
create index if not exists relationship_events_user_id_fk_idx on public.relationship_events (user_id);
create index if not exists reminders_mail_account_id_fk_idx on public.reminders (mail_account_id);
create index if not exists reminders_thread_id_fk_idx on public.reminders (thread_id);
create index if not exists reminders_user_id_fk_idx on public.reminders (user_id);
create index if not exists rule_matches_thread_id_fk_idx on public.rule_matches (thread_id);
create index if not exists rule_matches_user_id_fk_idx on public.rule_matches (user_id);
create index if not exists rule_versions_user_id_fk_idx on public.rule_versions (user_id);
create index if not exists search_documents_mail_account_id_fk_idx on public.search_documents (mail_account_id);
create index if not exists sequence_enrollments_user_id_fk_idx on public.sequence_enrollments (user_id);
create index if not exists sequence_sends_approval_id_fk_idx on public.sequence_sends (approval_id);
create index if not exists sequence_steps_user_id_fk_idx on public.sequence_steps (user_id);
create index if not exists sequences_mail_account_id_fk_idx on public.sequences (mail_account_id);
create index if not exists sequences_user_id_fk_idx on public.sequences (user_id);
create index if not exists shadow_decisions_thread_id_fk_idx on public.shadow_decisions (thread_id);
create index if not exists shadow_decisions_user_id_fk_idx on public.shadow_decisions (user_id);
create index if not exists shared_notes_author_id_fk_idx on public.shared_notes (author_id);
create index if not exists shared_notes_shared_thread_id_fk_idx on public.shared_notes (shared_thread_id);
create index if not exists shared_notes_workspace_id_fk_idx on public.shared_notes (workspace_id);
create index if not exists shared_threads_owner_id_fk_idx on public.shared_threads (owner_id);
create index if not exists tasks_thread_id_fk_idx on public.tasks (thread_id);
create index if not exists thread_states_mail_account_id_fk_idx on public.thread_states (mail_account_id);
create index if not exists webhooks_user_id_fk_idx on public.webhooks (user_id);
create index if not exists workspace_invitations_invited_by_fk_idx on public.workspace_invitations (invited_by);
create index if not exists workspace_invitations_workspace_id_fk_idx on public.workspace_invitations (workspace_id);
create index if not exists workspaces_created_by_fk_idx on public.workspaces (created_by);
