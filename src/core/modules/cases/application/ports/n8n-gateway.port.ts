/**
 * docs/spec/03_API_CONTRACT.md §B — llamada sincrona API -> n8n, una accion a
 * la vez. Solo `executeAction`: el motor de workflow decide QUE accion llamar
 * y con que `input` (ya resuelto desde el contexto persistido, nunca inventado
 * por un LLM); este port no sabe nada de negocio.
 *
 * La implementacion HTTP real (resolviendo la URL desde `n8n_workflow_registry`)
 * llega en la Etapa 3 (`infrastructure/n8n/n8n-gateway.http.ts`). Aqui solo se
 * declara el contrato para que el motor de la Etapa 2 pueda depender de el.
 */
import type { DomainErrorType } from "../../../../../shared/errors/domain-errors";

export type N8nActionInput = Record<string, unknown>;

export type N8nActionSuccess = {
  success: true;
  result: Record<string, unknown>;
};

export type N8nActionFailure = {
  success: false;
  error: {
    type: DomainErrorType;
    message: string;
    retryable: boolean;
  };
};

export type N8nActionResult = N8nActionSuccess | N8nActionFailure;

export type ExecuteActionParams = {
  action: string;
  caseId: string;
  conversationId: string;
  correlationId: string;
  input: N8nActionInput;
};

export interface N8nGatewayPort {
  executeAction(params: ExecuteActionParams): Promise<N8nActionResult>;
}
