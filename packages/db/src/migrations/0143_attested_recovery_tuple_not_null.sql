-- 0141/0142 began as additive columns so a partially applied historical
-- database could be diagnosed. Before the repair runtime can attest them,
-- refuse any incomplete durable operation and make the invariant physical.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.attested_config_restore_operations
    WHERE gate_agent_id IS NULL
       OR backup_gate_latest_revision_id IS NULL
       OR cutover_generation IS NULL
       OR cutover_required_patch IS NULL
  ) THEN
    RAISE EXCEPTION 'attested recovery operation has incomplete Gate/candidate tuple';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ALTER COLUMN gate_agent_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ALTER COLUMN backup_gate_latest_revision_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ALTER COLUMN cutover_generation SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ALTER COLUMN cutover_required_patch SET NOT NULL;
