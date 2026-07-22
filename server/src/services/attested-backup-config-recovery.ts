import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentConfigRevisions,
  agentMaintenanceFences,
  agentWakeupRequests,
  agents,
  attestedConfigRestoreOperations,
  heartbeatRuns,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { isJwtLikeSensitiveValue, isSensitiveRecordKey } from "../redaction.js";
import { syncAgentAdapterEnvBindings } from "./agent-secret-bindings.js";
import { buildSanitizedConfigSnapshot } from "./agents.js";
import { secretService } from "./secrets.js";

const CONFIG_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
  "budgetMonthlyCents",
  "metadata",
] as const;

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;

type ConfigField = (typeof CONFIG_FIELDS)[number];
type BackupAgentConfig = Pick<typeof agents.$inferSelect, ConfigField> & {
  id: string;
  companyId: string;
  updatedAt: string | Date;
};

export interface AttestedBackupRecoveryInput {
  operationId: string;
  companyId: string;
  agentId: string;
  expectedHeadRevisionId: string;
  cutoverRevisionId: string;
  predecessorRevisionId: string;
  backupCheckpointId: string;
  backupCreatedAt: string;
  backupAgent: unknown;
  backupLatestRevisionId: string;
  backupLatestRevisionCreatedAt: string;
  backupActivityAnchor: { id: string; createdAt: string } | null;
}

export interface AttestedBackupRecoveryResult {
  status: "inspected" | "applied" | "already_applied";
  operationId: string;
  successorRevisionId: string | null;
  auditEventId: string | null;
}

export interface AttestedBackupRecoveryLineage {
  status: "discoverable";
  operationId: string;
  companyId: string;
  agentId: string;
  expectedHeadRevisionId: string;
  cutoverRevisionId: string;
  predecessorRevisionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDate(value: string | Date, label: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw unprocessable(`Invalid ${label}`);
  return parsed;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/**
 * Compare secret-bearing values without releasing a digest or a value. This
 * intentionally walks the larger input even when lengths differ.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  let different = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    different |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return different === 0;
}

function collectProtectedValues(value: unknown, path = "$"): Record<string, string> {
  const collected: Record<string, string> = {};
  const visit = (current: unknown, currentPath: string, protectedByParent = false): void => {
    if (isJwtLikeSensitiveValue(current) || protectedByParent) {
      collected[currentPath] = stableJson(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, entry] of Object.entries(current)) {
      visit(entry, `${currentPath}.${key}`, isSensitiveRecordKey(key));
    }
  };
  visit(value, path);
  return collected;
}

function protectedConfigEqual(left: unknown, right: unknown): boolean {
  const leftValues = collectProtectedValues(left);
  const rightValues = collectProtectedValues(right);
  return constantTimeEqual(stableJson(leftValues), stableJson(rightValues));
}

function configSnapshotEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function isResearchCandidateCutover(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.metadata)) return false;
  const marker = config.metadata.amcRoleControllerCutover;
  return isRecord(marker) &&
    marker.role === "research" &&
    marker.state === "pending_canary" &&
    typeof marker.generation === "string" &&
    /^g[0-9a-f]{24}$/.test(marker.generation) &&
    typeof marker.requiredPatch === "string" &&
    /^[0-9a-f]{40}$/.test(marker.requiredPatch);
}

/**
 * Discovery returns opaque revision lineage only. It deliberately evaluates
 * only already-redacted projections; the backup is neither read nor compared
 * here, so this cannot become a protected-value comparison oracle.
 */
export async function discoverAttestedBackupRecoveryLineage(
  db: Db,
  input: Pick<AttestedBackupRecoveryInput, "operationId" | "companyId" | "agentId">,
): Promise<AttestedBackupRecoveryLineage> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const lockedAgent = await lockAgent(txDb, input as AttestedBackupRecoveryInput);
    if (lockedAgent.status !== "paused") throw conflict("Agent must remain paused for recovery discovery");
    await txDb.execute(sql`
      SELECT id FROM agent_config_revisions
      WHERE company_id = ${input.companyId} AND agent_id = ${input.agentId}
      ORDER BY created_at, id FOR UPDATE
    `);
    const history = await txDb
      .select()
      .from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.companyId, input.companyId), eq(agentConfigRevisions.agentId, input.agentId)))
      .orderBy(asc(agentConfigRevisions.createdAt), asc(agentConfigRevisions.id));
    if (history.length < 2) throw conflict("Recovery lineage has no immediate predecessor");
    const head = history.at(-1)!;
    const predecessor = history.at(-2)!;
    const matching = history.filter((revision) => isResearchCandidateCutover(revision.afterConfig));
    if (
      matching.length !== 1 ||
      matching[0]!.id !== head.id ||
      predecessor.createdAt.getTime() === head.createdAt.getTime() ||
      !configSnapshotEqual(predecessor.afterConfig, head.beforeConfig) ||
      !configSnapshotEqual(buildSanitizedConfigSnapshot(lockedAgent), head.afterConfig)
    ) {
      throw conflict("Recovery lineage is absent, ambiguous, or stale");
    }
    return {
      status: "discoverable",
      operationId: input.operationId,
      companyId: input.companyId,
      agentId: input.agentId,
      expectedHeadRevisionId: head.id,
      cutoverRevisionId: head.id,
      predecessorRevisionId: predecessor.id,
    };
  });
}

