import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agentMaintenanceFences,
  agentWakeupRequests,
  agents,
  attestedConfigRestoreOperations,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService, buildSanitizedConfigSnapshot } from "../services/agents.ts";
import {
  applyAttestedBackupRecovery,
  discoverAttestedBackupRecoveryLineage,
  inspectAttestedBackupRecovery,
  releaseAttestedBackupRecoveryFence,
  type AttestedBackupRecoveryInput,
} from "../services/attested-backup-config-recovery.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("attested backup configuration recovery", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("attested-backup-config-recovery");
    stopDb = started.cleanup;
    connectionString = started.connectionString;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(attestedConfigRestoreOperations);
    await db.delete(agentMaintenanceFences);
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const gateAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery test company",
      issuePrefix: "REC",
      requireBoardApprovalForNewAgents: false,
    });
    const backupConfig = {
      command: "runner --api-key test-only-secret",
      env: {
        LEGACY_ENDPOINT: { type: "plain", value: "http://legacy.invalid" },
        LEGACY_TOKEN: { type: "plain", value: "test-only-secret" },
      },
    };
    const candidateConfig = {
      command: "runner --api-key test-only-secret",
      env: {
        LEGACY_ENDPOINT: { type: "plain", value: "http://candidate.invalid" },
        LEGACY_TOKEN: { type: "plain", value: "test-only-secret" },
      },
    };
    const gateConfig = {
      command: "gate-runner --api-key test-only-gate-secret",
      env: {
        GATE_ENDPOINT: { type: "plain", value: "http://gate.invalid" },
        GATE_TOKEN: { type: "plain", value: "test-only-gate-secret" },
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
      metadata: {
        amcRoleControllerCutover: {
          generation: "g1234567890abcdef12345678",
          requiredPatch: "363c709e1619accc7508b9f56e1b85ec19866f68",
          role: "research",
          state: "pending_canary",
        },
      },
      updatedAt: new Date("2026-07-21T16:00:00.000Z"),
    }).returning();
    if (!live) throw new Error("seed agent missing");
    const [liveGate] = await db.insert(agents).values({
      id: gateAgentId,
      companyId,
      name: "Gate",
      role: "gate",
      status: "paused",
      adapterType: "hermes_gateway",
      adapterConfig: gateConfig,
      runtimeConfig: {},
      metadata: null,
      updatedAt: new Date("2026-07-21T16:00:00.000Z"),
    }).returning();
    if (!liveGate) throw new Error("seed Gate agent missing");
    const backupAgent = { ...live, adapterConfig: backupConfig, metadata: null, updatedAt: baseTime.toISOString() };
    const backupGateAgent = { ...liveGate, updatedAt: baseTime.toISOString() };
    const predecessorAfter = buildSanitizedConfigSnapshot(backupAgent);
    const cutoverAfter = buildSanitizedConfigSnapshot(live);
    const predecessorId = randomUUID();
    const cutoverId = randomUUID();
    const gateRevisionId = randomUUID();
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
        id: gateRevisionId,
        companyId,
        agentId: gateAgentId,
        source: "patch",
        changedKeys: [],
        beforeConfig: buildSanitizedConfigSnapshot(backupGateAgent),
        afterConfig: buildSanitizedConfigSnapshot(backupGateAgent),
        createdAt: new Date("2026-07-21T15:35:00.000Z"),
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
      gateAgentId,
      expectedHeadRevisionId: cutoverId,
      cutoverRevisionId: cutoverId,
      predecessorRevisionId: predecessorId,
      cutoverGeneration: "g1234567890abcdef12345678",
      cutoverRequiredPatch: "363c709e1619accc7508b9f56e1b85ec19866f68",
      backupCheckpointId: randomUUID(),
      backupCreatedAt: new Date("2026-07-21T16:00:00.000Z").toISOString(),
      backupAgent,
      backupGateAgent,
      backupGateLatestRevisionId: gateRevisionId,
      backupLatestRevisionId: predecessorId,
      backupLatestRevisionCreatedAt: new Date("2026-07-21T15:30:00.000Z").toISOString(),
      backupActivityAnchor: { id: auditId, createdAt: new Date("2026-07-21T15:45:00.000Z").toISOString() },
    };
    return {
      input,
      backupConfig,
      candidateConfig,
      gateConfig,
      predecessorId,
      cutoverId,
      gateRevisionId,
      agentId,
      gateAgentId,
      companyId,
    };
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
    await expect(db.select().from(agentMaintenanceFences)).resolves.toHaveLength(2);
    await expect(applyAttestedBackupRecovery(db, seeded.input)).resolves.toMatchObject({
      status: "already_applied",
      successorRevisionId: applied.successorRevisionId,
    });
  });

  it("discovers only one opaque, redaction-safe candidate lineage", async () => {
    const seeded = await seed();
    await expect(discoverAttestedBackupRecoveryLineage(db, {
      operationId: seeded.input.operationId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      cutoverGeneration: seeded.input.cutoverGeneration,
      cutoverRequiredPatch: seeded.input.cutoverRequiredPatch,
    })).resolves.toEqual({
      status: "discoverable",
      operationId: seeded.input.operationId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      expectedHeadRevisionId: seeded.cutoverId,
      cutoverRevisionId: seeded.cutoverId,
      predecessorRevisionId: seeded.predecessorId,
      cutoverGeneration: seeded.input.cutoverGeneration,
      cutoverRequiredPatch: seeded.input.cutoverRequiredPatch,
    });
    await db.update(agents).set({ metadata: null }).where(eq(agents.id, seeded.agentId));
    await expect(discoverAttestedBackupRecoveryLineage(db, {
      operationId: seeded.input.operationId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      cutoverGeneration: seeded.input.cutoverGeneration,
      cutoverRequiredPatch: seeded.input.cutoverRequiredPatch,
    })).rejects.toThrow(/lineage/i);
  });

  it("rejects a changed protected value, a stale head, and an ambiguous predecessor", async () => {
    const seeded = await seed();
    const changedSecret = structuredClone(seeded.input);
    changedSecret.backupAgent = {
      ...(seeded.input.backupAgent as Record<string, unknown>),
      adapterConfig: {
        ...(seeded.backupConfig as Record<string, unknown>),
        env: {
          LEGACY_ENDPOINT: { type: "plain", value: "http://legacy.invalid" },
          LEGACY_TOKEN: { type: "plain", value: "different-test-secret" },
        },
      },
    };
    await expect(inspectAttestedBackupRecovery(db, changedSecret)).rejects.toThrow(/protected values/i);
    const changedCommandSecret = structuredClone(seeded.input);
    changedCommandSecret.backupAgent = {
      ...(seeded.input.backupAgent as Record<string, unknown>),
      adapterConfig: {
        ...(seeded.backupConfig as Record<string, unknown>),
        command: "runner --api-key different-test-secret",
      },
    };
    await expect(inspectAttestedBackupRecovery(db, changedCommandSecret)).rejects.toThrow(/protected values/i);
    await expect(inspectAttestedBackupRecovery(db, {
      ...seeded.input,
      expectedHeadRevisionId: randomUUID(),
    })).rejects.toThrow(/lineage/i);
    await expect(inspectAttestedBackupRecovery(db, {
      ...seeded.input,
      cutoverGeneration: "gffffffffffffffffffffffff",
    })).rejects.toThrow(/lineage/i);
    await expect(inspectAttestedBackupRecovery(db, {
      ...seeded.input,
      cutoverRequiredPatch: "f".repeat(40),
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

  it("rejects a Gate revision anchor whose public projection no longer matches the raw backup/current snapshot", async () => {
    const seeded = await seed();
    await db.update(agentConfigRevisions).set({ afterConfig: {} }).where(eq(agentConfigRevisions.id, seeded.gateRevisionId));
    await expect(inspectAttestedBackupRecovery(db, seeded.input)).rejects.toThrow(/Gate revision history/i);
  });

  it("treats an owned release receipt as idempotent while both admission fences remain closed", async () => {
    const seeded = await seed();
    const applied = await applyAttestedBackupRecovery(db, seeded.input);
    const releaseInput = {
      operationId: seeded.input.operationId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      gateAgentId: seeded.gateAgentId,
    };
    const released = await releaseAttestedBackupRecoveryFence(db, releaseInput);
    expect(released.status).toBe("fence_released");

    await expect(db.update(agents).set({ status: "idle", updatedAt: new Date() })
      .where(eq(agents.id, seeded.agentId))).rejects.toThrow();
    for (const fencedAgentId of [seeded.agentId, seeded.gateAgentId]) {
      await expect(db.insert(agentWakeupRequests).values({
        companyId: seeded.companyId,
        agentId: fencedAgentId,
        source: "stale_release_waiter",
        status: "queued",
      })).rejects.toThrow();
    }
    await expect(db.select().from(agentMaintenanceFences)).resolves.toHaveLength(2);
    await expect(releaseAttestedBackupRecoveryFence(db, releaseInput)).resolves.toEqual({
      status: "already_released",
      operationId: seeded.input.operationId,
      successorRevisionId: applied.successorRevisionId,
      auditEventId: released.auditEventId,
    });
  });

  it("blocks unrevisioned configuration drift while fenced but permits unrelated accounting fields", async () => {
    const seeded = await seed();
    await applyAttestedBackupRecovery(db, seeded.input);
    await expect(
      db.update(agents).set({ budgetMonthlyCents: 999 }).where(eq(agents.id, seeded.agentId)),
    ).rejects.toThrow();
    await expect(
      db.update(agents).set({ adapterConfig: { command: "runner --api-key changed" } }).where(eq(agents.id, seeded.agentId)),
    ).rejects.toThrow();
    await expect(
      db.update(agents).set({ spentMonthlyCents: 123 }).where(eq(agents.id, seeded.agentId)),
    ).resolves.toBeDefined();
  });

  it("database guard rejects both raw reactivation and same-status company reassignment while fenced", async () => {
    const seeded = await seed();
    await db.insert(agentMaintenanceFences).values({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      operationId: seeded.input.operationId,
      reason: "attested_backup_restore",
    });
    await expect(
      db.update(agents).set({ status: "idle" }).where(eq(agents.id, seeded.agentId)),
    ).rejects.toThrow();
    const secondCompanyId = randomUUID();
    await db.insert(companies).values({
      id: secondCompanyId,
      name: "Other company",
      issuePrefix: "OTHER",
      requireBoardApprovalForNewAgents: false,
    });
    await expect(
      db.update(agents).set({ companyId: secondCompanyId }).where(eq(agents.id, seeded.agentId)),
    ).rejects.toThrow();
  });

  it("keeps overlapping identical apply and release retries idempotent", async () => {
    const seeded = await seed();
    const first = await applyAttestedBackupRecovery(db, seeded.input);
    const releaseInput = {
      operationId: seeded.input.operationId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      gateAgentId: seeded.gateAgentId,
    };
    const [retry, released] = await Promise.all([
      applyAttestedBackupRecovery(db, seeded.input),
      releaseAttestedBackupRecoveryFence(db, releaseInput),
    ]);
    expect(retry).toMatchObject({
      status: "already_applied",
      successorRevisionId: first.successorRevisionId,
    });
    expect(released).toMatchObject({
      status: "fence_released",
      successorRevisionId: first.successorRevisionId,
    });
  });

  it("creates the authoritative Gate binding before fenced admission through the real service transaction", async () => {
    const seeded = await seed();
    await applyAttestedBackupRecovery(db, seeded.input);
    await releaseAttestedBackupRecoveryFence(db, {
      operationId: seeded.input.operationId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      gateAgentId: seeded.gateAgentId,
    });
    const gateBefore = await db.select().from(agents)
      .where(eq(agents.id, seeded.gateAgentId)).then((rows) => rows[0]!);
    const authoritativeSecretId = randomUUID();
    const wrongKeySecretId = randomUUID();
    await db.insert(companySecrets).values([
      {
        id: authoritativeSecretId,
        companyId: seeded.companyId,
        scope: "company",
        key: "amc-role-controller-gate-inbound",
        name: "Gate controller inbound",
        status: "disabled",
      },
      {
        id: wrongKeySecretId,
        companyId: seeded.companyId,
        scope: "company",
        key: "not-the-reviewed-gate-controller-secret",
        name: "Wrong Gate controller secret",
        status: "active",
      },
    ]);
    const buildCandidatePatch = (secretId: string) => ({
      adapterType: "http",
      adapterConfig: {
        url: `http://amc-gate-controller-${seeded.input.cutoverGeneration}:8700/invoke`,
        method: "POST",
        headers: {},
        controllerToken: { type: "secret_ref", secretId, version: "latest" },
        timeoutMs: 2_200_000,
        payloadTemplate: { controllerProtocol: "amc-role-controller/v1" },
        env: (gateBefore.adapterConfig as Record<string, unknown>).env,
      },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      metadata: {
        amcRoleControllerCutover: {
          generation: seeded.input.cutoverGeneration,
          requiredPatch: seeded.input.cutoverRequiredPatch,
          role: "gate",
          state: "pending_canary",
        },
      },
    });
    const svc = agentService(db);
    const assertAdmissionUntouched = async () => {
      await expect(db.select().from(companySecretBindings)
        .where(eq(companySecretBindings.targetId, seeded.gateAgentId))).resolves.toHaveLength(0);
      await expect(db.select().from(agentMaintenanceFences)
        .where(eq(agentMaintenanceFences.agentId, seeded.gateAgentId))).resolves.toHaveLength(1);
      const operation = await db.select().from(attestedConfigRestoreOperations)
        .where(eq(attestedConfigRestoreOperations.id, seeded.input.operationId)).then((rows) => rows[0]!);
      expect(operation.gateAdmissionConsumedAt).toBeNull();
      expect(operation.gateAdmissionRevisionId).toBeNull();
    };

    await expect(svc.update(seeded.gateAgentId, buildCandidatePatch(wrongKeySecretId), {
      recordRevision: { source: "patch" },
    })).rejects.toThrow();
    await assertAdmissionUntouched();

    await expect(svc.update(seeded.gateAgentId, buildCandidatePatch(authoritativeSecretId), {
      recordRevision: { source: "patch" },
    })).rejects.toThrow();
    await assertAdmissionUntouched();

    await db.update(companySecrets).set({ status: "active" })
      .where(eq(companySecrets.id, authoritativeSecretId));
    const admitted = await svc.update(seeded.gateAgentId, buildCandidatePatch(authoritativeSecretId), {
      recordRevision: { source: "patch" },
    });
    expect(admitted?.adapterType).toBe("http");
    const bindings = await db.select().from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, seeded.gateAgentId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      companyId: seeded.companyId,
      secretId: authoritativeSecretId,
      targetType: "agent",
      targetId: seeded.gateAgentId,
      configPath: "controllerToken",
      versionSelector: "latest",
      required: true,
    });
    const consumed = await db.select().from(attestedConfigRestoreOperations)
      .where(eq(attestedConfigRestoreOperations.id, seeded.input.operationId)).then((rows) => rows[0]!);
    expect(consumed.gateAdmissionConsumedAt).toBeInstanceOf(Date);
    expect(consumed.gateAdmissionRevisionId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(db.select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.id, consumed.gateAdmissionRevisionId!))).resolves.toHaveLength(1);
    await expect(db.select().from(agentMaintenanceFences)
      .where(eq(agentMaintenanceFences.agentId, seeded.gateAgentId))).resolves.toHaveLength(0);
  });

  it("keeps both raw role baselines fenced until exact candidate transitions and revisions consume them atomically", async () => {
    const seeded = await seed();
    const applied = await applyAttestedBackupRecovery(db, seeded.input);
    const releaseInput = {
      operationId: seeded.input.operationId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      gateAgentId: seeded.gateAgentId,
    };
    await releaseAttestedBackupRecoveryFence(db, releaseInput);

    const waiterClients: Array<ReturnType<typeof createDb>["$client"]> = [];
    onTestFinished(async () => {
      await Promise.all(waiterClients.map((client) => client.end()));
    });
    async function beginBlockedWake(agentId: string, role: "research" | "gate") {
      const writer = createDb(connectionString).$client;
      const observer = createDb(connectionString).$client;
      waiterClients.push(writer, observer);
      const applicationName = `attested-candidate-${role}-${agentId}`.slice(0, 63);
      await writer`SELECT set_config('application_name', ${applicationName}, false)`;
      const identity = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const pid = identity[0]?.pid;
      expect(typeof pid).toBe("number");
      const result = writer`
        /* attested-candidate-patch-waiter */
        INSERT INTO agent_wakeup_requests (company_id, agent_id, source, status)
        VALUES (${seeded.companyId}, ${agentId}, 'candidate_patch_waiter', 'queued')
      `.then(
        () => "inserted" as const,
        () => "rejected" as const,
      );
      const deadline = Date.now() + 2_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await observer<{ application_name: string; blocked: boolean }[]>`
          SELECT application_name,
                 EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid!} AND NOT granted) AS blocked
          FROM pg_stat_activity
          WHERE pid = ${pid!}
          LIMIT 1
        `;
        if (rows[0]?.application_name === applicationName && rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      return { result };
    }

    const before = await db.select().from(agents).where(eq(agents.id, seeded.gateAgentId)).then((rows) => rows[0]!);
    const baseline = await db.select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.id, seeded.gateRevisionId))
      .then((rows) => rows[0]!);
    const gateControllerSecretId = randomUUID();
    await db.insert(companySecrets).values({
      id: gateControllerSecretId,
      companyId: seeded.companyId,
      scope: "company",
      key: "amc-role-controller-gate-inbound",
      name: "Gate controller inbound",
      status: "active",
    });
    const gateBinding = {
      companyId: seeded.companyId,
      secretId: gateControllerSecretId,
      targetType: "agent",
      targetId: seeded.gateAgentId,
      configPath: "controllerToken",
      versionSelector: "latest",
      required: true,
    };
    await db.insert(companySecretBindings).values(gateBinding);
    const candidatePatch = {
      adapterType: "http",
      adapterConfig: {
        url: `http://amc-gate-controller-${seeded.input.cutoverGeneration}:8700/invoke`,
        method: "POST",
        headers: {},
        controllerToken: { type: "secret_ref", secretId: gateControllerSecretId, version: "latest" },
        timeoutMs: 2_200_000,
        payloadTemplate: { controllerProtocol: "amc-role-controller/v1" },
        env: (before.adapterConfig as Record<string, unknown>).env,
      },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      metadata: {
        amcRoleControllerCutover: {
          generation: seeded.input.cutoverGeneration,
          requiredPatch: seeded.input.cutoverRequiredPatch,
          role: "gate",
          state: "pending_canary",
        },
      },
    };

    await expect(db.update(agents).set({
      ...candidatePatch,
      adapterConfig: {
        ...candidatePatch.adapterConfig,
        controllerToken: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
      },
    }).where(eq(agents.id, seeded.gateAgentId))).rejects.toThrow();
    await expect(db.insert(companySecretBindings).values(gateBinding)).rejects.toThrow();

    await db.delete(companySecretBindings);
    await expect(db.update(agents).set(candidatePatch).where(eq(agents.id, seeded.gateAgentId))).rejects.toThrow();

    await db.insert(companySecretBindings).values({ ...gateBinding, targetId: seeded.agentId });
    await expect(db.update(agents).set(candidatePatch).where(eq(agents.id, seeded.gateAgentId))).rejects.toThrow();
    await db.delete(companySecretBindings);

    await db.insert(companySecretBindings).values({ ...gateBinding, configPath: "env.CONTROLLER_TOKEN" });
    await expect(db.update(agents).set(candidatePatch).where(eq(agents.id, seeded.gateAgentId))).rejects.toThrow();
    await db.delete(companySecretBindings);

    const otherCompanyId = randomUUID();
    const otherCompanySecretId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other recovery company",
      issuePrefix: "OTH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companySecrets).values({
      id: otherCompanySecretId,
      companyId: otherCompanyId,
      scope: "company",
      key: "amc-role-controller-gate-inbound",
      name: "Other Gate controller inbound",
      status: "active",
    });
    await db.insert(companySecretBindings).values({ ...gateBinding, secretId: otherCompanySecretId });
    await expect(db.update(agents).set(candidatePatch).where(eq(agents.id, seeded.gateAgentId))).rejects.toThrow();
    await db.delete(companySecretBindings);

    await db.insert(companySecretBindings).values(gateBinding);
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, gateControllerSecretId));
    await expect(db.update(agents).set(candidatePatch).where(eq(agents.id, seeded.gateAgentId))).rejects.toThrow();
    await db.update(companySecrets).set({ status: "active" }).where(eq(companySecrets.id, gateControllerSecretId));

    await expect(db.update(agents).set({
      ...candidatePatch,
      adapterConfig: {
        ...candidatePatch.adapterConfig,
        env: { SUBSTITUTED: { type: "plain", value: "not-the-baseline" } },
      },
    }).where(eq(agents.id, seeded.gateAgentId))).rejects.toThrow();
    await expect(db.update(agents).set(candidatePatch).where(eq(agents.id, seeded.gateAgentId))).rejects.toThrow();

    const stillPending = await db.select().from(attestedConfigRestoreOperations)
      .where(eq(attestedConfigRestoreOperations.id, seeded.input.operationId))
      .then((rows) => rows[0]!);
    expect(stillPending.gateAdmissionConsumedAt).toBeNull();
    expect(stillPending.gateAdmissionRevisionId).toBeNull();
    await expect(db.select().from(agentMaintenanceFences)
      .where(eq(agentMaintenanceFences.agentId, seeded.gateAgentId))).resolves.toHaveLength(1);

    let admissionRevisionId = "";
    let waitingGateWake: Promise<"inserted" | "rejected"> | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${seeded.gateAgentId} FOR UPDATE`);
      waitingGateWake = (await beginBlockedWake(seeded.gateAgentId, "gate")).result;
      const [updated] = await tx.update(agents).set(candidatePatch)
        .where(eq(agents.id, seeded.gateAgentId)).returning();
      if (!updated) throw new Error("Gate candidate update missing");
      const [revision] = await tx.insert(agentConfigRevisions).values({
        companyId: seeded.companyId,
        agentId: seeded.gateAgentId,
        source: "patch",
        changedKeys: ["adapterType", "adapterConfig", "runtimeConfig", "metadata"],
        beforeConfig: baseline.afterConfig,
        afterConfig: buildSanitizedConfigSnapshot(updated),
      }).returning({ id: agentConfigRevisions.id });
      admissionRevisionId = revision!.id;
    });
    await expect(waitingGateWake).resolves.toBe("rejected");

    const researchBefore = await db.select().from(agents)
      .where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]!);
    const researchBaseline = await db.select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.id, applied.successorRevisionId!))
      .then((rows) => rows[0]!);
    const researchControllerSecretId = randomUUID();
    await db.insert(companySecrets).values({
      id: researchControllerSecretId,
      companyId: seeded.companyId,
      scope: "company",
      key: "amc-role-controller-research-inbound",
      name: "Research controller inbound",
      status: "active",
    });
    await db.insert(companySecretBindings).values({
      companyId: seeded.companyId,
      secretId: researchControllerSecretId,
      targetType: "agent",
      targetId: seeded.agentId,
      configPath: "controllerToken",
      versionSelector: "latest",
      required: true,
    });
    const researchCandidatePatch = {
      adapterType: "http",
      adapterConfig: {
        url: `http://amc-research-controller-${seeded.input.cutoverGeneration}:8700/invoke`,
        method: "POST",
        headers: {},
        controllerToken: { type: "secret_ref", secretId: researchControllerSecretId, version: "latest" },
        timeoutMs: 2_200_000,
        payloadTemplate: { controllerProtocol: "amc-role-controller/v1" },
        env: (researchBefore.adapterConfig as Record<string, unknown>).env,
      },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      metadata: {
        amcRoleControllerCutover: {
          generation: seeded.input.cutoverGeneration,
          requiredPatch: seeded.input.cutoverRequiredPatch,
          role: "research",
          state: "pending_canary",
        },
      },
    };
    let researchAdmissionRevisionId = "";
    let waitingResearchWake: Promise<"inserted" | "rejected"> | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${seeded.agentId} FOR UPDATE`);
      waitingResearchWake = (await beginBlockedWake(seeded.agentId, "research")).result;
      const [updated] = await tx.update(agents).set(researchCandidatePatch)
        .where(eq(agents.id, seeded.agentId)).returning();
      if (!updated) throw new Error("Research candidate update missing");
      const [revision] = await tx.insert(agentConfigRevisions).values({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        source: "patch",
        changedKeys: ["adapterType", "adapterConfig", "runtimeConfig", "metadata"],
        beforeConfig: researchBaseline.afterConfig,
        afterConfig: buildSanitizedConfigSnapshot(updated),
      }).returning({ id: agentConfigRevisions.id });
      researchAdmissionRevisionId = revision!.id;
    });
    await expect(waitingResearchWake).resolves.toBe("rejected");

    const consumed = await db.select().from(attestedConfigRestoreOperations)
      .where(eq(attestedConfigRestoreOperations.id, seeded.input.operationId))
      .then((rows) => rows[0]!);
    expect(consumed.gateAdmissionConsumedAt).toBeInstanceOf(Date);
    expect(consumed.gateAdmissionRevisionId).toBe(admissionRevisionId);
    expect(consumed.researchAdmissionConsumedAt).toBeInstanceOf(Date);
    expect(consumed.researchAdmissionRevisionId).toBe(researchAdmissionRevisionId);
    await expect(db.select().from(agentMaintenanceFences)).resolves.toHaveLength(0);
    await expect(applyAttestedBackupRecovery(db, seeded.input)).resolves.toMatchObject({
      status: "already_applied",
    });
    await expect(releaseAttestedBackupRecoveryFence(db, releaseInput)).resolves.toMatchObject({
      status: "already_released",
    });

    let canaryBoundaryWake: Promise<"inserted" | "rejected"> | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${seeded.agentId} FOR UPDATE`);
      canaryBoundaryWake = (await beginBlockedWake(seeded.agentId, "research")).result;
      await tx.update(agents).set({ status: "idle", updatedAt: new Date() })
        .where(eq(agents.id, seeded.agentId));
    });
    await expect(canaryBoundaryWake).resolves.toBe("inserted");
    await expect(db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, seeded.agentId))).resolves.toHaveLength(1);
  });
});
