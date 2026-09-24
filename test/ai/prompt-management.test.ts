import { describe, expect, it } from "vitest";
import type { PromptTemplate } from "../../src/core/modules/ai/domain/entities/prompt-template.entity";
import type { PromptVersion } from "../../src/core/modules/ai/domain/entities/prompt-version.entity";
import type {
  CreatePromptVersionInput,
  PromptTemplateRepositoryPort,
  PromptTemplateWithActiveVersion,
} from "../../src/core/modules/ai/application/ports/prompt-template.repository.port";
import { PromptResolverService } from "../../src/core/modules/ai/application/services/prompt-resolver.service";
import { SavePromptVersionUseCase } from "../../src/core/modules/ai/application/use-cases/save-prompt-version.use-case";
import { PublishPromptVersionUseCase } from "../../src/core/modules/ai/application/use-cases/publish-prompt-version.use-case";
import { RollbackPromptVersionUseCase } from "../../src/core/modules/ai/application/use-cases/rollback-prompt-version.use-case";
import { SimulatePromptUseCase } from "../../src/core/modules/ai/application/use-cases/simulate-prompt.use-case";
import { silentLogger } from "../support/silent-logger";

class FakePromptTemplateRepository implements PromptTemplateRepositoryPort {
  templates: PromptTemplateWithActiveVersion[] = [];
  versions: PromptVersion[] = [];

  async listTemplates(): Promise<PromptTemplateWithActiveVersion[]> {
    return [...this.templates];
  }

  async findBySlug(slug: string): Promise<PromptTemplate | null> {
    return this.templates.find((t) => t.slug === slug) ?? null;
  }

  async findById(id: string): Promise<PromptTemplate | null> {
    return this.templates.find((t) => t.id === id) ?? null;
  }

