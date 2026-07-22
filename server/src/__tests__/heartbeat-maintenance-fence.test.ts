import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentMaintenanceFences,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("heartbeat maintenance admission fence", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-maintenance-fence");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentMaintenanceFences);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("makes a pause-and-fence commit beat a wake that passed its stale precheck", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const operationId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fence test",
      issuePrefix: "FENCE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research",
      role: "researcher",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    let wake: Promise<unknown> | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`);
      wake = heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "barrier-test",
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
      // The wake reads the active state before attempting the admission lock.
      await new Promise((resolve) => setTimeout(resolve, 75));
      await tx.update(agents).set({ status: "paused", updatedAt: new Date() }).where(eq(agents.id, agentId));
      await tx.insert(agentMaintenanceFences).values({
        agentId,
        companyId,
        operationId,
        reason: "barrier_test_restore",
      });
    });
    await expect(wake).resolves.toBeNull();

    const [queuedRuns, queuedWakeups] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.status} IN ('queued', 'running')`,
      )),
      db.select({ count: sql<number>`count(*)` }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, agentId),
        sql`${agentWakeupRequests.status} IN ('queued', 'deferred_issue_execution')`,
      )),
    ]);
    expect(Number(queuedRuns[0]?.count ?? 0)).toBe(0);
    expect(Number(queuedWakeups[0]?.count ?? 0)).toBe(0);
  });
});
