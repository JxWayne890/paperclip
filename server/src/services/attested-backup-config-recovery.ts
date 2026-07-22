import { timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
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
import { REDACTED_EVENT_VALUE } from "../redaction.js";
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

// Status columns predate a constrained domain. Recovery treats every value
// outside this explicit terminal allowlist as active so unknown/future state
// cannot bypass the zero-work/fence invariant.
const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const TERMINAL_WAKE_STATUSES = ["coalesced", "skipped", "completed", "failed", "cancelled"] as const;

type ConfigField = (typeof CONFIG_FIELDS)[number];
type BackupAgentConfig = Pick<typeof agents.$inferSelect, ConfigField> & {
  id: string;
  companyId: string;
  updatedAt: string | Date;
};

type RecoveryScope = Pick<AttestedBackupRecoveryInput, "operationId" | "companyId" | "agentId">;
type RecoveryReleaseScope = Pick<
  AttestedBackupRecoveryInput,
  "operationId" | "companyId" | "agentId" | "gateAgentId"
>;

const PRESERVED_GATE_ADAPTER_KEYS = [
  "env",
  "promptTemplate",
  "instructionsFilePath",
  "cwd",
  "timeoutSec",
  "graceSec",
  "bootstrapPromptTemplate",
  "paperclipSkillSync",
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "agentsMdPath",
] as const;

export interface AttestedBackupRecoveryInput {
  operationId: string;
  companyId: string;
  agentId: string;
  gateAgentId: string;
  expectedHeadRevisionId: string;
  cutoverRevisionId: string;
  predecessorRevisionId: string;
  cutoverGeneration: string;
  cutoverRequiredPatch: string;
  backupCheckpointId: string;
  backupCreatedAt: string;
  backupAgent: unknown;
  backupGateAgent: unknown;
  backupGateLatestRevisionId: string;
  backupLatestRevisionId: string;
  backupLatestRevisionCreatedAt: string;
  backupActivityAnchor: { id: string; createdAt: string } | null;
}

export interface AttestedBackupRecoveryResult {
  status: "inspected" | "applied" | "already_applied";
  operationId: string;
  successorRevisionId: string | null;
  auditEventId: string | null;
  gateAgentId: string;
  backupGateLatestRevisionId: string;
  gateBackupCurrentExact: true;
}

export interface AttestedBackupFenceReleaseResult {
  status: "fence_released" | "already_released";
  operationId: string;
  successorRevisionId: string;
  auditEventId: string;
}

export interface AttestedBackupRecoveryLineage {
  status: "discoverable";
  operationId: string;
  companyId: string;
  agentId: string;
  expectedHeadRevisionId: string;
  cutoverRevisionId: string;
  predecessorRevisionId: string;
  cutoverGeneration: string;
  cutoverRequiredPatch: string;
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

/** Compare private values without releasing a digest or a value. */
function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.max(leftBytes.length, rightBytes.length);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  // Compare equal-size buffers first so a length mismatch cannot bypass the
  // timing-safe primitive. The final length bit is folded into the result
  // only after that comparison has completed.
  let different = timingSafeEqual(paddedLeft, paddedRight) ? 0 : 1;
  different |= leftBytes.length ^ rightBytes.length;
  return different === 0;
}

type PrivatePathSegment =
  | { kind: "field"; name: string }
  | { kind: "object-key"; key: string }
  | { kind: "array-index"; index: number }
  | { kind: "sanitized-fragment"; index: number };

function privatePathKey(path: readonly PrivatePathSegment[]): string {
  // The stable JSON encoding is a typed, structural namespace.  In
  // particular, {kind:"object-key",key:"0"} can never alias
  // {kind:"array-index",index:0}, and a user key can never alias a synthetic
  // sanitizer fragment segment.
  return stableJson(path);
}

/**
 * Recover the exact private spans that the historical sanitizer replaced in a
 * command string. A repeated delimiter makes the reconstruction ambiguous, so
 * it fails closed instead of guessing which bytes were redacted.
 */
function redactedTextFragments(raw: string, sanitized: string): string[] | null {
  // A literal public marker is indistinguishable from a sanitizer replacement
  // after history has been redacted.  Refuse this input rather than turning
  // marker placement into a comparison oracle.
  if (raw.includes(REDACTED_EVENT_VALUE)) return null;
  const parts = sanitized.split(REDACTED_EVENT_VALUE);
  if (parts.length === 1) return raw === sanitized ? [] : null;
  if (!raw.startsWith(parts[0]!)) return null;
  const fragments: string[] = [];
  let cursor = parts[0]!.length;
  for (let index = 1; index < parts.length; index += 1) {
    const suffix = parts[index]!;
    if (suffix.length === 0) {
      if (index !== parts.length - 1) return null;
      fragments.push(raw.slice(cursor));
      cursor = raw.length;
      continue;
    }
    const next = raw.indexOf(suffix, cursor);
    if (next < 0 || raw.indexOf(suffix, next + suffix.length) >= 0) return null;
    fragments.push(raw.slice(cursor, next));
    cursor = next + suffix.length;
  }
  return cursor === raw.length ? fragments : null;
}

/**
 * Walk the raw configuration alongside its public sanitized projection. Every
 * private leaf is named by a typed structural path, never a string path.
 * Command and argv text are compared by the exact spans the sanitizer removed;
 * all other sanitized leaves compare their whole raw value. No fingerprint is
 * created or returned, and any non-bijective redaction alignment rejects.
 */
function collectSanitizedSecretFragments(
  raw: unknown,
  sanitized: unknown,
  path: readonly PrivatePathSegment[],
  collected: Record<string, string>,
): boolean {
  if (stableJson(raw) === stableJson(sanitized)) return true;
  if (typeof raw === "string" && typeof sanitized === "string") {
    const fragments = redactedTextFragments(raw, sanitized);
    if (!fragments) return false;
    for (const [index, fragment] of fragments.entries()) {
      collected[privatePathKey([...path, { kind: "sanitized-fragment", index }])] = fragment;
    }
    return true;
  }
  if (Array.isArray(raw) && Array.isArray(sanitized) && raw.length === sanitized.length) {
    return raw.every((entry, index) => collectSanitizedSecretFragments(
      entry,
      sanitized[index],
      [...path, { kind: "array-index", index }],
      collected,
    ));
  }
  if (isRecord(raw) && isRecord(sanitized)) {
    const rawKeys = Object.keys(raw).sort();
    const sanitizedKeys = Object.keys(sanitized).sort();
    if (rawKeys.length !== sanitizedKeys.length || rawKeys.some((key, index) => key !== sanitizedKeys[index])) return false;
    return rawKeys.every((key) => collectSanitizedSecretFragments(
      raw[key],
      sanitized[key],
      [...path, { kind: "object-key", key }],
      collected,
    ));
  }
  collected[privatePathKey(path)] = stableJson(raw);
  return true;
}

function protectedConfigEqual(left: Pick<typeof agents.$inferSelect, ConfigField>, right: Pick<typeof agents.$inferSelect, ConfigField>): boolean {
  const leftSnapshot = buildSanitizedConfigSnapshot(left);
  const rightSnapshot = buildSanitizedConfigSnapshot(right);
  const leftValues: Record<string, string> = {};
  const rightValues: Record<string, string> = {};
  for (const field of ["adapterConfig", "runtimeConfig", "metadata"] as const) {
    const root: readonly PrivatePathSegment[] = [{ kind: "field", name: field }];
    if (!collectSanitizedSecretFragments(left[field], leftSnapshot[field], root, leftValues)) return false;
    if (!collectSanitizedSecretFragments(right[field], rightSnapshot[field], root, rightValues)) return false;
  }
  return constantTimeEqual(stableJson(leftValues), stableJson(rightValues));
}

function configSnapshotEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function isResearchCandidateCutover(
  config: unknown,
  expectedGeneration: string,
  expectedRequiredPatch: string,
): boolean {
  if (!isRecord(config) || !isRecord(config.metadata)) return false;
  const marker = config.metadata.amcRoleControllerCutover;
  return isRecord(marker) &&
    marker.role === "research" &&
    marker.state === "pending_canary" &&
    marker.generation === expectedGeneration &&
    marker.requiredPatch === expectedRequiredPatch;
}

function isExactRoleCandidateCutover(
  config: unknown,
  baseline: unknown,
  role: "research" | "gate",
  expectedGeneration: string,
  expectedRequiredPatch: string,
): boolean {
  if (!isRecord(config) || !isRecord(baseline) || !isRecord(baseline.adapterConfig)) return false;
  if (!isRecord(config.adapterConfig) || !isRecord(config.runtimeConfig)) return false;
  const baselineAdapter = baseline.adapterConfig;
  const token = config.adapterConfig.controllerToken;
  if (
    !isRecord(token) ||
    Object.keys(token).length !== 3 ||
    token.type !== "secret_ref" ||
    token.version !== "latest" ||
    typeof token.secretId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token.secretId)
  ) return false;

  const preservedAdapter = Object.fromEntries(
    PRESERVED_GATE_ADAPTER_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(baselineAdapter, key))
      .map((key) => [key, baselineAdapter[key]]),
  );
  const baselineRuntime = isRecord(baseline.runtimeConfig) ? baseline.runtimeConfig : {};
  const baselineHeartbeat = isRecord(baselineRuntime.heartbeat) ? baselineRuntime.heartbeat : {};
  const baselineMetadata = isRecord(baseline.metadata) ? baseline.metadata : {};
  const expected = {
    ...baseline,
    adapterType: "http",
    adapterConfig: {
      url: `http://amc-${role}-controller-${expectedGeneration}:8700/invoke`,
      method: "POST",
      headers: {},
      controllerToken: {
        type: "secret_ref",
        secretId: token.secretId,
        version: "latest",
      },
      timeoutMs: 2_200_000,
      payloadTemplate: { controllerProtocol: "amc-role-controller/v1" },
      ...preservedAdapter,
    },
    runtimeConfig: {
      ...baselineRuntime,
      heartbeat: { ...baselineHeartbeat, maxConcurrentRuns: 1 },
    },
    metadata: {
      ...baselineMetadata,
      amcRoleControllerCutover: {
        generation: expectedGeneration,
        requiredPatch: expectedRequiredPatch,
        role,
        state: "pending_canary",
      },
    },
  };
  return configSnapshotEqual(config, expected);
}

