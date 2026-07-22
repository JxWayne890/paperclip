-- The application acquires the agent admission lock and returns friendly 409s,
-- but this database backstop also protects raw SQL, plugins, and stale
-- lifecycle writers. A fenced agent may become only more restrictive until
-- its owning operation releases the fence in the same database authority.
CREATE OR REPLACE FUNCTION public.reject_invokable_status_while_agent_fenced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     AND EXISTS (
       SELECT 1 FROM public.agent_maintenance_fences AS fence
       WHERE fence.agent_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'agent maintenance fence prevents company reassignment'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status NOT IN ('paused', 'pending_approval', 'terminated')
     AND EXISTS (
       SELECT 1
       FROM public.agent_maintenance_fences AS fence
       WHERE fence.agent_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'agent maintenance fence prevents an invokable status transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agents_reject_invokable_status_while_fenced ON public.agents;
--> statement-breakpoint
CREATE TRIGGER agents_reject_invokable_status_while_fenced
BEFORE UPDATE OF status, company_id ON public.agents
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.company_id IS DISTINCT FROM NEW.company_id
)
EXECUTE FUNCTION public.reject_invokable_status_while_agent_fenced();

-- An FK alone takes KEY SHARE, which is compatible with a concurrent status
-- UPDATE.  Fence creation must therefore take the same agent row lock first:
-- either the status writer commits first (and the fence insert rejects its
-- invokable status), or the fence commits first (and the status trigger sees
-- it). This is the database-level counterpart to the application's canonical
-- agent-before-issue admission order.
CREATE OR REPLACE FUNCTION public.lock_agent_before_maintenance_fence_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_company_id uuid;
  locked_status text;
BEGIN
  SELECT company_id, status
  INTO locked_company_id, locked_status
  FROM public.agents
  WHERE id = NEW.agent_id
  FOR UPDATE;
  IF NOT FOUND OR locked_company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'maintenance fence agent scope is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF locked_status NOT IN ('paused', 'pending_approval', 'terminated') THEN
    RAISE EXCEPTION 'maintenance fence requires a non-invokable agent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_maintenance_fences_lock_agent_before_write ON public.agent_maintenance_fences;
--> statement-breakpoint
CREATE TRIGGER agent_maintenance_fences_lock_agent_before_write
BEFORE INSERT ON public.agent_maintenance_fences
FOR EACH ROW
EXECUTE FUNCTION public.lock_agent_before_maintenance_fence_write();

-- A fence is an append-only ownership record. PostgreSQL locks the existing
-- fence tuple before a BEFORE UPDATE trigger runs, so trying to take the
-- agent lock here would invert release's agent -> fence order. No reviewed
-- path updates a fence: creation is INSERT and the owning release deletes it.
CREATE OR REPLACE FUNCTION public.reject_agent_maintenance_fence_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent maintenance fences are immutable; use the owning release transaction'
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_maintenance_fences_reject_update ON public.agent_maintenance_fences;
--> statement-breakpoint
CREATE TRIGGER agent_maintenance_fences_reject_update
BEFORE UPDATE ON public.agent_maintenance_fences
FOR EACH ROW
EXECUTE FUNCTION public.reject_agent_maintenance_fence_update();

-- A successful restore is intentionally a single config write followed by the
-- fence in the same agent-locked transaction. From that commit onward no
-- configuration-revision field may drift without an explicit fence release.
-- Non-configuration operational fields (for example accounting counters) are
-- deliberately outside this trigger and remain subject to their own policies.
CREATE OR REPLACE FUNCTION public.reject_config_write_while_agent_fenced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_maintenance_fences AS fence WHERE fence.agent_id = NEW.id) THEN
    RAISE EXCEPTION 'agent maintenance fence prevents configuration mutation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agents_reject_config_write_while_fenced ON public.agents;
--> statement-breakpoint
CREATE TRIGGER agents_reject_config_write_while_fenced
BEFORE UPDATE OF name, role, title, reports_to, capabilities, adapter_type,
  adapter_config, runtime_config, default_environment_id, budget_monthly_cents,
  metadata ON public.agents
FOR EACH ROW
WHEN (
  OLD.name IS DISTINCT FROM NEW.name
  OR OLD.role IS DISTINCT FROM NEW.role
  OR OLD.title IS DISTINCT FROM NEW.title
  OR OLD.reports_to IS DISTINCT FROM NEW.reports_to
  OR OLD.capabilities IS DISTINCT FROM NEW.capabilities
  OR OLD.adapter_type IS DISTINCT FROM NEW.adapter_type
  OR OLD.adapter_config IS DISTINCT FROM NEW.adapter_config
  OR OLD.runtime_config IS DISTINCT FROM NEW.runtime_config
  OR OLD.default_environment_id IS DISTINCT FROM NEW.default_environment_id
  OR OLD.budget_monthly_cents IS DISTINCT FROM NEW.budget_monthly_cents
  OR OLD.metadata IS DISTINCT FROM NEW.metadata
)
EXECUTE FUNCTION public.reject_config_write_while_agent_fenced();

-- Downgrade / emergency rollback counterpart (run only with the matching
-- application rollback): DROP TRIGGER IF EXISTS
-- agents_reject_invokable_status_while_fenced ON public.agents;
-- DROP FUNCTION IF EXISTS public.reject_invokable_status_while_agent_fenced();
-- DROP TRIGGER IF EXISTS agent_maintenance_fences_lock_agent_before_write ON public.agent_maintenance_fences;
-- DROP FUNCTION IF EXISTS public.lock_agent_before_maintenance_fence_write();
-- DROP TRIGGER IF EXISTS agent_maintenance_fences_reject_update ON public.agent_maintenance_fences;
-- DROP FUNCTION IF EXISTS public.reject_agent_maintenance_fence_update();
-- DROP TRIGGER IF EXISTS agents_reject_config_write_while_fenced ON public.agents;
-- DROP FUNCTION IF EXISTS public.reject_config_write_while_agent_fenced();
