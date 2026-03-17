-- Enable WAL mode for concurrent reads
PRAGMA journal_mode=WAL;

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "principal" TEXT NOT NULL,
    "slack_team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "relay_token" TEXT NOT NULL,
    "container_name" TEXT,
    "image_tag" TEXT,
    "data_dir" TEXT NOT NULL,
    "last_activity_at" INTEGER,
    "last_started_at" INTEGER,
    "last_stopped_at" INTEGER,
    "provisioned_at" INTEGER,
    "provision_attempts" INTEGER NOT NULL DEFAULT 0,
    "resource_overrides" TEXT,
    "disk_quota_exceeded" INTEGER NOT NULL DEFAULT 0,
    "allowlist_entry_id" TEXT,
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL,
    "deleted_at" INTEGER,
    "deletion_requested_at" INTEGER,
    "error_message" TEXT,
    CONSTRAINT "tenants_allowlist_entry_id_fkey" FOREIGN KEY ("allowlist_entry_id") REFERENCES "allowlist" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "message_queue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "slack_event_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL,
    "deliver_after" INTEGER,
    "error" TEXT,
    CONSTRAINT "message_queue_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "startup_locks" (
    "tenant_id" TEXT NOT NULL PRIMARY KEY,
    "locked_by" TEXT NOT NULL,
    "acquired_at" INTEGER NOT NULL,
    "expires_at" INTEGER NOT NULL,
    CONSTRAINT "startup_locks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT,
    "event_type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "metadata" TEXT,
    "created_at" INTEGER NOT NULL,
    CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "allowlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slack_team_id" TEXT NOT NULL,
    "slack_user_id" TEXT,
    "added_by" TEXT NOT NULL,
    "note" TEXT,
    "created_at" INTEGER NOT NULL,
    "revoked_at" INTEGER
);

-- CreateTable
CREATE TABLE "container_images" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tag" TEXT NOT NULL,
    "digest" TEXT,
    "is_default" INTEGER NOT NULL DEFAULT 0,
    "release_notes" TEXT,
    "created_at" INTEGER NOT NULL,
    "deprecated_at" INTEGER
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_principal_key" ON "tenants"("principal");

-- CreateIndex
CREATE INDEX "tenants_slack_team_id_slack_user_id_idx" ON "tenants"("slack_team_id", "slack_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_queue_slack_event_id_key" ON "message_queue"("slack_event_id");

-- CreateIndex
CREATE INDEX "message_queue_tenant_id_status_created_at_idx" ON "message_queue"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "allowlist_slack_team_id_slack_user_id_revoked_at_idx" ON "allowlist"("slack_team_id", "slack_user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "container_images_tag_key" ON "container_images"("tag");
