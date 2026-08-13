export type QualityReviewStatus = "pending" | "ready" | "failed" | "reviewed";
export type QualityTriggerKind = "auto_case_closed" | "on_demand";

/**
 * Revision de calidad de atencion humana (01_DATA_MODEL.md / 07_QUALITY_SUPERVISION.md).
 * En DB: `trigger_kind`; en DTO HTTP: `trigger`.
 * 1 caso cerrado con mensajes agent = 1 review = 1 score de chat (tras cubrir todos los tramos).
 */
export interface QualityReview {
  id: string;
  conversationId: string;
  caseId: string;
  agentId: string;
  departmentId: string | null;
  cordialityScore: number | null;
  efficiencyNotes: string | null;
  summary: string | null;
  errorMessage: string | null;
  status: QualityReviewStatus;
  triggerKind: QualityTriggerKind;
  /** Salida validada + acumulado de tramos; nunca exponer al frontend. */
  modelRaw: unknown | null;
  idempotencyKey: string;
  /** Turnos customer+agent del caso (0 hasta el primer claim). */
  messagesTotal: number;
  /** Mensajes ya enviados a la IA en tramos. */
  messagesAnalyzed: number;
  /** Tamaño de tramo fijado al encolar (`QUALITY_ANALYSIS_CHUNK_SIZE`). */
  chunkSize: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** Campos de conversacion/cliente para listados (JOIN; no viven en quality_review). */
export type QualityReviewCustomerContext = {
  customerLabel: string;
  waPhone: string;
  waProfileName: string | null;
  highFindingCount: number;
  findingCount: number;
};

export type QualityReviewListItem = QualityReview & QualityReviewCustomerContext;
