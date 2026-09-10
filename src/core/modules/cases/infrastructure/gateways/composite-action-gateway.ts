import type { ExecuteActionParams, N8nActionResult, N8nGatewayPort } from "../../application/ports/n8n-gateway.port";

export type CompositeActionGatewayConfig = {
  n8nGateway: N8nGatewayPort;
  diagnosticGateway: N8nGatewayPort;
};

const DIRECT_MIKROTIK_ACTIONS = new Set([
  "DIAGNOSTIC",
  "CONTINUE_DIAGNOSTIC",
  "CHECK_CLIENT_STATUS",
  "CLIENT_STATUS",
]);

/**
 * Gateway compuesto que enruta la ejecucion de acciones segun su tipo:
 * - `DIAGNOSTIC`, `CONTINUE_DIAGNOSTIC`, `CHECK_CLIENT_STATUS` se derivan al adapter directo de MikroTik (`MikrotikDiagnosticAdapter`).
 * - Acciones de integracion con terceros (`VALIDATE_CLIENT`, `CHECK_BALANCE`, `RECORD_PAYMENT`, `APPLY_BANK_ACCOUNT`)
 *   se derivan a `N8nGatewayHttp`.
 *
 * Mantiene compatibilidad total con `N8nGatewayPort` y con `InstrumentedN8nGateway` para persistencia
 * de ejecuciones, trazabilidad y hash de idempotencia.
 */
export class CompositeActionGateway implements N8nGatewayPort {
  private readonly n8nGateway: N8nGatewayPort;
  private readonly diagnosticGateway: N8nGatewayPort;

  constructor(config: CompositeActionGatewayConfig) {
    this.n8nGateway = config.n8nGateway;
    this.diagnosticGateway = config.diagnosticGateway;
  }

  async executeAction(params: ExecuteActionParams): Promise<N8nActionResult> {
    if (DIRECT_MIKROTIK_ACTIONS.has(params.action)) {
      return this.diagnosticGateway.executeAction(params);
    }

    return this.n8nGateway.executeAction(params);
  }
}
