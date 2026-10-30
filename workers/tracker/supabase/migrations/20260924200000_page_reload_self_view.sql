-- Allow a document reload to re-arm one-shot sender proxy suppression.
alter table public.tracking_self_view_claims
  drop constraint if exists tracking_self_view_claims_source_check;

alter table public.tracking_self_view_claims
  add constraint tracking_self_view_claims_source_check
  check (
    source in (
      'ROW_INTERACTION',
      'MESSAGE_EXPANDED',
      'MESSAGE_LOAD',
      'CACHE_REINSPECTION',
      'PAGE_RELOAD'
    )
  );
