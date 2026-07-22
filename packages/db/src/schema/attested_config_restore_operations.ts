import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentConfigRevisions } from "./agent_config_revisions.js";

/**
 * Non-secret receipt for the one-off backup-backed configuration recovery.
 * This table intentionally never stores configuration data, fingerprints, or
 * backup locations. It makes a retry after a lost CLI response idempotent.
 */
export const attestedConfigRestoreOperations = pgTable(
  "attested_config_restore_operations",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    gateAgentId: uuid("gate_agent_id").notNull().references(() => agents.id),
    expectedHeadRevisionId: uuid("expected_head_revision_id").notNull(),
    cutoverRevisionId: uuid("cutover_revision_id").notNull(),
    predecessorRevisionId: uuid("predecessor_revision_id").notNull(),
    cutoverGeneration: text("cutover_generation").notNull(),
    cutoverRequiredPatch: text("cutover_required_patch").notNull(),
    backupCheckpointId: uuid("backup_checkpoint_id").notNull(),
    backupGateLatestRevisionId: uuid("backup_gate_latest_revision_id").notNull(),
    status: text("status").notNull(),
    successorRevisionId: uuid("successor_revision_id"),
    auditEventId: uuid("audit_event_id"),
    fenceReleaseAuditEventId: uuid("fence_release_audit_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    fenceReleasedAt: timestamp("fence_released_at", { withTimezone: true }),
    gateAdmissionConsumedAt: timestamp("gate_admission_consumed_at", { withTimezone: true }),
    gateAdmissionRevisionId: uuid("gate_admission_revision_id").references(() => agentConfigRevisions.id),
    researchAdmissionConsumedAt: timestamp("research_admission_consumed_at", { withTimezone: true }),
    researchAdmissionRevisionId: uuid("research_admission_revision_id").references(() => agentConfigRevisions.id),
  },
  (table) => ({
    companyAgentOperationUnique: uniqueIndex("attested_config_restore_company_agent_operation_unique").on(
      table.companyId,
      table.agentId,
      table.id,
    ),
  }),
);
