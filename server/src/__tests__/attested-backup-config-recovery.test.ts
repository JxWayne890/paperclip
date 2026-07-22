import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agentMaintenanceFences,
  agents,
  attestedConfigRestoreOperations,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildSanitizedConfigSnapshot } from "../services/agents.ts";
import {
  applyAttestedBackupRecovery,
  inspectAttestedBackupRecovery,
  type AttestedBackupRecoveryInput,
} from "../services/attested-backup-config-recovery.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("attested backup configuration recovery", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("attested-backup-config-recovery");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(attestedConfigRestoreOperations);
    await db.delete(agentMaintenanceFences);
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery test company",
      issuePrefix: "REC",
      requireBoardApprovalForNewAgents: false,
    });
    const backupConfig = {
      env: {
        LEGACY_ENDPOINT: { type: "plain", value: "http://legacy.invalid" },
        LEGACY_TOKEN: { type: "plain", value: "test-only-secret" },
      },
    };
    const candidateConfig = {
      env: {
        LEGACY_ENDPOINT: { type: "plain", value: "http://candidate.invalid" },
        LEGACY_TOKEN: { type: "plain", value: "test-only-secret" },
      },
    };
    const baseTime = new Date("2026-07-21T15:00:00.000Z");
    const [live] = await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research",
      role: "researcher",
      status: "paused",
      adapterType: "hermes_gateway",
      adapterConfig: candidateConfig,
      runtimeConfig: {},
      metadata: null,
      updatedAt: new Date("2026-07-21T16:00:00.000Z"),
    }).returning();
    if (!live) throw new Error("seed agent missing");
    const backupAgent = { ...live, adapterConfig: backupConfig, updatedAt: baseTime.toISOString() };
    const predecessorAfter = buildSanitizedConfigSnapshot(backupAgent);
    const cutoverAfter = buildSanitizedConfigSnapshot(live);
    const predecessorId = randomUUID();
    const cutoverId = randomUUID();
    await db.insert(agentConfigRevisions).values([
      {
        id: predecessorId,
        companyId,
        agentId,
        source: "patch",
        changedKeys: ["adapterConfig"],
        beforeConfig: predecessorAfter,
        afterConfig: predecessorAfter,
        createdAt: new Date("2026-07-21T15:30:00.000Z"),
      },
      {
        id: cutoverId,
        companyId,
        agentId,
        source: "patch",
        changedKeys: ["adapterConfig"],
        beforeConfig: predecessorAfter,
        afterConfig: cutoverAfter,
        createdAt: new Date("2026-07-21T16:30:00.000Z"),
      },
    ]);
    const auditId = randomUUID();
    await db.insert(activityLog).values({
      id: auditId,
      companyId,
      actorType: "system",
      actorId: "test",
      action: "agent.config.updated",
      entityType: "agent",
      entityId: agentId,
      agentId,
      createdAt: new Date("2026-07-21T15:45:00.000Z"),
    });
    const input: AttestedBackupRecoveryInput = {
      operationId: randomUUID(),
      companyId,
      agentId,
      expectedHeadRevisionId: cutoverId,
      cutoverRevisionId: cutoverId,
      predecessorRevisionId: predecessorId,
      backupCheckpointId: randomUUID(),
      backupCreatedAt: new Date("2026-07-21T16:00:00.000Z").toISOString(),
      backupAgent,
      backupLatestRevisionId: predecessorId,
      backupLatestRevisionCreatedAt: new Date("2026-07-21T15:30:00.000Z").toISOString(),
      backupActivityAnchor: { id: auditId, createdAt: new Date("2026-07-21T15:45:00.000Z").toISOString() },
    };
    return { input, backupConfig, candidateConfig, predecessorId, cutoverId, agentId, companyId };
  }

  it("attests and atomically restores the unique predecessor without disclosing secret bytes", async () => {
    const seeded = await seed();
    await expect(inspectAttestedBackupRecovery(db, seeded.input)).resolves.toMatchObject({ status: "inspected" });
    const applied = await applyAttestedBackupRecovery(db, seeded.input);
    expect(applied.status).toBe("applied");
    expect(applied.successorRevisionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(applied.auditEventId).toMatch(/^[0-9a-f-]{36}$/i);

    const restored = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    expect(restored?.status).toBe("paused");
    expect(restored?.adapterConfig).toEqual(seeded.backupConfig);
    const receipts = await db.select().from(attestedConfigRestoreOperations);
    expect(receipts).toHaveLength(1);
    await expect(applyAttestedBackupRecovery(db, seeded.input)).resolves.toMatchObject({
      status: "already_applied",
      successorRevisionId: applied.successorRevisionId,
    });
  });

  it("rejects a changed protected value, a stale head, and an ambiguous predecessor", async () => {
    const seeded = await seed();
    const changedSecret = structuredClone(seeded.input);
    changedSecret.backupAgent = {
      ...(seeded.input.backupAgent as Record<string, unknown>),
      adapterConfig: {
        env: {
          LEGACY_ENDPOINT: { type: "plain", value: "http://legacy.invalid" },
          LEGACY_TOKEN: { type: "plain", value: "different-test-secret" },
        },
      },
    };
    await expect(inspectAttestedBackupRecovery(db, changedSecret)).rejects.toThrow(/protected values/i);
    await expect(inspectAttestedBackupRecovery(db, {
      ...seeded.input,
      expectedHeadRevisionId: randomUUID(),
    })).rejects.toThrow(/lineage/i);
    await db.insert(agentConfigRevisions).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "patch",
      changedKeys: [],
      beforeConfig: {},
      afterConfig: {},
      createdAt: new Date("2026-07-21T16:30:00.000Z"),
    });
    await expect(inspectAttestedBackupRecovery(db, seeded.input)).rejects.toThrow(/lineage/i);
  });

  it("rejects wrong tenant scope and refuses a different operation fence", async () => {
    const seeded = await seed();
    await expect(inspectAttestedBackupRecovery(db, { ...seeded.input, companyId: randomUUID() })).rejects.toThrow(/scope|not found/i);
    await db.insert(agentMaintenanceFences).values({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      operationId: randomUUID(),
      reason: "other_maintenance",
    });
    await expect(applyAttestedBackupRecovery(db, seeded.input)).rejects.toThrow(/fence/i);
  });
});
