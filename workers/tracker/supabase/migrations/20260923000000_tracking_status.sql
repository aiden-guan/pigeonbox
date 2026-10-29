-- Pending sends are not sent mail. Existing rows were created at send time, so they stay SENT.

alter table public.tracked_emails
  alter column sent_at drop not null;

alter table public.tracked_emails
  add column if not exists status text not null default 'SENT';

alter table public.tracked_emails
  drop constraint if exists tracked_emails_status_check;

alter table public.tracked_emails
  add constraint tracked_emails_status_check
  check (status in ('PENDING', 'SENT', 'CANCELLED', 'FAILED'));

alter table public.tracking_events
  add column if not exists classification text;

alter table public.tracking_events
  drop constraint if exists tracking_events_classification_check;

alter table public.tracking_events
  add constraint tracking_events_classification_check
  check (classification is null or classification in ('RECIPIENT_LIKELY', 'SELF_LIKELY', 'UNKNOWN'));
