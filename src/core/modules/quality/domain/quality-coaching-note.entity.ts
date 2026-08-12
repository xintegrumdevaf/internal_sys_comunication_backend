export type CoachingNoteAckStatus = "open" | "acknowledged";

export interface QualityCoachingNote {
  id: string;
  reviewId: string;
  authorAgentId: string;
  body: string;
  ackStatus: CoachingNoteAckStatus;
  acknowledgedAt: Date | null;
  createdAt: Date;
}
