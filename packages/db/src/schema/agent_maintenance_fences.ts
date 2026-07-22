import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * An explicit, transaction-visible admission stop for a single agent.
 *
 * Pausing is the normal lifecycle control. A fence is deliberately narrower:
 * it closes the stale-read window between a wake-up's initial eligibility check
 * and the transaction that would enqueue or claim work.
 */
export const agentMaintenanceFences = pgTable(
  "agent_maintenance_fences",
  {
    agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOperationAgentUnique: uniqueIndex("agent_maintenance_fences_company_operation_agent_unique").on(
      table.companyId,
      table.operationId,
      table.agentId,
    ),
  }),
);