/**
 * Discovery returns opaque revision lineage only. It deliberately evaluates
 * only already-redacted projections; the backup is neither read nor compared
 * here, so this cannot become a protected-value comparison oracle.
 */
export async function discoverAttestedBackupRecoveryLineage(
  db: Db,
  input: Pick<AttestedBackupRecoveryInput, "operationId" | "companyId" | "agentId" | "cutoverGeneration" | "cutoverRequiredPatch">,
): Promise<AttestedBackupRecoveryLineage> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const lockedAgent = await lockAgent(txDb, input);
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
    const matching = history.filter((revision) => isResearchCandidateCutover(
      revision.afterConfig,
      input.cutoverGeneration,
      input.cutoverRequiredPatch,
    ));
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
      cutoverGeneration: input.cutoverGeneration,
      cutoverRequiredPatch: input.cutoverRequiredPatch,
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

function parseBackupGateAgent(value: unknown, input: AttestedBackupRecoveryInput): BackupAgentConfig {
  return parseBackupAgent(value, { ...input, agentId: input.gateAgentId });
}

function backupConfigSnapshot(backup: BackupAgentConfig) {
  return buildSanitizedConfigSnapshot(backup);
}

function configPatchFromBackup(backup: BackupAgentConfig): Pick<typeof agents.$inferSelect, ConfigField> {
  return Object.fromEntries(CONFIG_FIELDS.map((field) => [field, backup[field]])) as Pick<
    typeof agents.$inferSelect,
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
  if (!/^g[0-9a-f]{24}$/.test(input.cutoverGeneration) || !/^[0-9a-f]{40}$/.test(input.cutoverRequiredPatch)) {
    throw conflict("Recovery candidate tuple is invalid");
  }
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
    !isResearchCandidateCutover(cutover.afterConfig, input.cutoverGeneration, input.cutoverRequiredPatch) ||
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

async function lockAgent(tx: Db, input: RecoveryScope) {
  const locked = await tx
    .select()
    .from(agents)
    // Every recovery lifecycle transaction starts with the globally unique
    // agent row.  Do not fold company scope into this predicate: that would
    // allow another path to take an operation/fence lock first for a scoped
    // miss and reintroduce an agent<->operation deadlock.
    .where(eq(agents.id, input.agentId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!locked || locked.companyId !== input.companyId) {
    throw notFound("Agent not found in the requested company");
  }
  return locked;
}

async function lockRecoveryAndGateAgents(
  tx: Db,
  input: Pick<AttestedBackupRecoveryInput, "companyId" | "agentId" | "gateAgentId">,
): Promise<{ recovery: typeof agents.$inferSelect; gate: typeof agents.$inferSelect }> {
  if (input.agentId === input.gateAgentId) throw conflict("Recovery and Gate agents must be distinct");
  // Lock both agent rows in globally deterministic UUID order. This preserves
  // the agent-first admission order while preventing a Research/Gate lock
  // inversion with concurrent lifecycle work.
  const locked = await tx
    .select()
    .from(agents)
    .where(inArray(agents.id, [input.agentId, input.gateAgentId]))
    .orderBy(asc(agents.id))
    .for("update");
  if (locked.length !== 2) throw notFound("Recovery or Gate agent not found");
  const recovery = locked.find((agent) => agent.id === input.agentId) ?? null;
  const gate = locked.find((agent) => agent.id === input.gateAgentId) ?? null;
  if (!recovery || !gate || recovery.companyId !== input.companyId || gate.companyId !== input.companyId) {
    throw notFound("Recovery or Gate agent not found in the requested company");
  }
  return { recovery, gate };
}

async function assertPausedAndDrained(tx: Db, input: Pick<AttestedBackupRecoveryInput, "companyId" | "agentId">, lockedAgent: typeof agents.$inferSelect) {
  if (lockedAgent.status !== "paused") throw conflict("Agent must remain paused for attested restore");
  const [runs, wakes] = await Promise.all([
    tx.select({ count: sql<number>`count(*)` }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      notInArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
    )),
    tx.select({ count: sql<number>`count(*)` }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      notInArray(agentWakeupRequests.status, [...TERMINAL_WAKE_STATUSES]),
    )),
  ]);
  if (Number(runs[0]?.count ?? 0) !== 0 || Number(wakes[0]?.count ?? 0) !== 0) {
    throw conflict("Agent has queued or running work; restore is fail-closed");
  }
}