function parseBackupAgent(value: unknown, input: AttestedBackupRecoveryInput): BackupAgentConfig {
  if (!isRecord(value)) throw unprocessable("Backup attestation does not contain an agent row");
  if (value.id !== input.agentId || value.companyId !== input.companyId) {
    throw conflict("Backup agent scope does not match the requested company and agent");
  }
  for (const field of CONFIG_FIELDS) {
    if (!(field in value)) throw unprocessable("Backup agent row is incomplete");
  }
  if (typeof value.updatedAt !== "string") throw unprocessable("Backup agent timestamp is invalid");
  return value as unknown as BackupAgentConfig;
}

function backupConfigSnapshot(backup: BackupAgentConfig) {
  return buildSanitizedConfigSnapshot(backup);
}

function configPatchFromBackup(backup: BackupAgentConfig): Pick<typeof agents.$inferInsert, ConfigField> {
  return Object.fromEntries(CONFIG_FIELDS.map((field) => [field, backup[field]])) as Pick<
    typeof agents.$inferInsert,
    ConfigField
  >;
}

async function readLiveAuditAnchor(tx: Db, input: AttestedBackupRecoveryInput): Promise<void> {
  if (!input.backupActivityAnchor) {
    throw conflict("Backup audit continuity anchor is missing");
  }
  const anchor = await tx
    .select({ id: activityLog.id, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(and(
      eq(activityLog.id, input.backupActivityAnchor.id),
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.agentId, input.agentId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!anchor || anchor.createdAt.getTime() !== asDate(input.backupActivityAnchor.createdAt, "backup audit anchor").getTime()) {
    throw conflict("Backup audit continuity anchor is absent or changed");
  }
}

async function assertHistoryAndBackup(
  tx: Db,
  input: AttestedBackupRecoveryInput,
  backup: BackupAgentConfig,
  lockedAgent: typeof agents.$inferSelect,
) {
  const backupCreatedAt = asDate(input.backupCreatedAt, "backup checkpoint timestamp");
  const backupLatestRevisionCreatedAt = asDate(input.backupLatestRevisionCreatedAt, "backup revision timestamp");
  const backupUpdatedAt = asDate(backup.updatedAt, "backup agent timestamp");
  if (backupLatestRevisionCreatedAt > backupCreatedAt || backupUpdatedAt > backupCreatedAt) {
    throw conflict("Backup checkpoint chronology is invalid");
  }

  await tx.execute(sql`
    SELECT id FROM agent_config_revisions
    WHERE company_id = ${input.companyId} AND agent_id = ${input.agentId}
    ORDER BY created_at, id FOR UPDATE
  `);
  const history = await tx
    .select()
    .from(agentConfigRevisions)
    .where(and(eq(agentConfigRevisions.companyId, input.companyId), eq(agentConfigRevisions.agentId, input.agentId)))
    .orderBy(asc(agentConfigRevisions.createdAt), asc(agentConfigRevisions.id));
  const cutoverIndex = history.findIndex((revision) => revision.id === input.cutoverRevisionId);
  if (cutoverIndex <= 0 || history.length === 0) {
    throw conflict("Cutover revision does not have one unambiguous predecessor");
  }
  const predecessor = history[cutoverIndex - 1]!;
  const cutover = history[cutoverIndex]!;
  const head = history.at(-1) ?? null;
  if (
    predecessor.id !== input.predecessorRevisionId ||
    predecessor.id !== input.backupLatestRevisionId ||
    head?.id !== input.expectedHeadRevisionId ||
    input.expectedHeadRevisionId !== input.cutoverRevisionId ||
    predecessor.createdAt.getTime() === cutover.createdAt.getTime()
  ) {
    throw conflict("Revision lineage is stale, ambiguous, or does not match the backup checkpoint");
  }
  if (backupCreatedAt >= cutover.createdAt || predecessor.createdAt > backupCreatedAt) {
    throw conflict("Backup checkpoint does not precede the failed cutover");
  }

  const backupProjection = backupConfigSnapshot(backup);
  const liveProjection = buildSanitizedConfigSnapshot(lockedAgent);
  if (
    !configSnapshotEqual(backupProjection, predecessor.afterConfig) ||
    !configSnapshotEqual(predecessor.afterConfig, cutover.beforeConfig) ||
    !configSnapshotEqual(liveProjection, cutover.afterConfig)
  ) {
    throw conflict("Backup, predecessor, cutover, and live configuration lineage do not attest exactly");
  }
  if (!protectedConfigEqual(configPatchFromBackup(backup), configPatchFromBackup(lockedAgent))) {
    throw conflict("Current candidate no longer preserves the backup protected values");
  }
  await readLiveAuditAnchor(tx, input);
  return { predecessor, cutover, backupProjection, liveProjection };
}

async function lockAgent(tx: Db, input: AttestedBackupRecoveryInput) {
  await tx.execute(sql`
    SELECT id FROM agents WHERE id = ${input.agentId} AND company_id = ${input.companyId} FOR UPDATE
  `);
  const locked = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!locked) throw notFound("Agent not found in the requested company");
  return locked;
}

async function assertPausedAndDrained(tx: Db, input: AttestedBackupRecoveryInput, lockedAgent: typeof agents.$inferSelect) {
  if (lockedAgent.status !== "paused") throw conflict("Agent must remain paused for attested restore");
  const [runs, wakes] = await Promise.all([
    tx.select({ count: sql<number>`count(*)` }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
    )),
    tx.select({ count: sql<number>`count(*)` }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      inArray(agentWakeupRequests.status, [...ACTIVE_WAKE_STATUSES]),
    )),
  ]);
  if (Number(runs[0]?.count ?? 0) !== 0 || Number(wakes[0]?.count ?? 0) !== 0) {
    throw conflict("Agent has queued or running work; restore is fail-closed");
  }
}