  async createTemplate(
    template: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">,
  ): Promise<PromptTemplate> {
    const created: PromptTemplateWithActiveVersion = {
      id: `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ...template,
      activeVersionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.templates.push(created);
    return created;
  }

  async listVersions(templateId: string): Promise<PromptVersion[]> {
    return this.versions
      .filter((v) => v.templateId === templateId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  async findVersionById(versionId: string): Promise<PromptVersion | null> {
    return this.versions.find((v) => v.id === versionId) ?? null;
  }

  async getActiveVersion(templateId: string): Promise<PromptVersion | null> {
    const tmpl = this.templates.find((t) => t.id === templateId);
    if (!tmpl || !tmpl.activeVersionId) return null;
    return this.versions.find((v) => v.id === tmpl.activeVersionId) ?? null;
  }

  async getActiveVersionBySlug(slug: string): Promise<PromptVersion | null> {
    const tmpl = this.templates.find((t) => t.slug === slug);
    if (!tmpl || !tmpl.activeVersionId) return null;
    return this.versions.find((v) => v.id === tmpl.activeVersionId) ?? null;
  }

  async createVersion(input: CreatePromptVersionInput): Promise<PromptVersion> {
    const tmplVersions = this.versions.filter((v) => v.templateId === input.templateId);
    const versionNumber = tmplVersions.length + 1;
    const versionId = `ver-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const created: PromptVersion = {
      id: versionId,
      templateId: input.templateId,
      versionNumber,
      systemPrompt: input.systemPrompt,
      userTemplate: input.userTemplate,
      modelConfig: input.modelConfig ?? {},
      changeNotes: input.changeNotes ?? null,
      createdBy: input.createdBy ?? null,
      status: input.status ?? "DRAFT",
      createdAt: new Date(),
    };
    this.versions.push(created);

    if (input.status === "PUBLISHED") {
      await this.setActiveVersion(input.templateId, versionId);
    }

    return created;
  }

  async setActiveVersion(templateId: string, versionId: string): Promise<void> {
    const tmpl = this.templates.find((t) => t.id === templateId);
    if (!tmpl) throw new Error("Template not found");
    tmpl.activeVersionId = versionId;

    const version = this.versions.find((v) => v.id === versionId);
    if (version) {
      version.status = "PUBLISHED";
    }
  }
}

describe("Dynamic Prompts & Versioning", () => {
  it("PromptResolverService falls back to compiled prompt when DB template does not exist", async () => {
    const repo = new FakePromptTemplateRepository();
    const resolver = new PromptResolverService(repo, silentLogger);

    const resolved = await resolver.resolvePrompt(
      "interpret_message",
      { message: "hola", context: "test" },
      () => ({
        system: "Compiled system prompt",
        user: "Compiled user prompt with {{message}}",
      }),
    );

    expect(resolved.system).toBe("Compiled system prompt");
    expect(resolved.user).toBe("Compiled user prompt with {{message}}");
    expect(resolved.source).toBe("fallback_code");
  });

  it("PromptResolverService uses active version from DB and caches it", async () => {
    const repo = new FakePromptTemplateRepository();
    const template = await repo.createTemplate({
      slug: "interpret_message",
      name: "Interpretación NLU",
      description: "Interpreta el mensaje del cliente",
      allowedVariables: ["systemRole", "message"],
    });

    await repo.createVersion({
      templateId: template.id,
      systemPrompt: "Dynamic system prompt: {{systemRole}}",
      userTemplate: "Dynamic user message: {{message}}",
      modelConfig: { temperature: 0.2 },
      status: "PUBLISHED",
      createdBy: "admin",
      changeNotes: "Initial version",
    });

    const resolver = new PromptResolverService(repo, silentLogger);

    const resolved = await resolver.resolvePrompt(
      "interpret_message",
      { systemRole: "Support Bot", message: "Quiero pagar mi factura" },
      () => ({ system: "fallback", user: "fallback" }),
    );

    expect(resolved.source).toBe("database");
    expect(resolved.system).toBe("Dynamic system prompt: Support Bot");
    expect(resolved.user).toBe("Dynamic user message: Quiero pagar mi factura");
    expect(resolved.versionNumber).toBe(1);

    // Second call should hit memory cache without re-querying
    const cached = await resolver.resolvePrompt(
      "interpret_message",
      {
        systemRole: "Support Bot",
        message: "Segundo mensaje",
      },
      () => ({ system: "fallback", user: "fallback" }),
    );
    expect(cached.source).toBe("database");
    expect(cached.user).toBe("Dynamic user message: Segundo mensaje");
  });

  it("SavePromptVersionUseCase creates a new version and increments version number", async () => {
    const repo = new FakePromptTemplateRepository();
    const resolver = new PromptResolverService(repo, silentLogger);

    await repo.createTemplate({
      slug: "compose_reply",
      name: "Composición de Respuesta",
      description: null,
      allowedVariables: ["data"],
    });

    const saveUseCase = new SavePromptVersionUseCase(repo, resolver);

    const v1 = await saveUseCase.execute({
      slug: "compose_reply",
      systemPrompt: "System v1 instructions",
      userTemplate: "User v1 template: {{data}}",
      changeNotes: "Versión 1",
    });

    expect(v1.versionNumber).toBe(1);
    expect(v1.status).toBe("DRAFT");

    const v2 = await saveUseCase.execute({
      slug: "compose_reply",
      systemPrompt: "System v2 instructions",
      userTemplate: "User v2 template: {{data}}",
      changeNotes: "Versión 2 con mejoras",
      publishImmediately: true,
    });

    expect(v2.versionNumber).toBe(2);
    expect(v2.status).toBe("PUBLISHED");
  });

  it("PublishPromptVersionUseCase and RollbackPromptVersionUseCase manage active versions safely", async () => {
    const repo = new FakePromptTemplateRepository();
    const resolver = new PromptResolverService(repo, silentLogger);

    const template = await repo.createTemplate({
      slug: "compose_reply",
      name: "Composición de Respuesta",
      description: null,
      allowedVariables: [],
    });

    const saveUseCase = new SavePromptVersionUseCase(repo, resolver);
    const publishUseCase = new PublishPromptVersionUseCase(repo, resolver);
    const rollbackUseCase = new RollbackPromptVersionUseCase(repo, resolver);

    const v1 = await saveUseCase.execute({
      slug: "compose_reply",
      systemPrompt: "System v1",
      userTemplate: "User v1",
      publishImmediately: true,
    });

    const v2 = await saveUseCase.execute({
      slug: "compose_reply",
      systemPrompt: "System v2 - problemático",
      userTemplate: "User v2",
      publishImmediately: true,
    });

    let active = await repo.getActiveVersion(template.id);
    expect(active?.id).toBe(v2.id);

    // Rollback to previous version (v1)
    const rolledBack = await rollbackUseCase.execute({ slug: "compose_reply" });
    expect(rolledBack.id).toBe(v1.id);
    expect(rolledBack.versionNumber).toBe(1);

    active = await repo.getActiveVersion(template.id);
    expect(active?.id).toBe(v1.id);

    // Re-publish v2 explicitly
    await publishUseCase.execute({ slug: "compose_reply", versionId: v2.id });
    active = await repo.getActiveVersion(template.id);
    expect(active?.id).toBe(v2.id);
  });

  it("SimulatePromptUseCase executes mock simulation with interpolation", async () => {
    const repo = new FakePromptTemplateRepository();
    await repo.createTemplate({
      slug: "compose_reply",
      name: "Composición",
      description: null,
      allowedVariables: ["company", "question"],
    });

    const mockAiProvider = {
      async interpretMessage() {
        return { type: "ANSWER" } as any;
      },
      async composeCustomerReply() {
        return "Respuesta simulada";
      },
      async transcribeAudio() {
        return "Audio";
      },
      async extractReceiptData() {
        return {} as any;
      },
      async chat(system: string, user: string) {
        return JSON.stringify({
          receivedSystem: system,
          receivedUser: user,
          result: "success",
        });
      },
    };

    const simulateUseCase = new SimulatePromptUseCase(repo, mockAiProvider as any);

    const result = await simulateUseCase.execute({
      slug: "compose_reply",
      systemPrompt: "Eres un asistente de {{company}}",
      userTemplate: "Pregunta: {{question}}",
      testVariables: {
        company: "MegaISP",
        question: "¿Cómo pago?",
      },
    });

    expect(result.interpolatedSystem).toBe("Eres un asistente de MegaISP");
    expect(result.interpolatedUser).toBe("Pregunta: ¿Cómo pago?");
    expect(result.isValidJson).toBe(true);
    expect((result.parsedResponse as any).result).toBe("success");
    expect((result.parsedResponse as any).receivedSystem).toBe("Eres un asistente de MegaISP");
  });
});