async function assertGateBackupCurrentExact(
  tx: Db,
  input: AttestedBackupRecoveryInput,
  backupGate: BackupAgentConfig,
  lockedGate: typeof agents.$inferSelect,
): Promise<void> {
  await assertPausedAndDrained(tx, { ...input, agentId: input.gateAgentId }, lockedGate);
  // This is deliberately a direct raw configuration comparison in the trusted
  // transaction. Unlike the public redacted history/configuration projection,
  // it covers every protected byte and every nonsecret field without emitting
  // an oracle, digest, or value.
  if (!constantTimeEqual(
    stableJson(configPatchFromBackup(backupGate)),
    stableJson(configPatchFromBackup(lockedGate)),
  )) {
    throw conflict("Gate backup/current configuration is not exact");
  }
  const head = await tx
    .select({ id: agentConfigRevisions.id, afterConfig: agentConfigRevisions.afterConfig })
    .from(agentConfigRevisions)
    .where(and(eq(agentConfigRevisions.companyId, input.companyId), eq(agentConfigRevisions.agentId, input.gateAgentId)))
    .orderBy(sql`${agentConfigRevisions.createdAt} DESC`, sql`${agentConfigRevisions.id} DESC`)
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !head ||
    head.id !== input.backupGateLatestRevisionId ||
    !configSnapshotEqual(head.afterConfig, backupConfigSnapshot(backupGate)) ||
    !configSnapshotEqual(head.afterConfig, buildSanitizedConfigSnapshot(lockedGate))
  ) {
    throw conflict("Gate revision history no longer equals the backup anchor");
  }
}

