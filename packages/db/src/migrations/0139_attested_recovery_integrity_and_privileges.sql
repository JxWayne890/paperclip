-- These guards are deliberately catalog-checked rather than bare ADD
-- CONSTRAINT statements.  A host can have the schema change committed while
-- its migration journal write is interrupted; replaying this migration must
-- therefore be intrinsically safe before the migration reconciler can record
-- the missing journal entry.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attested_config_restore_operations'::regclass
      AND conname = 'attested_restore_operation_status_check'
  ) THEN
    ALTER TABLE public.attested_config_restore_operations
      ADD CONSTRAINT attested_restore_operation_status_check
      CHECK (status IN ('pending', 'completed', 'failed'));
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attested_config_restore_operations'::regclass
      AND conname = 'attested_restore_operation_terminal_shape_check'
  ) THEN
    ALTER TABLE public.attested_config_restore_operations
      ADD CONSTRAINT attested_restore_operation_terminal_shape_check
      CHECK (
        (status = 'completed'
          AND successor_revision_id IS NOT NULL
          AND audit_event_id IS NOT NULL
          AND completed_at IS NOT NULL)
        OR
        (status IN ('pending', 'failed')
          AND successor_revision_id IS NULL
          AND audit_event_id IS NULL
          AND completed_at IS NULL)
      );
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attested_config_restore_operations'::regclass
      AND conname = 'attested_restore_operation_fence_release_pair_check'
  ) THEN
    ALTER TABLE public.attested_config_restore_operations
      ADD CONSTRAINT attested_restore_operation_fence_release_pair_check
      CHECK (
        (fence_release_audit_event_id IS NULL AND fence_released_at IS NULL)
        OR
        (status = 'completed'
          AND fence_release_audit_event_id IS NOT NULL
          AND fence_released_at IS NOT NULL)
      );
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_maintenance_fences FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.attested_config_restore_operations FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.agents FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_invokable_status_while_agent_fenced() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lock_agent_before_maintenance_fence_write() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_agent_maintenance_fence_update() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_config_write_while_agent_fenced() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.reject_config_write_while_agent_fenced() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.agent_maintenance_fences FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE public.attested_config_restore_operations FROM %I', role_name);
      EXECUTE format('REVOKE UPDATE ON TABLE public.agents FROM %I', role_name);
    END IF;
  END LOOP;
END;
$$;
