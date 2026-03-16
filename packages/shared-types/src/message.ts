export enum MessageStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

export interface MessageQueueRow {
  id: string;
  tenant_id: string;
  slack_event_id: string;
  payload: string;
  status: MessageStatus;
  attempts: number;
  created_at: number;
  updated_at: number;
  deliver_after: number | null;
  error: string | null;
}
