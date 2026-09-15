import { describe, it, expect, beforeEach } from "vitest";
import { QuickReplyRepositoryFake } from "../support/fakes";
import { QuickReplyCatalogService } from "../../src/core/modules/quick-replies/application/services/quick-reply-catalog.service";
import type { QuickReply } from "../../src/core/modules/quick-replies/domain/quick-reply.entity";
import type { Logger } from "../../src/shared/logging/logger";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

describe("QuickReplyCatalogService — Catálogo en memoria y resolución de atajos", () => {
  let quickReplyRepo: QuickReplyRepositoryFake;
  let catalogService: QuickReplyCatalogService;
  const supportDeptId = "dept-support-123";
  const billingDeptId = "dept-billing-456";

  beforeEach(async () => {
    quickReplyRepo = new QuickReplyRepositoryFake();

    const now = new Date();

    // 1. Respuesta rápida global: /saludo
    quickReplyRepo.seed({
      id: "qr-global-saludo",
      shortcut: "saludo",
      title: "Saludo General",
      body: "Hola {{nombre}}, bienvenido a nuestro centro de atención.",
      departmentId: null,
      category: "general",
      mediaUrl: null,
      createdByAgentId: "admin-1",
      active: true,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Respuesta rápida específica de Soporte: /saludo (override del global)
    quickReplyRepo.seed({
      id: "qr-support-saludo",
      shortcut: "saludo",
      title: "Saludo Soporte Técnico",
      body: "Hola {{nombre}}, estás en el canal de Soporte Técnico. ¿Qué inconveniente presenta tu servicio?",
      departmentId: supportDeptId,
      category: "soporte",
      mediaUrl: null,
      createdByAgentId: "manager-soporte",
      active: true,
      createdAt: now,
      updatedAt: now,
    });

    // 3. Respuesta rápida específica de Cobranzas: /bancos
    quickReplyRepo.seed({
      id: "qr-billing-bancos",
      shortcut: "bancos",
      title: "Cuentas Bancarias",
      body: "Estimado {{nombre}}, puede transferir a Banco Pichincha cta cte 123456789.",
      departmentId: billingDeptId,
      category: "pagos",
      mediaUrl: "https://ejemplo.com/cuentas.pdf",
      createdByAgentId: "manager-billing",
      active: true,
      createdAt: now,
      updatedAt: now,
    });

    // 4. Respuesta inactiva
    quickReplyRepo.seed({
      id: "qr-inactive",
      shortcut: "promo-navidad",
      title: "Promo Navidad",
      body: "Promo inactiva",
      departmentId: null,
      category: "ventas",
      mediaUrl: null,
      createdByAgentId: "admin-1",
      active: false,
      createdAt: now,
      updatedAt: now,
    });

    catalogService = new QuickReplyCatalogService(quickReplyRepo, silentLogger);
    await catalogService.loadCache();
  });

  it("prioriza la respuesta del departamento cuando existe un override departamental", async () => {
    const resolved = await catalogService.resolve("saludo", supportDeptId);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe("qr-support-saludo");
    expect(resolved?.title).toBe("Saludo Soporte Técnico");
  });

  it("hace fallback a la respuesta global cuando el departamento no tiene override", async () => {
    // Cobranzas no tiene /saludo departamental, debe resolver el global
    const resolved = await catalogService.resolve("saludo", billingDeptId);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe("qr-global-saludo");
    expect(resolved?.departmentId).toBeNull();
  });

  it("resuelve atajos globales cuando no se envía departmentId", async () => {
    const resolved = await catalogService.resolve("saludo");
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe("qr-global-saludo");
  });

  it("normaliza atajos con prefijo '/', mayúsculas y espacios", async () => {
    const matchWithSlash = await catalogService.resolve("/saludo", supportDeptId);
    const matchUpper = await catalogService.resolve("  /SALUDO  ", supportDeptId);
    expect(matchWithSlash?.id).toBe("qr-support-saludo");
    expect(matchUpper?.id).toBe("qr-support-saludo");
  });

  it("retorna null para atajos inexistentes o inactivos", async () => {
    const nonexistent = await catalogService.resolve("no-existe");
    expect(nonexistent).toBeNull();

    const inactive = await catalogService.resolve("promo-navidad");
    expect(inactive).toBeNull();
  });

  it("interpola variables en la plantilla correctamente", () => {
    const template = "Hola {{nombre}}, tu cédula es {{cedula}} y te atiende {{agente}}.";
    const context = {
      nombre: "Carlos Pérez",
      cedula: "0928172635",
      agente: "María Asesora",
    };

    const result = catalogService.interpolate(template, context);
    expect(result).toBe("Hola Carlos Pérez, tu cédula es 0928172635 y te atiende María Asesora.");
  });

  it("conserva variables no encontradas sin romper la cadena", () => {
    const template = "Hola {{nombre}}, tu contrato es {{contrato}}.";
    const context = { nombre: "Carlos" };
    const result = catalogService.interpolate(template, context);
    expect(result).toBe("Hola Carlos, tu contrato es {{contrato}}.");
  });

  it("filtra respuestas disponibles para un agente según sus departamentos", async () => {
    // Agente solo en departamento de Soporte
    const replies = await catalogService.getAvailableForAgent([supportDeptId]);
    const ids = replies.map((r) => r.id);

    // Debe ver el global y el de soporte, pero NO el de billing
    expect(ids).toContain("qr-global-saludo");
    expect(ids).toContain("qr-support-saludo");
    expect(ids).not.toContain("qr-billing-bancos");
  });

  it("genera resumen ultra-compacto para inyección en prompt de IA sin sobrecargar tokens", async () => {
    const aiContext = await catalogService.getFormattedForAiContext(billingDeptId);

    // Debe incluir los generales y los del departamento consultado
    expect(aiContext).toContain("- /saludo: Saludo General");
    expect(aiContext).toContain("- /bancos: Cuentas Bancarias");
    expect(aiContext).not.toContain("Saludo Soporte Técnico"); // no pertenece a billing
  });
});
