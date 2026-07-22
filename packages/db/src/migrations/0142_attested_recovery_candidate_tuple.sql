-- Bind the failed Research cutover to the exact controller tuple selected by
-- the operations lock. A syntactically valid pending_canary marker is not
-- sufficient: a stale candidate generation or another fork patch must never
-- be accepted as the recoverable cutover.
ALTER TABLE public.attested_config_restore_operations
  ADD COLUMN IF NOT EXISTS cutover_generation text;
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ADD COLUMN IF NOT EXISTS cutover_required_patch text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attested_config_restore_operations'::regclass
      AND conname = 'attested_restore_operation_candidate_tuple_check'
  ) THEN
    ALTER TABLE public.attested_config_restore_operations
      ADD CONSTRAINT attested_restore_operation_candidate_tuple_check
      CHECK (
        cutover_generation IS NOT NULL
        AND cutover_required_patch IS NOT NULL
        AND cutover_generation ~ '^g[0-9a-f]{24}$'
        AND cutover_required_patch ~ '^[0-9a-f]{40}$'
      );
  END IF;
END;
$$;
