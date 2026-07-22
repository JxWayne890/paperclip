-- Bind the nonsecret Gate identity and its historical revision anchor to the
-- durable recovery operation. This prevents an otherwise identical Research
-- retry from substituting a Gate row after a lost response.
ALTER TABLE public.attested_config_restore_operations
  ADD COLUMN IF NOT EXISTS gate_agent_id uuid REFERENCES public.agents(id);
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ADD COLUMN IF NOT EXISTS backup_gate_latest_revision_id uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attested_config_restore_operations'::regclass
      AND conname = 'attested_restore_operation_gate_binding_check'
  ) THEN
    ALTER TABLE public.attested_config_restore_operations
      ADD CONSTRAINT attested_restore_operation_gate_binding_check
      CHECK (gate_agent_id IS NOT NULL AND backup_gate_latest_revision_id IS NOT NULL AND gate_agent_id <> agent_id);
  END IF;
END;
$$;
