/*
  Warnings:

  - You are about to alter the column `created_at` on the `allowlist` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `created_at` on the `audit_log` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `created_at` on the `container_images` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `created_at` on the `message_queue` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `deliver_after` on the `message_queue` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `updated_at` on the `message_queue` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `acquired_at` on the `startup_locks` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `expires_at` on the `startup_locks` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `created_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `deleted_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `deletion_requested_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `last_activity_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `last_started_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `last_stopped_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `provisioned_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `queued_for_start_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `recovery_attempted_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `updated_at` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_allowlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slack_team_id" TEXT NOT NULL,
    "slack_user_id" TEXT,
    "added_by" TEXT NOT NULL,
    "note" TEXT,
    "created_at" BIGINT NOT NULL,
    "revoked_at" INTEGER
);
INSERT INTO "new_allowlist" ("added_by", "created_at", "id", "note", "revoked_at", "slack_team_id", "slack_user_id") SELECT "added_by", "created_at", "id", "note", "revoked_at", "slack_team_id", "slack_user_id" FROM "allowlist";
DROP TABLE "allowlist";
ALTER TABLE "new_allowlist" RENAME TO "allowlist";
CREATE INDEX "allowlist_slack_team_id_slack_user_id_revoked_at_idx" ON "allowlist"("slack_team_id", "slack_user_id", "revoked_at");
CREATE TABLE "new_audit_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT,
    "event_type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "metadata" TEXT,
    "created_at" BIGINT NOT NULL,
    CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_audit_log" ("actor", "created_at", "event_type", "id", "metadata", "tenant_id") SELECT "actor", "created_at", "event_type", "id", "metadata", "tenant_id" FROM "audit_log";
DROP TABLE "audit_log";
ALTER TABLE "new_audit_log" RENAME TO "audit_log";
CREATE TABLE "new_container_images" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tag" TEXT NOT NULL,
    "digest" TEXT,
    "is_default" INTEGER NOT NULL DEFAULT 0,
    "release_notes" TEXT,
    "created_at" BIGINT NOT NULL,
    "deprecated_at" INTEGER
);
INSERT INTO "new_container_images" ("created_at", "deprecated_at", "digest", "id", "is_default", "release_notes", "tag") SELECT "created_at", "deprecated_at", "digest", "id", "is_default", "release_notes", "tag" FROM "container_images";
DROP TABLE "container_images";
ALTER TABLE "new_container_images" RENAME TO "container_images";
CREATE UNIQUE INDEX "container_images_tag_key" ON "container_images"("tag");
CREATE TABLE "new_message_queue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "slack_event_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "deliver_after" BIGINT,
    "error" TEXT,
    CONSTRAINT "message_queue_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_message_queue" ("attempts", "created_at", "deliver_after", "error", "id", "payload", "slack_event_id", "status", "tenant_id", "updated_at") SELECT "attempts", "created_at", "deliver_after", "error", "id", "payload", "slack_event_id", "status", "tenant_id", "updated_at" FROM "message_queue";
DROP TABLE "message_queue";
ALTER TABLE "new_message_queue" RENAME TO "message_queue";
CREATE UNIQUE INDEX "message_queue_slack_event_id_key" ON "message_queue"("slack_event_id");
CREATE INDEX "message_queue_tenant_id_status_created_at_idx" ON "message_queue"("tenant_id", "status", "created_at");
CREATE TABLE "new_startup_locks" (
    "tenant_id" TEXT NOT NULL PRIMARY KEY,
    "locked_by" TEXT NOT NULL,
    "acquired_at" BIGINT NOT NULL,
    "expires_at" BIGINT NOT NULL,
    CONSTRAINT "startup_locks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_startup_locks" ("acquired_at", "expires_at", "locked_by", "tenant_id") SELECT "acquired_at", "expires_at", "locked_by", "tenant_id" FROM "startup_locks";
DROP TABLE "startup_locks";
ALTER TABLE "new_startup_locks" RENAME TO "startup_locks";
CREATE TABLE "new_tenants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "principal" TEXT NOT NULL,
    "slack_team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "relay_token" TEXT NOT NULL,
    "container_name" TEXT,
    "image_tag" TEXT,
    "data_dir" TEXT NOT NULL,
    "last_activity_at" BIGINT,
    "last_started_at" BIGINT,
    "last_stopped_at" BIGINT,
    "provisioned_at" BIGINT,
    "provision_attempts" INTEGER NOT NULL DEFAULT 0,
    "resource_overrides" TEXT,
    "disk_quota_exceeded" INTEGER NOT NULL DEFAULT 0,
    "allowlist_entry_id" TEXT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "deleted_at" BIGINT,
    "deletion_requested_at" BIGINT,
    "queued_for_start_at" BIGINT,
    "recovery_attempted_at" BIGINT,
    "error_message" TEXT,
    CONSTRAINT "tenants_allowlist_entry_id_fkey" FOREIGN KEY ("allowlist_entry_id") REFERENCES "allowlist" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_tenants" ("allowlist_entry_id", "container_name", "created_at", "data_dir", "deleted_at", "deletion_requested_at", "disk_quota_exceeded", "error_message", "id", "image_tag", "last_activity_at", "last_started_at", "last_stopped_at", "principal", "provision_attempts", "provisioned_at", "queued_for_start_at", "recovery_attempted_at", "relay_token", "resource_overrides", "slack_team_id", "slack_user_id", "status", "updated_at") SELECT "allowlist_entry_id", "container_name", "created_at", "data_dir", "deleted_at", "deletion_requested_at", "disk_quota_exceeded", "error_message", "id", "image_tag", "last_activity_at", "last_started_at", "last_stopped_at", "principal", "provision_attempts", "provisioned_at", "queued_for_start_at", "recovery_attempted_at", "relay_token", "resource_overrides", "slack_team_id", "slack_user_id", "status", "updated_at" FROM "tenants";
DROP TABLE "tenants";
ALTER TABLE "new_tenants" RENAME TO "tenants";
CREATE UNIQUE INDEX "tenants_principal_key" ON "tenants"("principal");
CREATE INDEX "tenants_slack_team_id_slack_user_id_idx" ON "tenants"("slack_team_id", "slack_user_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
