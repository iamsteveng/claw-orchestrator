/** Request sent from slack-relay to tenant runtime on POST /message (port 3100) */
export interface RelayMessageRequest {
  messageId: string;
  slackEventId: string;
  userId: string;
  teamId: string;
  text: string;
  slackPayload: Record<string, unknown>;
  timestamp: number;
}

/** Successful response from tenant runtime */
export interface RelayMessageResponseOk {
  ok: true;
  response: string;
  blocks: unknown[] | null;
}

/** Error response from tenant runtime */
export interface RelayMessageResponseError {
  ok: false;
  error: string;
}

export type RelayMessageResponse = RelayMessageResponseOk | RelayMessageResponseError;
