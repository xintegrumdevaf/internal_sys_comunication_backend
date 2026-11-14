export type CrmSalesEventType =
  | "sales.lead.escalated"
  | "sales.lead.no_coverage"
  | "sales.message.received"
  | "sales.message.sent";

export interface CrmSalesWebhookEvent {
  eventId: string;
  eventType: CrmSalesEventType;
  occurredAt: string;
  conversationId: string;
  caseId?: string;
  customerId?: string;
  waPhone: string;
  fullName?: string;
  nationalId?: string;
  requestedSpeed?: string;
  address?: string;
  coordinates?: { lat: number; lng: number };
  coverage?: {
    hasCoverage: boolean;
    zoneName?: string;
    city?: string;
    reason?: string;
  };
  lastMessageBody?: string;
}

export interface CrmBridgeDeliveryResult {
  delivered: boolean;
  status?: number;
  error?: string;
}

/**
 * Outbound port to notify CRM_sys_backend of sales-related ISP events (ADR-003).
 */
export interface CrmBridgePort {
  isEnabled(): boolean;
  notifySalesEvent(
    event: CrmSalesWebhookEvent,
    options?: { correlationId?: string },
  ): Promise<CrmBridgeDeliveryResult>;
}
