CREATE TABLE "agent_maintenance_fences" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_maintenance_fences_company_operation_unique" ON "agent_maintenance_fences" USING btree ("company_id","operation_id");
--> statement-breakpoint
ALTER TABLE "agent_maintenance_fences" ADD CONSTRAINT "agent_maintenance_fences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_maintenance_fences" ADD CONSTRAINT "agent_maintenance_fences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "attested_config_restore_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"expected_head_revision_id" uuid NOT NULL,
	"cutover_revision_id" uuid NOT NULL,
	"predecessor_revision_id" uuid NOT NULL,
	"backup_checkpoint_id" uuid NOT NULL,
	"status" text NOT NULL,
	"successor_revision_id" uuid,
	"audit_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attested_config_restore_company_agent_operation_unique" ON "attested_config_restore_operations" USING btree ("company_id","agent_id","id");
--> statement-breakpoint
ALTER TABLE "attested_config_restore_operations" ADD CONSTRAINT "attested_config_restore_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attested_config_restore_operations" ADD CONSTRAINT "attested_config_restore_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