function recoveryResult(
  status: AttestedBackupRecoveryResult["status"],
  input: AttestedBackupRecoveryInput,
  successorRevisionId: string | null,
  auditEventId: string | null,
): AttestedBackupRecoveryResult {
  return {
    status,
    operationId: input.operationId,
    successorRevisionId,
    auditEventId,
    gateAgentId: input.gateAgentId,
    backupGateLatestRevisionId: input.backupGateLatestRevisionId,
    gateBackupCurrentExact: true,
  };
}

function sameOperation(row: typeof attestedConfigRestoreOperations.$inferSelect, input: AttestedBackupRecoveryInput): boolean {
  return row.companyId === input.companyId &&
    row.agentId === input.agentId &&
    row.gateAgentId === input.gateAgentId &&
    row.expectedHeadRevisionId === input.expectedHeadRevisionId &&
    row.cutoverRevisionId === input.cutoverRevisionId &&
    row.predecessorRevisionId === input.predecessorRevisionId &&
    row.cutoverGeneration === input.cutoverGeneration &&
    row.cutoverRequiredPatch === input.cutoverRequiredPatch &&
    row.backupCheckpointId === input.backupCheckpointId &&
    row.backupGateLatestRevisionId === input.backupGateLatestRevisionId;
}

async function readCompletedOperationReleaseState(
  tx: Db,
  operation: typeof attestedConfigRestoreOperations.$inferSelect,
  input: Pick<AttestedBackupRecoveryInput, "operationId" | "companyId" | "agentId">,
): Promise<{ kind: "unreleased" } | { kind: "released"; auditEventId: string }> {
  if (!operation.fenceReleasedAt && !operation.fenceReleaseAuditEventId) return { kind: "unreleased" };
  if (!operation.fenceReleasedAt || !operation.fenceReleaseAuditEventId) {
    throw conflict("Attested recovery release receipt is incomplete");
  }
  const receiptAudit = await tx
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(
      eq(activityLog.id, operation.fenceReleaseAuditEventId),
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.agentId, input.agentId),
      eq(activityLog.actorType, "system"),
      eq(activityLog.actorId, "attested_backup_recovery"),
      eq(activityLog.action, "agent.config.attested_backup_restore_fence_released"),
      eq(activityLog.entityType, "agent"),
      eq(activityLog.entityId, input.agentId),
      sql`${activityLog.details} ->> 'operationId' = ${input.operationId}`,
      sql`${activityLog.details} ->> 'successorRevisionId' = ${operation.successorRevisionId}`,
    ))
    .then((rows) => rows[0] ?? null);
  if (!receiptAudit) throw conflict("Attested recovery fence release receipt is not owned by this operation");
  return { kind: "released", auditEventId: operation.fenceReleaseAuditEventId };
}

