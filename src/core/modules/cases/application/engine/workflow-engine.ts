import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { WorkflowDefinition, WorkflowStepInput, WorkflowStepOutcome } from "./workflow-definition";

/**
 * Motor de workflow declarativo (docs/spec/02_STATE_MACHINE.md §1-3): las
 * definiciones (estados/transiciones) son datos inyectados, el motor solo
 * busca el handler del estado actual y lo ejecuta. Agregar un workflow nuevo
 * (Etapa 8) es agregar una `WorkflowDefinition` mas, nunca tocar esta clase
 * (Open/Closed, docs/skills/solid-principles.md).
 */
export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  constructor(definitions: WorkflowDefinition[]) {
    for (const definition of definitions) {
      this.definitions.set(definition.workflowType, definition);
    }
  }

  getDefinition(workflowType: string): WorkflowDefinition | undefined {
    return this.definitions.get(workflowType);
  }

  async step(workflowType: string, input: WorkflowStepInput): Promise<WorkflowStepOutcome> {
    const definition = this.definitions.get(workflowType);
    if (!definition) {
      throw new DomainError("UNSUPPORTED", `No hay WorkflowDefinition registrada para '${workflowType}'`);
    }
    const handler = definition.states[input.currentState];
    if (!handler) {
      throw new DomainError(
        "UNSUPPORTED",
        `El workflow '${workflowType}' no tiene un handler para el estado '${input.currentState}'`,
      );
    }
    return handler(input);
  }
}
