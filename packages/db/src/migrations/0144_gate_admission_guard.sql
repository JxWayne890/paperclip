-- Keep the raw Gate baseline fenced from the trusted backup comparison until
-- the exact reviewed controller candidate is admitted. The candidate UPDATE,
-- operation receipt, and fence consumption are one transaction, so no public
-- redacted projection or time-of-check gap can substitute protected values.
ALTER TABLE public.attested_config_restore_operations
  ADD COLUMN IF NOT EXISTS gate_admission_consumed_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ADD COLUMN IF NOT EXISTS gate_admission_revision_id uuid REFERENCES public.agent_config_revisions(id);
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ADD COLUMN IF NOT EXISTS research_admission_consumed_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  ADD COLUMN IF NOT EXISTS research_admission_revision_id uuid REFERENCES public.agent_config_revisions(id);
--> statement-breakpoint
DROP INDEX IF EXISTS public.agent_maintenance_fences_company_operation_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_maintenance_fences_company_operation_agent_unique
  ON public.agent_maintenance_fences USING btree (company_id, operation_id, agent_id);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.attested_config_restore_operations'::regclass
      AND conname = 'attested_restore_operation_gate_admission_check'
  ) THEN
    ALTER TABLE public.attested_config_restore_operations
      ADD CONSTRAINT attested_restore_operation_gate_admission_check
      CHECK (
        (gate_admission_consumed_at IS NULL AND research_admission_consumed_at IS NULL)
        OR (
          status = 'completed'
          AND fence_release_audit_event_id IS NOT NULL
          AND fence_released_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE public.attested_config_restore_operations
  VALIDATE CONSTRAINT attested_restore_operation_gate_admission_check;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.reject_config_write_while_agent_fenced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fence_operation_id uuid;
  candidate_generation text;
  candidate_patch text;
  candidate_role text;
  candidate_secret_id uuid;
  candidate_secret_count bigint;
  expected_adapter jsonb;
  expected_runtime jsonb;
  expected_metadata jsonb;
  affected bigint;
BEGIN
  SELECT fence.operation_id, operation.cutover_generation,
         operation.cutover_required_patch,
         CASE WHEN operation.agent_id = NEW.id THEN 'research' ELSE 'gate' END
  INTO fence_operation_id, candidate_generation, candidate_patch, candidate_role
  FROM public.agent_maintenance_fences AS fence
  JOIN public.attested_config_restore_operations AS operation
    ON operation.id = fence.operation_id
  WHERE fence.agent_id = NEW.id
    AND fence.company_id = NEW.company_id
    AND operation.company_id = NEW.company_id
    AND operation.status = 'completed'
    AND operation.fence_release_audit_event_id IS NOT NULL
    AND operation.fence_released_at IS NOT NULL
    AND (
      (operation.agent_id = NEW.id
        AND fence.reason = 'attested_backup_restore'
        AND operation.research_admission_consumed_at IS NULL
        AND operation.research_admission_revision_id IS NULL)
      OR
      (operation.gate_agent_id = NEW.id
        AND fence.reason = 'attested_backup_restore_gate'
        AND operation.gate_admission_consumed_at IS NULL
        AND operation.gate_admission_revision_id IS NULL)
    )
  FOR UPDATE OF operation;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.agent_maintenance_fences AS fence
      WHERE fence.agent_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'agent maintenance fence prevents configuration mutation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF jsonb_typeof(OLD.adapter_config) IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.adapter_config) IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.adapter_config -> 'controllerToken') IS DISTINCT FROM 'object'
     OR NEW.adapter_config -> 'controllerToken' ->> 'type' IS DISTINCT FROM 'secret_ref'
     OR NEW.adapter_config -> 'controllerToken' ->> 'version' IS DISTINCT FROM 'latest'
     OR coalesce(NEW.adapter_config -> 'controllerToken' ->> 'secretId', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Gate admission fence rejected a non-canonical secret reference'
      USING ERRCODE = '23514';
  END IF;

  -- The PATCH caller does not choose the one-shot admission credential. The
  -- normal agent service synchronizes secret bindings earlier in this same
  -- transaction, before updating the fenced row. Require exactly one active,
  -- company-scoped deterministic controller secret bound to this exact agent
  -- and config path, with the version semantics encoded by the candidate.
  SELECT count(*), min(secret.id::text)::uuid
  INTO candidate_secret_count, candidate_secret_id
  FROM public.company_secret_bindings AS binding
  JOIN public.company_secrets AS secret
    ON secret.id = binding.secret_id
   AND secret.company_id = binding.company_id
  WHERE binding.company_id = NEW.company_id
    AND binding.target_type = 'agent'
    AND binding.target_id = NEW.id::text
    AND binding.config_path = 'controllerToken'
    AND binding.version_selector = 'latest'
    AND binding.required IS TRUE
    AND secret.company_id = NEW.company_id
    AND secret.scope = 'company'
    AND secret.status = 'active'
    AND secret.deleted_at IS NULL
    AND secret.key = 'amc-role-controller-' || candidate_role || '-inbound';
  IF candidate_secret_count <> 1
     OR candidate_secret_id IS NULL
     OR NEW.adapter_config -> 'controllerToken' ->> 'secretId' IS DISTINCT FROM candidate_secret_id::text THEN
    RAISE EXCEPTION 'Gate admission fence rejected an unauthoritative controller secret binding'
      USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_build_object(
      'url', 'http://amc-' || candidate_role || '-controller-' || candidate_generation || ':8700/invoke',
      'method', 'POST',
      'headers', '{}'::jsonb,
      'controllerToken', jsonb_build_object(
        'type', 'secret_ref',
        'secretId', candidate_secret_id::text,
        'version', 'latest'
      ),
      'timeoutMs', 2200000,
      'payloadTemplate', jsonb_build_object('controllerProtocol', 'amc-role-controller/v1')
    ) || coalesce((
      SELECT jsonb_object_agg(entry.key, entry.value)
      FROM jsonb_each(OLD.adapter_config) AS entry
      WHERE entry.key = ANY (ARRAY[
        'env', 'promptTemplate', 'instructionsFilePath', 'cwd', 'timeoutSec',
        'graceSec', 'bootstrapPromptTemplate', 'paperclipSkillSync',
        'instructionsBundleMode', 'instructionsRootPath',
        'instructionsEntryFile', 'agentsMdPath'
      ]::text[])
    ), '{}'::jsonb)
  INTO expected_adapter;
  expected_runtime :=
    coalesce(OLD.runtime_config, '{}'::jsonb) ||
    jsonb_build_object(
      'heartbeat',
      CASE
        WHEN jsonb_typeof(OLD.runtime_config -> 'heartbeat') = 'object'
          THEN OLD.runtime_config -> 'heartbeat'
        ELSE '{}'::jsonb
      END ||
      jsonb_build_object('maxConcurrentRuns', 1)
    );
  expected_metadata :=
    coalesce(OLD.metadata, '{}'::jsonb) ||
    jsonb_build_object(
      'amcRoleControllerCutover',
      jsonb_build_object(
        'generation', candidate_generation,
        'requiredPatch', candidate_patch,
        'role', candidate_role,
        'state', 'pending_canary'
      )
    );

  IF OLD.status IS DISTINCT FROM 'paused'
     OR NEW.status IS DISTINCT FROM 'paused'
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.reports_to IS DISTINCT FROM OLD.reports_to
     OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
     OR NEW.default_environment_id IS DISTINCT FROM OLD.default_environment_id
     OR NEW.budget_monthly_cents IS DISTINCT FROM OLD.budget_monthly_cents
     OR NEW.adapter_type IS DISTINCT FROM 'http'
     OR NEW.adapter_config IS DISTINCT FROM expected_adapter
     OR NEW.runtime_config IS DISTINCT FROM expected_runtime
     OR NEW.metadata IS DISTINCT FROM expected_metadata THEN
    RAISE EXCEPTION 'Gate admission fence rejected a non-canonical candidate transition'
      USING ERRCODE = '23514';
  END IF;

  IF candidate_role = 'research' THEN
    UPDATE public.attested_config_restore_operations
    SET research_admission_consumed_at = now()
    WHERE id = fence_operation_id
      AND agent_id = NEW.id
      AND research_admission_consumed_at IS NULL
      AND research_admission_revision_id IS NULL;
  ELSE
    UPDATE public.attested_config_restore_operations
    SET gate_admission_consumed_at = now()
    WHERE id = fence_operation_id
      AND gate_agent_id = NEW.id
      AND gate_admission_consumed_at IS NULL
      AND gate_admission_revision_id IS NULL;
  END IF;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'Gate admission fence operation could not be consumed exactly once'
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.agent_maintenance_fences
  WHERE agent_id = NEW.id
    AND operation_id = fence_operation_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'Gate admission fence could not be consumed exactly once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The normal agent PATCH route records the exact revision after updating the
-- row. Bind that revision to the consumed Gate admission in the same database
-- transaction. A deferred terminal check below prevents a privileged writer
-- from committing the row transition without this durable successor receipt.
CREATE OR REPLACE FUNCTION public.bind_attested_gate_admission_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_id uuid;
  admission_role text;
  affected bigint;
BEGIN
  SELECT operation.id,
         CASE WHEN operation.agent_id = NEW.agent_id THEN 'research' ELSE 'gate' END
  INTO STRICT operation_id, admission_role
  FROM public.attested_config_restore_operations AS operation
  JOIN public.agent_config_revisions AS baseline
    ON baseline.id = CASE
      WHEN operation.agent_id = NEW.agent_id THEN operation.successor_revision_id
      ELSE operation.backup_gate_latest_revision_id
    END
   AND baseline.company_id = operation.company_id
   AND baseline.agent_id = NEW.agent_id
  WHERE operation.company_id = NEW.company_id
    AND operation.status = 'completed'
    AND operation.fence_release_audit_event_id IS NOT NULL
    AND operation.fence_released_at IS NOT NULL
    AND (
      (operation.agent_id = NEW.agent_id
        AND operation.research_admission_consumed_at IS NOT NULL
        AND operation.research_admission_revision_id IS NULL)
      OR
      (operation.gate_agent_id = NEW.agent_id
        AND operation.gate_admission_consumed_at IS NOT NULL
        AND operation.gate_admission_revision_id IS NULL)
    )
    AND NEW.source = 'patch'
    AND NEW.rolled_back_from_revision_id IS NULL
    AND NEW.before_config = baseline.after_config
    AND NEW.after_config #>> '{metadata,amcRoleControllerCutover,generation}' = operation.cutover_generation
    AND NEW.after_config #>> '{metadata,amcRoleControllerCutover,requiredPatch}' = operation.cutover_required_patch
    AND NEW.after_config #>> '{metadata,amcRoleControllerCutover,role}' =
      CASE WHEN operation.agent_id = NEW.agent_id THEN 'research' ELSE 'gate' END
    AND NEW.after_config #>> '{metadata,amcRoleControllerCutover,state}' = 'pending_canary'
  FOR UPDATE OF operation;

  IF admission_role = 'research' THEN
    UPDATE public.attested_config_restore_operations
    SET research_admission_revision_id = NEW.id
    WHERE id = operation_id
      AND research_admission_revision_id IS NULL;
  ELSE
    UPDATE public.attested_config_restore_operations
    SET gate_admission_revision_id = NEW.id
    WHERE id = operation_id
      AND gate_admission_revision_id IS NULL;
  END IF;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'Gate admission revision could not be bound exactly once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_config_revisions_bind_attested_gate_admission ON public.agent_config_revisions;
--> statement-breakpoint
CREATE TRIGGER agent_config_revisions_bind_attested_gate_admission
AFTER INSERT ON public.agent_config_revisions
FOR EACH ROW
EXECUTE FUNCTION public.bind_attested_gate_admission_revision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.assert_attested_gate_admission_terminal_shape()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_operation public.attested_config_restore_operations%ROWTYPE;
BEGIN
  SELECT * INTO current_operation
  FROM public.attested_config_restore_operations
  WHERE id = NEW.id;
  IF FOUND AND (
    (current_operation.gate_admission_consumed_at IS NULL) IS DISTINCT FROM
      (current_operation.gate_admission_revision_id IS NULL)
    OR
    (current_operation.research_admission_consumed_at IS NULL) IS DISTINCT FROM
      (current_operation.research_admission_revision_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Gate admission receipt is incomplete at transaction commit'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS attested_restore_operations_gate_admission_terminal_shape
  ON public.attested_config_restore_operations;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER attested_restore_operations_gate_admission_terminal_shape
AFTER INSERT OR UPDATE OF gate_admission_consumed_at, gate_admission_revision_id,
  research_admission_consumed_at, research_admission_revision_id
ON public.attested_config_restore_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.assert_attested_gate_admission_terminal_shape();
--> statement-breakpoint
-- Once a role's exact candidate PATCH consumes its maintenance fence, the
-- role is still deliberately paused. A wake/run insert that was already
-- waiting on the agent row must therefore remain rejected after the PATCH
-- commits; admission opens only when the reviewed canary owner changes the
-- agent to an invokable status under the same row lock.
CREATE OR REPLACE FUNCTION public.assert_agent_active_work_admission(
  p_agent_id uuid,
  p_company_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  locked_company_id uuid;
  locked_status text;
BEGIN
  SELECT company_id, status
  INTO locked_company_id, locked_status
  FROM public.agents
  WHERE id = p_agent_id
  FOR UPDATE;

  IF NOT FOUND OR locked_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'active work agent scope is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF locked_status NOT IN ('active', 'idle', 'running', 'error') THEN
    RAISE EXCEPTION 'non-invokable agent status prevents active work admission'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agent_maintenance_fences AS fence
    WHERE fence.agent_id = p_agent_id
  ) THEN
    RAISE EXCEPTION 'agent maintenance fence prevents active work admission'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_config_write_while_agent_fenced() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.reject_config_write_while_agent_fenced() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.bind_attested_gate_admission_revision() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_attested_gate_admission_terminal_shape() FROM PUBLIC;
