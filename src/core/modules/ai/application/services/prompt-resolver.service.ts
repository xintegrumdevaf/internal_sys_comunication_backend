import type { Logger } from "../../../../../shared/logging/logger";
import type { PromptVersion } from "../../domain/entities/prompt-version.entity";
import type { PromptTemplateRepositoryPort } from "../ports/prompt-template.repository.port";

export interface ResolvedPrompt {
  system: string;
  user: string;
  modelConfig: Record<string, unknown>;
  versionNumber: number;
  source: "database" | "fallback_code";
}

export class PromptResolverService {
  private readonly cache = new Map<string, { version: PromptVersion | null; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 60_000; // 1 minuto de caché en memoria

  constructor(
    private readonly promptRepo: PromptTemplateRepositoryPort,
    private readonly logger?: Logger,
  ) {}

  async resolvePrompt(
    slug: string,
    variables: Record<string, unknown>,
    fallback: () => { system: string; user: string },
  ): Promise<ResolvedPrompt> {
    try {
      const activeVersion = await this.getActiveVersionCached(slug);
      if (!activeVersion) {
        const fb = fallback();
        return {
          system: fb.system,
          user: fb.user,
          modelConfig: { temperature: 0.2 },
          versionNumber: 0,
          source: "fallback_code",
        };
      }

      const system = this.interpolate(activeVersion.systemPrompt, variables);
      const user = this.interpolate(activeVersion.userTemplate, variables);

      return {
        system,
        user,
        modelConfig: activeVersion.modelConfig,
        versionNumber: activeVersion.versionNumber,
        source: "database",
      };
    } catch (err) {
      this.logger?.warn(
        { slug, err },
        "Error al resolver prompt desde BD; ejecutando fallback inmediato a código compilado",
      );
      const fb = fallback();
      return {
        system: fb.system,
        user: fb.user,
        modelConfig: { temperature: 0.2 },
        versionNumber: 0,
        source: "fallback_code",
      };
    }
  }

  private async getActiveVersionCached(slug: string): Promise<PromptVersion | null> {
    const now = Date.now();
    const cached = this.cache.get(slug);
    if (cached && cached.expiresAt > now) {
      return cached.version;
    }

    const version = await this.promptRepo.getActiveVersionBySlug(slug);
    this.cache.set(slug, { version, expiresAt: now + this.CACHE_TTL_MS });
    return version;
  }

  invalidateCache(slug?: string): void {
    if (slug) {
      this.cache.delete(slug);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Reemplaza placeholders del tipo {{variable}} o {variable} por su valor
   */
  private interpolate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g, (match, key) => {
      if (key in vars) {
        const val = vars[key];
        if (val === undefined || val === null) return "";
        if (typeof val === "object") return JSON.stringify(val);
        return String(val);
      }
      return match;
    });
  }
}
