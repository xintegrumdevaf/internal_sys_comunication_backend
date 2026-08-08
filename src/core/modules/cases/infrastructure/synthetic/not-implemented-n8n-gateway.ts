import type { ExecuteActionParams, N8nActionResult, N8nGatewayPort } from "../../application/ports/n8n-gateway.port";

/**
 * Placeholder de `N8nGatewayPort` para la Etapa 2: el motor de workflow ya
 * sabe llamar acciones, pero la implementacion HTTP real (resolviendo
 * `n8n_workflow_registry`) llega en la Etapa 3. Mientras el `InterpretationPort`
 * siga siendo `UnclearInterpretationProvider`, la arbitracion nunca crea ni
 * avanza un caso real, asi que este gateway nunca deberia ejecutarse en
 * produccion — si lo hace, es una senal de un bug, por eso falla ruidosamente
 * en vez de devolver un resultado inventado.
 */
export class NotImplementedN8nGateway implements N8nGatewayPort {
  async executeAction(params: ExecuteActionParams): Promise<N8nActionResult> {
    throw new Error(
      `N8nGatewayPort real no implementado todavia (Etapa 3) — intento de ejecutar la accion '${params.action}' para el caso ${params.caseId}`,
    );
  }
}
