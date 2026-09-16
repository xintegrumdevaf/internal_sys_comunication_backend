import { describe, it, expect, beforeEach } from "vitest";
import { DepartmentRepositoryFake } from "../support/fakes";
import { DepartmentRoutingService } from "../../src/core/modules/departments/application/services/department-routing.service";
import { DepartmentResolverService } from "../../src/core/modules/cases/application/services/department-resolver.service";
import { CaseArbitrationService } from "../../src/core/modules/cases/application/services/case-arbitration.service";
import { CreateDepartmentUseCase } from "../../src/core/modules/departments/application/use-cases/create-department.use-case";
import { UpdateDepartmentUseCase } from "../../src/core/modules/departments/application/use-cases/update-department.use-case";
import {
  AddDepartmentCaseUseCase,
  DeleteDepartmentCaseUseCase,
  ListDepartmentCasesUseCase,
} from "../../src/core/modules/departments/application/use-cases/manage-department-cases.use-case";
import { buildInterpretMessagePrompt } from "../../src/core/modules/ai/application/prompts/interpret-message.prompt";
import type { Logger } from "../../src/shared/logging/logger";
import type { CaseRepositoryPort } from "../../src/core/modules/cases/application/ports/case.repository.port";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

describe("Enrutamiento dinámico de departamentos y casos (Configuración desde Frontend)", () => {
  let departmentRepo: DepartmentRepositoryFake;
  let routingService: DepartmentRoutingService;
  let supportDeptId: string;
  let salesDeptId: string;

  beforeEach(async () => {
    departmentRepo = new DepartmentRepositoryFake();

    const support = departmentRepo.seed({
      slug: "support",
      name: "Soporte Técnico",
      description: "Atención técnica e incidencias de internet y fibra óptica",
    });
    supportDeptId = support.id;

    const sales = departmentRepo.seed({
      slug: "sales",
      name: "Ventas y Comercial",
      description: "Contratación de nuevos servicios y planes",
    });
    salesDeptId = sales.id;

    // Sembrar casos iniciales
    await departmentRepo.createRouting({
      departmentId: supportDeptId,
      intentKey: "support.internet",
      label: "Sin Servicio de Internet",
      description: "cuando el cliente dice que no tiene internet, los focos están rojos o se cayó el servicio",
      handlingMode: "ai_assisted",
      workflowType: "SUPPORT_INTERNET",
      active: true,
    });

    await departmentRepo.createRouting({
      departmentId: salesDeptId,
      intentKey: "sales.packages",
      label: "Consulta de Planes",
      description: "cuando el cliente pregunta precios, megas, promociones o cobertura",
      handlingMode: "ai_assisted",
      workflowType: "GENERAL_INQUIRY",
      active: true,
    });

    routingService = new DepartmentRoutingService(departmentRepo, silentLogger);
    await routingService.loadCache();
  });

  describe("DepartmentRoutingService & Cache", () => {
    it("carga el catálogo dinámico y genera la lista de intents para el prompt", async () => {
      const promptIntents = await routingService.getPromptIntents();
      expect(promptIntents).toHaveLength(2);

      const supportItem = promptIntents.find((p) => p.intent === "support.internet");
      expect(supportItem).toBeDefined();
      expect(supportItem?.label).toBe("Sin Servicio de Internet");
      expect(supportItem?.description).toContain("focos están rojos");
      expect(supportItem?.departmentId).toBe(supportDeptId);
    });

    it("resuelve un caso por intentKey exacto o prefijo", async () => {
      const exact = await routingService.resolveByIntent("support.internet");
      expect(exact).toBeDefined();
      expect(exact?.departmentId).toBe(supportDeptId);

      const byPrefix = await routingService.resolveByIntent("sales.desconocido");
      expect(byPrefix).toBeDefined();
      expect(byPrefix?.departmentId).toBe(salesDeptId);
    });

    it("invalida la memoria inmediatamente cuando se agrega un nuevo caso", async () => {
      await departmentRepo.createRouting({
        departmentId: supportDeptId,
        intentKey: "support.slow_internet",
        label: "Internet Lento",
        description: "cuando el cliente reporta que el internet carga lento o tiene lag",
        handlingMode: "ai_assisted",
        workflowType: "SUPPORT_INTERNET",
        active: true,
      });

      // Antes de invalidar la cache en memoria sigue teniendo 2
      expect((await routingService.getPromptIntents()).length).toBe(2);

      // Al invalidar
      await routingService.invalidateCache();
      const updated = await routingService.getPromptIntents();
      expect(updated).toHaveLength(3);
      expect(updated.some((p) => p.intent === "support.slow_internet")).toBe(true);
    });
  });

  describe("DepartmentResolverService", () => {
    it("resuelve el ID del departamento a partir del intent dinámico", async () => {
      const resolver = new DepartmentResolverService(departmentRepo, routingService);

      const resolved = await resolver.resolveDepartmentId("GENERAL_INQUIRY", "sales.packages");
      expect(resolved).toBe(salesDeptId);
    });

    it("resuelve mediante fallback a slugs conocidos si no hay match específico", async () => {
      const resolver = new DepartmentResolverService(departmentRepo, routingService);

      const resolved = await resolver.resolveDepartmentId("SUPPORT_INTERNET");
      expect(resolved).toBe(supportDeptId);
    });

    it("resuelve el departamento de cartera cuando no existe billing pero existe cartera", async () => {
      const carteraDept = departmentRepo.seed({
        slug: "cartera",
        name: "Cartera",
        description: "Recibir los casos de pagos y procesarlos",
      });

      const resolver = new DepartmentResolverService(departmentRepo, routingService);
      const resolved = await resolver.resolveDepartmentId("BILLING_BALANCE");
      expect(resolved).toBe(carteraDept.id);
    });

    it("infiere automáticamente BILLING_BALANCE al agregar un caso en el área Cartera sin workflowType explícito", async () => {
      const carteraDept = departmentRepo.seed({
        slug: "cartera",
        name: "Cartera",
        description: "Recibir los casos de pagos y procesarlos",
      });

      const addCase = new AddDepartmentCaseUseCase(departmentRepo, routingService);
      const createdCase = await addCase.execute({
        departmentId: carteraDept.id,
        label: "Recepcion de pagos",
        description: "Las personas envian una imagen con los pagos para la verificacion",
      });

      expect(createdCase.workflowType).toBe("BILLING_BALANCE");
    });
  });

  describe("CaseArbitrationService con intents dinámicos", () => {
    it("activa un flujo para un intent nuevo que no está en el catálogo estático", async () => {
      // Agregar un departamento nuevo de Cobranzas/Retención con un intent dinámico
      const retencion = departmentRepo.seed({
        slug: "retention",
        name: "Retención y Fidelización",
        description: "Bajas y reclamos de servicio",
      });

      await departmentRepo.createRouting({
        departmentId: retencion.id,
        intentKey: "retention.cancel_service",
        label: "Cancelación de Servicio",
        description: "cuando el cliente desea cancelar el contrato o darse de baja",
        handlingMode: "human_direct",
        workflowType: "GENERAL_INQUIRY",
        active: true,
      });
      await routingService.invalidateCache();

      const caseRepoFake: CaseRepositoryPort = {
        create: async () => ({} as any),
        findById: async () => null,
        findActiveByConversation: async () => null,
        findPausedByConversationAndType: async () => null,
        listByConversation: async () => [],
        listAutomatableExpiring: async () => [],
        applyTransition: async () => ({} as any),
        setAssignedAgent: async () => {},
        getAutomationState: async () => null,
        setAutomationEnabled: async () => ({} as any),
        appendEvent: async () => {},
        listEvents: async () => [],
        countActiveCasesByAgent: async () => ({}),
      };

      const arbitration = new CaseArbitrationService(caseRepoFake, silentLogger, routingService);

      const decision = await arbitration.decide({
        conversationId: "conv-123",
        interpretation: {
          type: "NEW_INTENT",
          intent: "retention.cancel_service",
          confidence: 0.9,
          entities: {},
        },
      });

      expect(decision.action).toBe("ACTIVATE");
      if (decision.action === "ACTIVATE") {
        expect(decision.workflowType).toBe("GENERAL_INQUIRY");
      }
    });
  });

  describe("Inyección dinámica en el prompt de IA (interpret-message.prompt)", () => {
    it("incluye los casos configurados en la lista de intents y la tabla de clasificación", async () => {
      const promptIntents = await routingService.getPromptIntents();
      const prompt = buildInterpretMessagePrompt(
        {
          conversationId: "conv-1",
          correlationId: "corr-1",
          messageId: "msg-1",
          text: "Hola, me gustaría saber qué planes de fibra tienen",
          conversationSnapshot: {
            activeCase: undefined,
            recentMessages: [],
          },
        },
        promptIntents,
      );

      // Debe incluir los intents dinámicos en la especificación
      expect(prompt.system).toContain("support.internet");
      expect(prompt.system).toContain("sales.packages");
      expect(prompt.system).toContain("Sin Servicio de Internet");
      expect(prompt.system).toContain("Consulta de Planes");
      expect(prompt.system).toContain("focos están rojos");
    });
  });

  describe("Casos de uso de administración (Create/Update Department con casos)", () => {
    const auditRepoFake: any = { record: async () => {} };

    it("permite crear un nuevo departamento con sus casos asociados", async () => {
      const createUseCase = new CreateDepartmentUseCase({
        departmentRepo,
        auditRepo: auditRepoFake,
        routingService,
        logger: silentLogger,
      });

      const created = await createUseCase.execute({
        name: "Facturación y Pagos",
        slug: "billing",
        description: "Gestión de facturas y cobros",
        actorId: "admin-1",
        cases: [
          {
            label: "Consulta de Saldo",
            description: "cliente pregunta cuánto debe o fecha de corte",
            intentKey: "billing.balance",
            handlingMode: "ai_assisted",
            workflowType: "BILLING_BALANCE",
          },
          {
            label: "Reporte de Pago",
            description: "cliente envía comprobante de transferencia",
            intentKey: "billing.record_payment",
            handlingMode: "human_direct",
            workflowType: "BILLING_BALANCE",
          },
        ],
      });

      expect(created.id).toBeDefined();
      expect(created.name).toBe("Facturación y Pagos");
      expect(created.cases).toHaveLength(2);

      // Verificar que routingService se actualizó en memoria automáticamente
      const intents = await routingService.getPromptIntents();
      expect(intents.some((i) => i.intent === "billing.balance")).toBe(true);
      expect(intents.some((i) => i.intent === "billing.record_payment")).toBe(true);
    });

    it("permite agregar y eliminar casos granulares por departamento", async () => {
      const addCase = new AddDepartmentCaseUseCase(departmentRepo, routingService);
      const deleteCase = new DeleteDepartmentCaseUseCase(departmentRepo, routingService);
      const listCases = new ListDepartmentCasesUseCase(departmentRepo);

      const newCase = await addCase.execute({
        departmentId: supportDeptId,
        label: "Configuración de Router Wi-Fi",
        description: "cliente pide cambiar clave o nombre de su red wifi",
        handlingMode: "ai_assisted",
        workflowType: "SUPPORT_INTERNET",
      });

      expect(newCase.id).toBeDefined();
      expect(newCase.intentKey).toBe("support.configuracion_de_router_wi_fi");

      let cases = await listCases.execute(supportDeptId);
      expect(cases.some((c) => c.id === newCase.id)).toBe(true);

      // Eliminar el caso
      await deleteCase.execute(newCase.id);

      cases = await listCases.execute(supportDeptId);
      expect(cases.some((c) => c.id === newCase.id)).toBe(false);
    });
  });
});
