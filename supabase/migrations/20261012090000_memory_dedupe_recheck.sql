-- Memory consolidation now folds rewordings and less complete versions of a fact
-- into the fuller one. Mark every page for one more pass so facts learned before
-- this change are checked too. Pages are re-checked the next time the owner opens
-- Memory or PigeonBox learns from new mail; a clean page costs nothing afterwards.
update public.personal_memory_subjects set dirty = true where not dirty;
