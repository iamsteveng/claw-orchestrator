import type { PrismaClient } from '@prisma/client';
import type { AuditEventType } from '@claw/shared-types';
import { randomUUID } from 'node:crypto';

export interface WriteAuditLogParams {
  tenantId?: string | null;
  eventType: AuditEventType;
  actor: string;
  metadata?: Record<string, unknown>;
}

export async function writeAuditLog(
  prisma: PrismaClient,
  params: WriteAuditLogParams,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      id: randomUUID(),
      tenant_id: params.tenantId ?? null,
      event_type: params.eventType,
      actor: params.actor,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      created_at: Date.now(),
    },
  });
}
