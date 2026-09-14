import type { QuickReplyRepositoryPort } from "../ports/quick-reply.repository.port";
import type { QuickReply } from "../../domain/quick-reply.entity";
import type { Logger } from "../../../../../shared/logging/logger";

export class QuickReplyCatalogService {
  private cache: QuickReply[] = [];
  private isLoaded = false;

  constructor(
    private readonly quickReplyRepo: QuickReplyRepositoryPort,
    private readonly logger: Logger,
  ) {}

  async loadCache(): Promise<void> {
    try {
      const replies = await this.quickReplyRepo.list({ activeOnly: true });
      this.cache = replies;
      this.isLoaded = true;
      this.logger.debug(
        { count: this.cache.length },
        "Caché de respuestas rápidas cargado exitosamente",
      );
    } catch (err) {
      this.logger.error({ err }, "Error al cargar caché de respuestas rápidas");
    }
  }

  async invalidateCache(): Promise<void> {
    await this.loadCache();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.isLoaded) {
      await this.loadCache();
    }
  }

  /**
   * Normaliza un atajo para búsqueda consistente:
   * elimina barra inicial '/', espacios y pasa a minúsculas.
   */
  normalizeShortcut(shortcut: string): string {
    return shortcut.trim().replace(/^\/+/, "").toLowerCase();
  }

  /**
   * Resuelve un atajo con prioridad departamental:
   * 1. Si se provee departmentId, busca coincidencia exacta en ese departamento.
   * 2. Si no existe en el departamento, busca coincidencia en el ámbito Global (department_id = null).
   */
  async resolve(shortcut: string, departmentId?: string | null): Promise<QuickReply | null> {
    await this.ensureLoaded();
    const normalized = this.normalizeShortcut(shortcut);

    if (departmentId) {
      const deptMatch = this.cache.find(
        (r) => r.departmentId === departmentId && this.normalizeShortcut(r.shortcut) === normalized,
      );
      if (deptMatch) return deptMatch;
    }

    const globalMatch = this.cache.find(
      (r) => r.departmentId === null && this.normalizeShortcut(r.shortcut) === normalized,
    );
    return globalMatch ?? null;
  }

  /**
   * Retorna las respuestas rápidas disponibles para un agente humano:
   * todas las globales + las de los departamentos a los que pertenece.
   */
  async getAvailableForAgent(agentDepartmentIds: string[] = []): Promise<QuickReply[]> {
    await this.ensureLoaded();
    const deptSet = new Set(agentDepartmentIds);

    return this.cache.filter((r) => r.departmentId === null || deptSet.has(r.departmentId));
  }

  /**
   * Genera un bloque sintético y ultra-compacto de respuestas rápidas disponibles
   * para inyectar en el contexto de la IA sin sobrecargar tokens.
   */
  async getFormattedForAiContext(departmentId?: string | null): Promise<string> {
    await this.ensureLoaded();
    const relevant = this.cache.filter(
      (r) => r.departmentId === null || (departmentId && r.departmentId === departmentId),
    );

    if (relevant.length === 0) return "";

    const lines = relevant.map((r) => `- /${this.normalizeShortcut(r.shortcut)}: ${r.title}`);
    return `## Atajos y Respuestas Rápidas Canónicas Disponibles:\n${lines.join("\n")}`;
  }

  /**
   * Interpola variables dinámicas en el cuerpo de la plantilla.
   * Soporta {{variable}} y {{ variable }}.
   */
  interpolate(body: string, context: Record<string, string | number | undefined | null>): string {
    return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      const value = context[key];
      if (value !== undefined && value !== null) {
        return String(value);
      }
      return match;
    });
  }
}
