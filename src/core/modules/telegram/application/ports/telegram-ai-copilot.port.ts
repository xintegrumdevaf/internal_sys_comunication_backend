export type ExecutiveIntent =
  | "METRICS_OVERVIEW"
  | "SLA_BREACHES"
  | "AGENTS_STATUS"
  | "INFRA_ALERTS"
  | "OUT_OF_SCOPE";

export interface ExecutiveIntentClassification {
  intent: ExecutiveIntent;
  sector?: string;
  minWaitMinutes?: number;
  confidence: number;
}

export interface SynthesizeExecutiveReplyInput {
  question: string;
  intent: ExecutiveIntent;
  groundTruth: string;
}

export interface TelegramAiCopilotPort {
  /**
   * Clasifica la intención operativa de la pregunta enviada por un gerente o administrador.
   */
  classifyQuestion(question: string): Promise<ExecutiveIntentClassification>;

  /**
   * Sintetiza una respuesta ejecutiva estructurada en HTML utilizando exclusivamente los datos reales provistos (Ground Truth).
   */
  synthesizeReply(input: SynthesizeExecutiveReplyInput): Promise<string>;
}