async function readRoleAdmissionFenceState(
  tx: Db,
  operation: typeof attestedConfigRestoreOperations.$inferSelect,
  input: RecoveryReleaseScope,
  role: "research" | "gate",
  lockedAgent: typeof agents.$inferSelect,
): Promise<{ kind: "present" } | { kind: "consumed"; revisionId: string }> {
  const agentId = role === "research" ? input.agentId : input.gateAgentId;
  const operationAgentId = role === "research" ? operation.agentId : operation.gateAgentId;
  const baselineRevisionId = role === "research"
    ? operation.successorRevisionId
    : operation.backupGateLatestRevisionId;
  const consumedAt = role === "research"
    ? operation.researchAdmissionConsumedAt
    : operation.gateAdmissionConsumedAt;
  const admissionRevisionId = role === "research"
    ? operation.researchAdmissionRevisionId
    : operation.gateAdmissionRevisionId;
  const reason = role === "research" ? "attested_backup_restore" : "attested_backup_restore_gate";
  if (operationAgentId !== agentId || !baselineRevisionId) {
    throw conflict(`${role} admission scope does not match the attested restore operation`);
  }
  const fence = await tx
    .select()
    .from(agentMaintenanceFences)
    .where(eq(agentMaintenanceFences.agentId, agentId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!consumedAt && !admissionRevisionId) {
    if (
      !fence ||
      fence.companyId !== input.companyId ||
      fence.operationId !== input.operationId ||
      fence.reason !== reason
    ) {
      throw conflict(`${role} admission fence is absent or owned by another operation`);
    }
    const history = await tx
      .select({ id: agentConfigRevisions.id, afterConfig: agentConfigRevisions.afterConfig })
      .from(agentConfigRevisions)
      .where(and(
        eq(agentConfigRevisions.companyId, input.companyId),
        eq(agentConfigRevisions.agentId, agentId),
      ))
      .orderBy(sql`${agentConfigRevisions.createdAt} DESC`, sql`${agentConfigRevisions.id} DESC`)
      .limit(1);
    const head = history[0] ?? null;
    if (
      head?.id !== baselineRevisionId ||
      !configSnapshotEqual(head.afterConfig, buildSanitizedConfigSnapshot(lockedAgent))
    ) {
      throw conflict(`${role} admission fence no longer protects the exact baseline revision head`);
    }
    return { kind: "present" };
  }
  if (!consumedAt || !admissionRevisionId || fence) {
    throw conflict(`${role} admission receipt and fence state are inconsistent`);
  }
  const [baseline, admission] = await Promise.all([
    tx.select().from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.id, baselineRevisionId),
      eq(agentConfigRevisions.companyId, input.companyId),
      eq(agentConfigRevisions.agentId, agentId),
    )).then((rows) => rows[0] ?? null),
    tx.select().from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.id, admissionRevisionId),
      eq(agentConfigRevisions.companyId, input.companyId),
      eq(agentConfigRevisions.agentId, agentId),
    )).then((rows) => rows[0] ?? null),
  ]);
  if (
    !baseline ||
    !admission ||
    admission.source !== "patch" ||
    admission.rolledBackFromRevisionId !== null ||
    !configSnapshotEqual(admission.beforeConfig, baseline.afterConfig) ||
    !isExactRoleCandidateCutover(
      admission.afterConfig,
      baseline.afterConfig,
      role,
      operation.cutoverGeneration,
      operation.cutoverRequiredPatch,
    )
  ) {
    throw conflict(`${role} admission revision is missing or substituted`);
  }
  return { kind: "consumed", revisionId: admissionRevisionId };
}

