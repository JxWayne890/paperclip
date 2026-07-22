-- A fence is only meaningful if no stale binary or privileged raw writer can
-- create/resurrect work afterwards.  New active work serializes on the
-- globally unique agent row, which is also the first lock held by recovery
-- and fence insertion.  This deliberately checks scope and fence ownership,
-- not the wider application invokability policy: paused/no-fence rows remain
-- compatible with existing administrative and fixture flows, while a fence
-- still proves a drained commit boundary.
CREATE OR REPLACE FUNCTION public.assert_agent_active_work_admission(
  p_agent_id uuid,
  p_company_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  locked_company_id uuid;
BEGIN
  SELECT company_id
  INTO locked_company_id
  FROM public.agents
  WHERE id = p_agent_id
  FOR UPDATE;

  IF NOT FOUND OR locked_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'active work agent scope is invalid'
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

CREATE OR REPLACE FUNCTION public.guard_agent_wakeup_active_work()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_active boolean := false;
  new_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_active := OLD.status NOT IN ('coalesced', 'skipped', 'completed', 'failed', 'cancelled');
    -- PostgreSQL has already locked this work tuple before a BEFORE UPDATE
    -- trigger runs. Never acquire the agent row here: that would create a
    -- work->agent inverse of fence insertion's agent->work order.
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'wake request identity is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Status columns are legacy unconstrained text. Treat an unknown/future
  -- value as nonterminal (therefore active) so it cannot hide behind a fence.
  new_active := NEW.status NOT IN ('coalesced', 'skipped', 'completed', 'failed', 'cancelled');
  -- An active->active transition is legitimate (for example queued->claimed)
  -- and an active->terminal transition is always reducing. There is no
  -- reviewed terminal->active lifecycle: reject it outright rather than
  -- acquiring the agent row after PostgreSQL has locked this work tuple.
  IF TG_OP = 'INSERT' AND new_active THEN
    PERFORM public.assert_agent_active_work_admission(NEW.agent_id, NEW.company_id);
  ELSIF TG_OP = 'UPDATE' AND new_active AND NOT old_active THEN
    RAISE EXCEPTION 'terminal wake requests cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_wakeup_requests_guard_active_work_insert ON public.agent_wakeup_requests;
--> statement-breakpoint
CREATE TRIGGER agent_wakeup_requests_guard_active_work_insert
BEFORE INSERT ON public.agent_wakeup_requests
FOR EACH ROW
EXECUTE FUNCTION public.guard_agent_wakeup_active_work();
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_wakeup_requests_guard_active_work_update ON public.agent_wakeup_requests;
--> statement-breakpoint
CREATE TRIGGER agent_wakeup_requests_guard_active_work_update
BEFORE UPDATE OF status, agent_id, company_id ON public.agent_wakeup_requests
FOR EACH ROW
EXECUTE FUNCTION public.guard_agent_wakeup_active_work();

CREATE OR REPLACE FUNCTION public.guard_heartbeat_run_active_work()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_active boolean := false;
  new_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_active := OLD.status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out');
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'heartbeat run identity is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  new_active := NEW.status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out');
  IF TG_OP = 'INSERT' AND new_active THEN
    PERFORM public.assert_agent_active_work_admission(NEW.agent_id, NEW.company_id);
  ELSIF TG_OP = 'UPDATE' AND new_active AND NOT old_active THEN
    RAISE EXCEPTION 'terminal heartbeat runs cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS heartbeat_runs_guard_active_work_insert ON public.heartbeat_runs;
--> statement-breakpoint
CREATE TRIGGER heartbeat_runs_guard_active_work_insert
BEFORE INSERT ON public.heartbeat_runs
FOR EACH ROW
EXECUTE FUNCTION public.guard_heartbeat_run_active_work();
--> statement-breakpoint
DROP TRIGGER IF EXISTS heartbeat_runs_guard_active_work_update ON public.heartbeat_runs;
--> statement-breakpoint
CREATE TRIGGER heartbeat_runs_guard_active_work_update
BEFORE UPDATE OF status, agent_id, company_id ON public.heartbeat_runs
FOR EACH ROW
EXECUTE FUNCTION public.guard_heartbeat_run_active_work();

-- Replace the earlier fence-write guard with the same locked-agent protocol
-- plus an authoritative drain check. Once this trigger holds the agent row,
-- every new active row waits in its insert trigger. Updates never reactivate
-- terminal work, so the agent lock is sufficient to make this count the
-- fence commit boundary without taking work locks in the inverse order.
CREATE OR REPLACE FUNCTION public.lock_agent_before_maintenance_fence_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_company_id uuid;
  locked_status text;
  active_run_count bigint;
  active_wake_count bigint;
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

  -- Work is bound to a globally unique agent. Independent FKs permit old or
  -- corrupt rows whose company disagrees with the agent/fence company; never
  -- exclude those from the drain count or accidentally bless that corruption.
  IF EXISTS (
    SELECT 1 FROM public.agent_wakeup_requests
    WHERE agent_id = NEW.agent_id AND company_id IS DISTINCT FROM NEW.company_id
  ) OR EXISTS (
    SELECT 1 FROM public.heartbeat_runs
    WHERE agent_id = NEW.agent_id AND company_id IS DISTINCT FROM NEW.company_id
  ) THEN
    RAISE EXCEPTION 'maintenance fence work scope is corrupt'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO active_run_count
  FROM public.heartbeat_runs
  WHERE agent_id = NEW.agent_id
    AND status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out');
  SELECT count(*) INTO active_wake_count
  FROM public.agent_wakeup_requests
  WHERE agent_id = NEW.agent_id
    AND status NOT IN ('coalesced', 'skipped', 'completed', 'failed', 'cancelled');
  IF active_run_count <> 0 OR active_wake_count <> 0 THEN
    RAISE EXCEPTION 'maintenance fence requires zero active work'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_agent_active_work_admission(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_agent_wakeup_active_work() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_heartbeat_run_active_work() FROM PUBLIC;
