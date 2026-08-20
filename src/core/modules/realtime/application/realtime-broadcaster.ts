/**
 * Eventos de tiempo real (docs/spec/03_API_CONTRACT.md §C.3).
 * Solo notifican IDs; el frontend pide el contenido por REST.
 */
export type RealtimeEvent =
  | {
      type: "MESSAGE_RECEIVED";
      conversationId: string;
      messageId: string;
      bodyPreview?: string;
      authorName?: string;
    }
  | {
      type: "MESSAGE_SENT";
      conversationId: string;
      messageId: string;
      author: "ai" | "agent" | "system";
    }
  | {
      type: "CASE_ESCALATED";
      caseId: string;
      conversationId: string;
      departmentId: string | null;
      at: string;
    }
  | {
      type: "CASE_CLAIMED";
      caseId: string;
      agentUserId: string;
    }
  | {
      type: "HUMAN_ASSIGNED";
      caseId: string;
      agentUserId: string;
    }
  | {
      type: "AUTOMATION_ENABLED";
      caseId: string;
    };

export type RealtimeSubscriber = {
  userId: string;
  /** Departamento IDs del agente (membership + primary); vacío = solo admin o sin filtro. */
  departmentIds: Set<string>;
  role: "agent" | "manager" | "admin";
  send: (event: RealtimeEvent) => void;
};

/**
 * Broadcaster in-process (SSE). Un solo proceso Node: suficiente para Etapa 7.
 */
export class RealtimeBroadcaster {
  private readonly subscribers = new Map<string, Set<RealtimeSubscriber>>();

  subscribe(sub: RealtimeSubscriber): () => void {
    const set = this.subscribers.get(sub.userId) ?? new Set();
    set.add(sub);
    this.subscribers.set(sub.userId, set);
    return () => {
      const current = this.subscribers.get(sub.userId);
      if (!current) return;
      current.delete(sub);
      if (current.size === 0) this.subscribers.delete(sub.userId);
    };
  }

  publish(event: RealtimeEvent): void {
    for (const set of this.subscribers.values()) {
      for (const sub of set) {
        if (this.shouldDeliver(sub, event)) {
          try {
            sub.send(event);
          } catch {
            // Cliente desconectado: el unsubscribe del router limpia.
          }
        }
      }
    }
  }

  private shouldDeliver(sub: RealtimeSubscriber, event: RealtimeEvent): boolean {
    if (sub.role === "admin") return true;

    if (event.type === "CASE_ESCALATED") {
      if (event.departmentId === null) {
        return sub.role === "manager";
      }
      // shared: cualquier agente; restricted se afina vía membership cuando exista listMemberships.
      return sub.departmentIds.has(event.departmentId) || sub.role === "manager";
    }

    // Mensajes y claim: visibilidad shared por defecto — todos los agentes autenticados.
    return true;
  }
}