async function assertCompletedRecoveryProof(
  tx: Db,
  operation: typeof attestedConfigRestoreOperations.$inferSelect,
  scope: RecoveryScope,
): Promise<void> {
  if (!operation.successorRevisionId || !operation.auditEventId) {
    throw conflict("Completed attested restore is missing durable terminal evidence");
  }
  const [successor, predecessor, cutover] = await Promise.all([
    tx.select().from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.id, operation.successorRevisionId),
      eq(agentConfigRevisions.companyId, scope.companyId),
      eq(agentConfigRevisions.agentId, scope.agentId),
    )).then((rows) => rows[0] ?? null),
    tx.select().from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.id, operation.predecessorRevisionId),
      eq(agentConfigRevisions.companyId, scope.companyId),
      eq(agentConfigRevisions.agentId, scope.agentId),
    )).then((rows) => rows[0] ?? null),
    tx.select().from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.id, operation.cutoverRevisionId),
      eq(agentConfigRevisions.companyId, scope.companyId),
      eq(agentConfigRevisions.agentId, scope.agentId),
    )).then((rows) => rows[0] ?? null),
  ]);
  if (
    !successor || !predecessor || !cutover ||
    successor.source !== "attested_backup_restore" ||
    successor.rolledBackFromRevisionId !== operation.cutoverRevisionId ||
    !configSnapshotEqual(successor.beforeConfig, cutover.afterConfig) ||
    !configSnapshotEqual(successor.afterConfig, predecessor.afterConfig)
  ) {
    throw conflict("Completed attested restore successor proof is missing or substituted");
  }
  const audit = await tx.select().from(activityLog).where(and(
    eq(activityLog.id, operation.auditEventId),
    eq(activityLog.companyId, scope.companyId),
    eq(activityLog.agentId, scope.agentId),
    eq(activityLog.actorType, "system"),
    eq(activityLog.actorId, "attested_backup_recovery"),
    eq(activityLog.action, "agent.config.attested_backup_restored"),
    eq(activityLog.entityType, "agent"),
    eq(activityLog.entityId, scope.agentId),
  )).then((rows) => rows[0] ?? null);
  const details = audit?.details;
  if (!audit || !isRecord(details) ||
    details.operationId !== operation.id ||
    details.predecessorRevisionId !== operation.predecessorRevisionId ||
    details.cutoverRevisionId !== operation.cutoverRevisionId ||
    details.successorRevisionId !== operation.successorRevisionId ||
    details.backupCheckpointId !== operation.backupCheckpointId ||
    details.cutoverGeneration !== operation.cutoverGeneration ||
    details.cutoverRequiredPatch !== operation.cutoverRequiredPatch ||
    !isResearchCandidateCutover(cutover.afterConfig, operation.cutoverGeneration, operation.cutoverRequiredPatch)) {
    throw conflict("Completed attested restore audit proof is missing or substituted");
  }
}

export async function inspectAttestedBackupRecovery(
  db: Db,
  input: AttestedBackupRecoveryInput,
): Promise<AttestedBackupRecoveryResult> {
  const backup = parseBackupAgent(input.backupAgent, input);
  const backupGate = parseBackupGateAgent(input.backupGateAgent, input);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const locked = await lockRecoveryAndGateAgents(txDb, input);
    await assertPausedAndDrained(txDb, input, locked.recovery);
    await assertGateBackupCurrentExact(txDb, input, backupGate, locked.gate);
    await assertHistoryAndBackup(txDb, input, backup, locked.recovery);
    return recoveryResult("inspected", input, null, null);
  });
}

