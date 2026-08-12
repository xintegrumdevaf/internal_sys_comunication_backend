export type QualityFindingSeverity = "low" | "medium" | "high";
export type QualityFindingCategory =
  | "aggression"
  | "disrespect"
  | "neglect"
  | "misinformation"
  | "inefficiency"
  | "other";

export interface QualityFinding {
  id: string;
  reviewId: string;
  messageId: string;
  severity: QualityFindingSeverity;
  category: QualityFindingCategory;
  excerpt: string;
  rationale: string;
  createdAt: Date;
}