function sameOperation(row: typeof attestedConfigRestoreOperations.$inferSelect, input: AttestedBackupRecoveryInput): boolean {
  return row.companyId === input.companyId &&
    row.agentId === input.agentId &&
    row.expectedHeadRevisionId === input.expectedHeadRevisionId &&
    row.cutoverRevisionId === input.cutoverRevisionId &&
    row.predecessorRevisionId === input.predecessorRevisionId &&
    row.backupCheckpointId === input.backupCheckpointId;
}

export async function inspectAttestedBackupRecovery(
  db: Db,
  input: AttestedBackupRecoveryInput,
): Promise<AttestedBackupRecoveryResult> {
  const backup = parseBackupAgent(input.backupAgent, input);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const locked = await lockAgent(txDb, input);
    await assertPausedAndDrained(txDb, input, locked);
    await assertHistoryAndBackup(txDb, input, backup, locked);
    return { status: "inspected", operationId: input.operationId, successorRevisionId: null, auditEventId: null };
  });
}

export async function applyAttestedBackupRecovery(
  db: Db,
  input: AttestedBackupRecoveryInput,
): Promise<AttestedBackupRecoveryResult> {
  const backup = parseBackupAgent(input.backupAgent, input);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const existingOperation = await txDb
      .select()
      .from(attestedConfigRestoreOperations)
      .where(eq(attestedConfigRestoreOperations.id, input.operationId))
      .then((rows) => rows[0] ?? null);
    if (existingOperation) {
      if (!sameOperation(existingOperation, input) || existingOperation.status !== "completed") {
        throw conflict("Restore operation identifier is already bound to a different or incomplete operation");
      }
      return {
        status: "already_applied",
        operationId: input.operationId,
        successorRevisionId: existingOperation.successorRevisionId,
        auditEventId: existingOperation.auditEventId,
      };
    }

    const locked = await lockAgent(txDb, input);
    await assertPausedAndDrained(txDb, input, locked);
    const { predecessor, cutover, liveProjection } = await assertHistoryAndBackup(txDb, input, backup, locked);

    const existingFence = await txDb
      .select()
      .from(agentMaintenanceFences)
      .where(eq(agentMaintenanceFences.agentId, input.agentId))
      .then((rows) => rows[0] ?? null);
    if (existingFence && (existingFence.companyId !== input.companyId || existingFence.operationId !== input.operationId)) {
      throw conflict("A different maintenance fence already owns this agent");
    }
    if (!existingFence) {
      await txDb.insert(agentMaintenanceFences).values({
        agentId: input.agentId,
        companyId: input.companyId,
        operationId: input.operationId,
        reason: "attested_backup_restore",
      });
    }

    const restored = await txDb
      .update(agents)
      .set({ ...configPatchFromBackup(backup), updatedAt: new Date() })
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId), eq(agents.status, "paused")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!restored) throw conflict("Agent changed while the restore lock was held");

    await syncAgentAdapterEnvBindings({
      secretsSvc: secretService(txDb),
      companyId: input.companyId,
      agentId: input.agentId,
      adapterConfig: restored.adapterConfig,
    });

    const afterProjection = buildSanitizedConfigSnapshot(restored);
    if (!configSnapshotEqual(afterProjection, predecessor.afterConfig)) {
      throw conflict("Restored configuration did not produce the attested predecessor projection");
    }
    const [successor] = await txDb.insert(agentConfigRevisions).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "attested_backup_restore",
      rolledBackFromRevisionId: cutover.id,
      changedKeys: CONFIG_FIELDS.filter((field) => stableJson(liveProjection[field]) !== stableJson(afterProjection[field])),
      beforeConfig: liveProjection as unknown as Record<string, unknown>,
      afterConfig: afterProjection as unknown as Record<string, unknown>,
    }).returning({ id: agentConfigRevisions.id });
    if (!successor) throw new Error("Could not record successor configuration revision");

    const [audit] = await txDb.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "attested_backup_recovery",
      action: "agent.config.attested_backup_restored",
      entityType: "agent",
      entityId: input.agentId,
      agentId: input.agentId,
      details: {
        operationId: input.operationId,
        predecessorRevisionId: predecessor.id,
        cutoverRevisionId: cutover.id,
        successorRevisionId: successor.id,
        backupCheckpointId: input.backupCheckpointId,
      },
    }).returning({ id: activityLog.id });
    if (!audit) throw new Error("Could not record attested restore audit event");

    await txDb.insert(attestedConfigRestoreOperations).values({
      id: input.operationId,
      companyId: input.companyId,
      agentId: input.agentId,
      expectedHeadRevisionId: input.expectedHeadRevisionId,
      cutoverRevisionId: input.cutoverRevisionId,
      predecessorRevisionId: input.predecessorRevisionId,
      backupCheckpointId: input.backupCheckpointId,
      status: "completed",
      successorRevisionId: successor.id,
      auditEventId: audit.id,
      completedAt: new Date(),
    });

    return { status: "applied", operationId: input.operationId, successorRevisionId: successor.id, auditEventId: audit.id };
  });
}