export async function applyAttestedBackupRecovery(
  db: Db,
  input: AttestedBackupRecoveryInput,
): Promise<AttestedBackupRecoveryResult> {
  const backup = parseBackupAgent(input.backupAgent, input);
  const backupGate = parseBackupGateAgent(input.backupGateAgent, input);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Canonical lifecycle lock order is agent -> operation -> fence ->
    // revisions.  The operation may not exist yet, so its row cannot safely
    // be the first serialization point for first apply.
    const locked = await lockRecoveryAndGateAgents(txDb, input);
    const existingOperation = await txDb
      .select()
      .from(attestedConfigRestoreOperations)
      .where(eq(attestedConfigRestoreOperations.id, input.operationId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (existingOperation) {
      if (!sameOperation(existingOperation, input) || existingOperation.status !== "completed") {
        throw conflict("Restore operation identifier is already bound to a different or incomplete operation");
      }
      await readCompletedOperationReleaseState(txDb, existingOperation, input);
      await assertCompletedRecoveryProof(txDb, existingOperation, input);
      await readRoleAdmissionFenceState(txDb, existingOperation, input, "research", locked.recovery);
      const gateState = await readRoleAdmissionFenceState(txDb, existingOperation, input, "gate", locked.gate);
      if (gateState.kind === "present") {
        await assertGateBackupCurrentExact(txDb, input, backupGate, locked.gate);
      }
      return recoveryResult("already_applied", input, existingOperation.successorRevisionId, existingOperation.auditEventId);
    }
    // A missing operation row cannot itself be locked. The agent lock is the
    // serialization point for first apply, so re-read the operation after it
    // is held and make an overlapping identical request idempotent rather than
    // misclassifying the newly restored successor as a stale head.
    const settledOperation = await txDb
      .select()
      .from(attestedConfigRestoreOperations)
      .where(eq(attestedConfigRestoreOperations.id, input.operationId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (settledOperation) {
      if (!sameOperation(settledOperation, input) || settledOperation.status !== "completed") {
        throw conflict("Restore operation identifier is already bound to a different or incomplete operation");
      }
      await readCompletedOperationReleaseState(txDb, settledOperation, input);
      await assertCompletedRecoveryProof(txDb, settledOperation, input);
      await readRoleAdmissionFenceState(txDb, settledOperation, input, "research", locked.recovery);
      const gateState = await readRoleAdmissionFenceState(txDb, settledOperation, input, "gate", locked.gate);
      if (gateState.kind === "present") {
        await assertGateBackupCurrentExact(txDb, input, backupGate, locked.gate);
      }
      return recoveryResult("already_applied", input, settledOperation.successorRevisionId, settledOperation.auditEventId);
    }
    await assertPausedAndDrained(txDb, input, locked.recovery);
    await assertGateBackupCurrentExact(txDb, input, backupGate, locked.gate);
    const { predecessor, cutover, liveProjection } = await assertHistoryAndBackup(txDb, input, backup, locked.recovery);

    const existingFences = await txDb
      .select()
      .from(agentMaintenanceFences)
      .where(inArray(agentMaintenanceFences.agentId, [input.agentId, input.gateAgentId]))
      .orderBy(asc(agentMaintenanceFences.agentId))
      .for("update");
    if (existingFences.length !== 0) {
      throw conflict("A maintenance fence already owns the Research or Gate agent");
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
    // The agent row remains locked and paused from the start of this
    // transaction. Insert the fence only after the one allowed restore write;
    // on commit, observers can see either neither change or both, and the DB
    // trigger forbids every later configuration-field write while fenced.
    await txDb.insert(agentMaintenanceFences).values([
      {
        agentId: input.agentId,
        companyId: input.companyId,
        operationId: input.operationId,
        reason: "attested_backup_restore",
      },
      {
        agentId: input.gateAgentId,
        companyId: input.companyId,
        operationId: input.operationId,
        reason: "attested_backup_restore_gate",
      },
    ]);
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
        cutoverGeneration: input.cutoverGeneration,
        cutoverRequiredPatch: input.cutoverRequiredPatch,
      },
    }).returning({ id: activityLog.id });
    if (!audit) throw new Error("Could not record attested restore audit event");

    await txDb.insert(attestedConfigRestoreOperations).values({
      id: input.operationId,
      companyId: input.companyId,
      agentId: input.agentId,
      gateAgentId: input.gateAgentId,
      expectedHeadRevisionId: input.expectedHeadRevisionId,
      cutoverRevisionId: input.cutoverRevisionId,
      predecessorRevisionId: input.predecessorRevisionId,
      cutoverGeneration: input.cutoverGeneration,
      cutoverRequiredPatch: input.cutoverRequiredPatch,
      backupCheckpointId: input.backupCheckpointId,
      backupGateLatestRevisionId: input.backupGateLatestRevisionId,
      status: "completed",
      successorRevisionId: successor.id,
      auditEventId: audit.id,
      completedAt: new Date(),
    });

    return recoveryResult("applied", input, successor.id, audit.id);
  });
}

