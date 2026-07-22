ALTER TABLE "attested_config_restore_operations" ADD COLUMN "fence_release_audit_event_id" uuid;
--> statement-breakpoint
ALTER TABLE "attested_config_restore_operations" ADD COLUMN "fence_released_at" timestamp with time zone;
