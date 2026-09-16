import type { MessageStatus } from "./message.entity";

export interface ZernioHistoricalConversation {
  id: string;
  participantId: string;
  participantName?: string | null;
  lastMessage?: string | null;
  updatedTime?: string;
  unreadCount?: number;
}

export interface ZernioHistoricalMessageAttachment {
  type?: string;
  url?: string;
  mimeType?: string;
  filename?: string;
}

export interface ZernioHistoricalMessage {
  id: string;
  conversationId: string;
  message: string;
  direction: "incoming" | "outgoing";
  senderId: string;
  senderName?: string | null;
  senderPhoneNumber?: string | null;
  createdAt: string;
  sentVia?: string | null;
  status?: MessageStatus;
  errorMessage?: string | null;
  attachments?: ZernioHistoricalMessageAttachment[];
}

export interface ZernioSyncJob {
  jobId: string;
  zernioConversationId: string;
  participantId: string;
  participantName?: string | null;
  updatedTime?: string | null;
  attempt: number;
}

export type ZernioSyncStatus = "IDLE" | "IN_PROGRESS" | "COMPLETED" | "PARTIALLY_FAILED" | "FAILED";

export interface ZernioSyncProgress {
  jobId: string;
  status: ZernioSyncStatus;
  totalConversations: number;
  processedConversations: number;
  failedConversations: number;
  totalMessagesImported: number;
  totalMessagesSkipped: number;
  currentPhone: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errors: Array<{
    phone: string;
    conversationId: string;
    error: string;
    timestamp: string;
  }>;
}