/**
 * Open the next explicitly reviewed, still-paused handoff only after the
 * recovery successor is still the current head. The fence is operation-owned;
 * retries prove the original release audit and can never remove another
 * operation's fence.
 */
export async function releaseAttestedBackupRecoveryFence(
  db: Db,
  input: RecoveryReleaseScope,
): Promise<AttestedBackupFenceReleaseResult> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Match apply's canonical order.  In particular, a release must never
    // hold operation/fence while waiting for an apply holding the agent.
    const locked = await lockRecoveryAndGateAgents(txDb, input);
    const operation = await txDb
      .select()
      .from(attestedConfigRestoreOperations)
      .where(and(
        eq(attestedConfigRestoreOperations.id, input.operationId),
        eq(attestedConfigRestoreOperations.companyId, input.companyId),
        eq(attestedConfigRestoreOperations.agentId, input.agentId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!operation || operation.status !== "completed" || !operation.successorRevisionId) {
      throw conflict("Fence release is not bound to a completed attested restore operation");
    }
    if (operation.gateAgentId !== input.gateAgentId) {
      throw conflict("Fence release Gate scope does not match the completed operation");
    }
    // Release input deliberately contains IDs only. The completed proof must
    // derive every lineage value from the locked durable operation, never from
    // a widened caller object that could be absent or substituted.
    await assertCompletedRecoveryProof(txDb, operation, input);
    const releaseState = await readCompletedOperationReleaseState(txDb, operation, input);
    const researchState = await readRoleAdmissionFenceState(txDb, operation, input, "research", locked.recovery);
    const gateState = await readRoleAdmissionFenceState(txDb, operation, input, "gate", locked.gate);
    if (releaseState.kind === "released") {
      return {
        status: "already_released",
        operationId: input.operationId,
        successorRevisionId: operation.successorRevisionId,
        auditEventId: releaseState.auditEventId,
      };
    }
    if (researchState.kind !== "present" || gateState.kind !== "present") {
      throw conflict("First release requires both unconsumed role admission fences");
    }
    // Only the first release needs live operational preconditions.  A retry
    // after its commit may legitimately observe a resumed agent and a newer
    // revision, and is handled above from the owned durable receipt.
    await assertPausedAndDrained(txDb, input, locked.recovery);
    await assertPausedAndDrained(txDb, { ...input, agentId: input.gateAgentId }, locked.gate);
    await txDb.execute(sql`
      SELECT id FROM agent_config_revisions
      WHERE company_id = ${input.companyId} AND agent_id = ${input.agentId}
      ORDER BY created_at, id FOR UPDATE
    `);
    const head = await txDb
      .select({ id: agentConfigRevisions.id, afterConfig: agentConfigRevisions.afterConfig })
      .from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.companyId, input.companyId), eq(agentConfigRevisions.agentId, input.agentId)))
      .orderBy(sql`${agentConfigRevisions.createdAt} DESC`, sql`${agentConfigRevisions.id} DESC`)
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (head?.id !== operation.successorRevisionId) {
      throw conflict("Fence release requires the attested successor to remain the exact current head");
    }
    if (!configSnapshotEqual(buildSanitizedConfigSnapshot(locked.recovery), head.afterConfig)) {
      throw conflict("Fence release requires the live configuration to remain the exact attested successor");
    }
    const [audit] = await txDb.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "attested_backup_recovery",
      action: "agent.config.attested_backup_restore_fence_released",
      entityType: "agent",
      entityId: input.agentId,
      agentId: input.agentId,
      details: { operationId: input.operationId, successorRevisionId: operation.successorRevisionId },
    }).returning({ id: activityLog.id });
    if (!audit) throw new Error("Could not record attested fence release audit event");
    await txDb.update(attestedConfigRestoreOperations).set({
      fenceReleasedAt: new Date(),
      fenceReleaseAuditEventId: audit.id,
    }).where(eq(attestedConfigRestoreOperations.id, input.operationId));
    return {
      status: "fence_released",
      operationId: input.operationId,
      successorRevisionId: operation.successorRevisionId,
      auditEventId: audit.id,
    };
  });
}
