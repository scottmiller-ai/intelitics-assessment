CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "app" AUTHORIZATION migrator;
--> statement-breakpoint
CREATE TABLE "app"."customers" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_id_not_blank" CHECK (length(btrim("app"."customers"."id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."ingest_rejections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."ingest_rejections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_processing_id" uuid NOT NULL,
	"source_index" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"reason" text NOT NULL,
	"rejection_hash" text NOT NULL,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_rejections_source_index_nonnegative" CHECK ("app"."ingest_rejections"."source_index" >= 0),
	CONSTRAINT "ingest_rejections_reason_valid" CHECK ("app"."ingest_rejections"."reason" IN ('invalid_record', 'missing_customer_id', 'invalid_customer_id', 'missing_event_type', 'invalid_event_type', 'missing_occurred_at', 'ambiguous_occurred_at', 'invalid_occurred_at', 'invalid_endpoint', 'invalid_user_email', 'invalid_plan', 'invalid_metadata', 'invalid_duration_ms', 'invalid_status')),
	CONSTRAINT "ingest_rejections_hash_format" CHECK ("app"."ingest_rejections"."rejection_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app"."ingest_source_processings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"normalization_policy_version" integer NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_forced" boolean DEFAULT false NOT NULL,
	"accepted_count" integer,
	"duplicate_count" integer,
	"rejected_count" integer,
	"error_code" text,
	"error_details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ingest_source_processings_source_policy_unique" UNIQUE("source_id","normalization_policy_version"),
	CONSTRAINT "ingest_source_processings_policy_positive" CHECK ("app"."ingest_source_processings"."normalization_policy_version" > 0),
	CONSTRAINT "ingest_source_processings_status_valid" CHECK ("app"."ingest_source_processings"."status" IN ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "ingest_source_processings_attempt_nonnegative" CHECK ("app"."ingest_source_processings"."attempt_count" >= 0),
	CONSTRAINT "ingest_source_processings_counts_nonnegative" CHECK (("app"."ingest_source_processings"."accepted_count" IS NULL OR "app"."ingest_source_processings"."accepted_count" >= 0)
        AND ("app"."ingest_source_processings"."duplicate_count" IS NULL OR "app"."ingest_source_processings"."duplicate_count" >= 0)
        AND ("app"."ingest_source_processings"."rejected_count" IS NULL OR "app"."ingest_source_processings"."rejected_count" >= 0)),
	CONSTRAINT "ingest_source_processings_state_consistent" CHECK ((
        "app"."ingest_source_processings"."status" = 'succeeded'
        AND "app"."ingest_source_processings"."accepted_count" IS NOT NULL
        AND "app"."ingest_source_processings"."duplicate_count" IS NOT NULL
        AND "app"."ingest_source_processings"."rejected_count" IS NOT NULL
        AND "app"."ingest_source_processings"."completed_at" IS NOT NULL
        AND "app"."ingest_source_processings"."error_code" IS NULL
        AND "app"."ingest_source_processings"."error_details" IS NULL
      ) OR (
        "app"."ingest_source_processings"."status" = 'failed'
        AND "app"."ingest_source_processings"."accepted_count" IS NULL
        AND "app"."ingest_source_processings"."duplicate_count" IS NULL
        AND "app"."ingest_source_processings"."rejected_count" IS NULL
        AND "app"."ingest_source_processings"."completed_at" IS NOT NULL
        AND "app"."ingest_source_processings"."error_code" IN ('invalid_json', 'root_not_array', 'database_error')
      ) OR (
        "app"."ingest_source_processings"."status" = 'pending'
        AND "app"."ingest_source_processings"."accepted_count" IS NULL
        AND "app"."ingest_source_processings"."duplicate_count" IS NULL
        AND "app"."ingest_source_processings"."rejected_count" IS NULL
        AND "app"."ingest_source_processings"."error_code" IS NULL
        AND "app"."ingest_source_processings"."error_details" IS NULL
        AND "app"."ingest_source_processings"."completed_at" IS NULL
        AND "app"."ingest_source_processings"."started_at" IS NULL
      ) OR (
        "app"."ingest_source_processings"."status" = 'running'
        AND "app"."ingest_source_processings"."accepted_count" IS NULL
        AND "app"."ingest_source_processings"."duplicate_count" IS NULL
        AND "app"."ingest_source_processings"."rejected_count" IS NULL
        AND "app"."ingest_source_processings"."error_code" IS NULL
        AND "app"."ingest_source_processings"."error_details" IS NULL
        AND "app"."ingest_source_processings"."completed_at" IS NULL
        AND "app"."ingest_source_processings"."started_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "app"."ingest_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_sha256" text NOT NULL,
	"source_uri" text NOT NULL,
	"source_version" text,
	"byte_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_sources_sha256_format" CHECK ("app"."ingest_sources"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ingest_sources_byte_size_nonnegative" CHECK ("app"."ingest_sources"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_processing_id" uuid NOT NULL,
	"source_index" integer NOT NULL,
	"customer_id" text NOT NULL,
	"event_type" text NOT NULL,
	"endpoint" text,
	"user_email" text,
	"plan" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"status" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingest_hash" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_customer_not_blank" CHECK (length(btrim("app"."usage_events"."customer_id")) > 0),
	CONSTRAINT "usage_events_event_type_not_blank" CHECK (length(btrim("app"."usage_events"."event_type")) > 0),
	CONSTRAINT "usage_events_source_index_nonnegative" CHECK ("app"."usage_events"."source_index" >= 0),
	CONSTRAINT "usage_events_duration_nonnegative" CHECK ("app"."usage_events"."duration_ms" IS NULL OR "app"."usage_events"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."ingest_rejections" ADD CONSTRAINT "ingest_rejections_source_processing_id_ingest_source_processings_id_fk" FOREIGN KEY ("source_processing_id") REFERENCES "app"."ingest_source_processings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ingest_source_processings" ADD CONSTRAINT "ingest_source_processings_source_id_ingest_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "app"."ingest_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."usage_events" ADD CONSTRAINT "usage_events_source_processing_id_ingest_source_processings_id_fk" FOREIGN KEY ("source_processing_id") REFERENCES "app"."ingest_source_processings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."usage_events" ADD CONSTRAINT "usage_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_rejections_hash_idx" ON "app"."ingest_rejections" USING btree ("rejection_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_sources_content_sha256_idx" ON "app"."ingest_sources" USING btree ("content_sha256");--> statement-breakpoint
CREATE INDEX "usage_events_customer_occurred_idx" ON "app"."usage_events" USING btree ("customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_occurred_idx" ON "app"."usage_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_ingest_hash_idx" ON "app"."usage_events" USING btree ("ingest_hash");
--> statement-breakpoint
ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.customers
  USING (id = current_setting('app.current_customer_id', true));

ALTER TABLE app.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.usage_events
  USING (customer_id = current_setting('app.current_customer_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON app.customers, app.ingest_sources, app.ingest_source_processings TO ingest_app;
GRANT SELECT, INSERT ON app.usage_events, app.ingest_rejections TO ingest_app;
GRANT SELECT ON app.customers, app.usage_events TO tenant_app;
GRANT SELECT ON app.usage_events TO billing_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO ingest_app;

ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO ingest_app;