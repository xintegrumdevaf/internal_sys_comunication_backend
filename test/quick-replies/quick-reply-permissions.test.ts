import { describe, it, expect, beforeEach } from "vitest";
import { QuickReplyRepositoryFake, DepartmentRepositoryFake } from "../support/fakes";
import { QuickReplyCatalogService } from "../../src/core/modules/quick-replies/application/services/quick-reply-catalog.service";
import { CreateQuickReplyUseCase } from "../../src/core/modules/quick-replies/application/use-cases/create-quick-reply.use-case";
import { UpdateQuickReplyUseCase } from "../../src/core/modules/quick-replies/application/use-cases/update-quick-reply.use-case";
import { DeleteQuickReplyUseCase } from "../../src/core/modules/quick-replies/application/use-cases/delete-quick-reply.use-case";
import { ListQuickRepliesUseCase } from "../../src/core/modules/quick-replies/application/use-cases/list-quick-replies.use-case";
import type { Agent } from "../../src/core/modules/departments/domain/agent.entity";
import type { Logger } from "../../src/shared/logging/logger";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

describe("Quick Replies — Control de acceso y reglas de negocio por rol", () => {
  let quickReplyRepo: QuickReplyRepositoryFake;
  let departmentRepo: DepartmentRepositoryFake;
  let catalogService: QuickReplyCatalogService;
  let createUseCase: CreateQuickReplyUseCase;
  let updateUseCase: UpdateQuickReplyUseCase;
  let deleteUseCase: DeleteQuickReplyUseCase;
  let listUseCase: ListQuickRepliesUseCase;

  let supportDeptId: string;
  let billingDeptId: string;

  let adminActor: Agent;
  let supportManagerActor: Agent;
  let agentActor: Agent;

  beforeEach(async () => {
    quickReplyRepo = new QuickReplyRepositoryFake();
    departmentRepo = new DepartmentRepositoryFake();
    catalogService = new QuickReplyCatalogService(quickReplyRepo, silentLogger);

    const supportDept = departmentRepo.seed({
      slug: "support",
      name: "Soporte Técnico",
      description: "Área técnica",
    });
    supportDeptId = supportDept.id;

    const billingDept = departmentRepo.seed({
      slug: "billing",
      name: "Facturación y Cobranzas",
      description: "Área de pagos",
    });
    billingDeptId = billingDept.id;

    adminActor = {
      id: "admin-1",
      name: "Super Admin",
      email: "admin@isp.com",
      role: "admin",
      primaryDepartmentId: null,
      active: true,
      autoAssignEnabled: false,
      mustChangePassword: false,
      createdAt: new Date(),
      passwordHash: null,
    };

    supportManagerActor = {
      id: "manager-support-1",
      name: "Jefe de Soporte",
      email: "jefe.soporte@isp.com",
      role: "manager",
      primaryDepartmentId: supportDeptId,
      departmentIds: [supportDeptId],
      active: true,
      autoAssignEnabled: false,
      mustChangePassword: false,
      createdAt: new Date(),
      passwordHash: null,
    };

    agentActor = {
      id: "agent-1",
      name: "Operador Soporte",
      email: "operador@isp.com",
      role: "agent",
      primaryDepartmentId: supportDeptId,
      departmentIds: [supportDeptId],
      active: true,
      autoAssignEnabled: true,
      mustChangePassword: false,
      createdAt: new Date(),
      passwordHash: null,
    };

    createUseCase = new CreateQuickReplyUseCase({
      quickReplyRepo,
      departmentRepo,
      catalogService,
    });
    updateUseCase = new UpdateQuickReplyUseCase({
      quickReplyRepo,
      departmentRepo,
      catalogService,
    });
    deleteUseCase = new DeleteQuickReplyUseCase({
      quickReplyRepo,
      catalogService,
    });
    listUseCase = new ListQuickRepliesUseCase(quickReplyRepo);
  });

  describe("Creación de respuestas rápidas", () => {
    it("permite al admin crear una respuesta rápida global (departmentId = null)", async () => {
      const result = await createUseCase.execute(
        {
          shortcut: "/saludo",
          title: "Saludo General",
          body: "Hola {{nombre}}, ¿cómo estás?",
          departmentId: null,
        },
        adminActor,
      );

      expect(result.id).toBeDefined();
      expect(result.shortcut).toBe("saludo");
      expect(result.departmentId).toBeNull();
    });

    it("deniega al manager crear una respuesta rápida global", async () => {
      await expect(
        createUseCase.execute(
          {
            shortcut: "/saludo",
            title: "Saludo General",
            body: "Hola {{nombre}}",
            departmentId: null,
          },
          supportManagerActor,
        ),
      ).rejects.toThrow("Solo los administradores pueden crear respuestas rápidas de alcance general");
    });

    it("permite al manager crear una respuesta rápida para su departamento asignado", async () => {
      const result = await createUseCase.execute(
        {
          shortcut: "reinicio-ont",
          title: "Instrucciones de reinicio de módem",
          body: "Por favor desconecte el módem 10 segundos y vuelva a conectarlo.",
          departmentId: supportDeptId,
        },
        supportManagerActor,
      );

      expect(result.shortcut).toBe("reinicio-ont");
      expect(result.departmentId).toBe(supportDeptId);
    });

    it("deniega al manager crear una respuesta rápida para un departamento ajeno", async () => {
      await expect(
        createUseCase.execute(
          {
            shortcut: "bancos",
            title: "Cuentas bancarias",
            body: "Transfiera a Banco Pichincha.",
            departmentId: billingDeptId, // Pertenece a billing, no a support
          },
          supportManagerActor,
        ),
      ).rejects.toThrow("No tienes permisos para crear respuestas rápidas en un departamento al que no perteneces");
    });

    it("impide registrar atajos duplicados en el mismo ámbito", async () => {
      await createUseCase.execute(
        {
          shortcut: "horarios",
          title: "Horarios generales",
          body: "Atención de 8:00 a 17:00",
          departmentId: null,
        },
        adminActor,
      );

      // Intentar crear de nuevo el mismo atajo global
      await expect(
        createUseCase.execute(
          {
            shortcut: "/horarios",
            title: "Otro horario",
            body: "Atención sábados",
            departmentId: null,
          },
          adminActor,
        ),
      ).rejects.toThrow(/Ya existe una respuesta rápida con el atajo "\/horarios"/);
    });

    it("permite el mismo atajo en departamentos diferentes", async () => {
      const supportReply = await createUseCase.execute(
        {
          shortcut: "requisitos",
          title: "Requisitos de soporte",
          body: "Cédula y serie de equipo",
          departmentId: supportDeptId,
        },
        supportManagerActor,
      );

      const billingReply = await createUseCase.execute(
        {
          shortcut: "requisitos",
          title: "Requisitos de facturación",
          body: "Cédula y comprobante",
          departmentId: billingDeptId,
        },
        adminActor,
      );

      expect(supportReply.shortcut).toBe("requisitos");
      expect(billingReply.shortcut).toBe("requisitos");
      expect(supportReply.departmentId).not.toBe(billingReply.departmentId);
    });
  });

  describe("Edición y eliminación", () => {
    it("deniega al manager modificar una respuesta rápida global o de otro departamento", async () => {
      const globalReply = await createUseCase.execute(
        {
          shortcut: "bienvenida",
          title: "Bienvenida",
          body: "Hola",
          departmentId: null,
        },
        adminActor,
      );

      await expect(
        updateUseCase.execute(
          globalReply.id,
          { body: "Hola modificado" },
          supportManagerActor,
        ),
      ).rejects.toThrow("Solo los administradores pueden modificar respuestas rápidas de alcance general");
    });

    it("permite al manager modificar y eliminar respuestas de su propio departamento", async () => {
      const deptReply = await createUseCase.execute(
        {
          shortcut: "los-rojo",
          title: "Luz roja LOS",
          body: "Verifique que el cable amarillo no esté doblado.",
          departmentId: supportDeptId,
        },
        supportManagerActor,
      );

      const updated = await updateUseCase.execute(
        deptReply.id,
        { title: "Luz roja LOS actualizada" },
        supportManagerActor,
      );
      expect(updated.title).toBe("Luz roja LOS actualizada");

      await deleteUseCase.execute(deptReply.id, supportManagerActor);
      const found = await quickReplyRepo.findById(deptReply.id);
      expect(found).toBeNull();
    });
  });

  describe("Listado con filtros de visibilidad por rol", () => {
    beforeEach(async () => {
      // Global
      await createUseCase.execute(
        { shortcut: "global-1", title: "G1", body: "B1", departmentId: null },
        adminActor,
      );
      // Support
      await createUseCase.execute(
        { shortcut: "support-1", title: "S1", body: "BS1", departmentId: supportDeptId },
        supportManagerActor,
      );
      // Billing
      await createUseCase.execute(
        { shortcut: "billing-1", title: "B1", body: "BB1", departmentId: billingDeptId },
        adminActor,
      );
    });

    it("agente de soporte solo ve respuestas globales y de soporte, nunca de cobranzas", async () => {
      const replies = await listUseCase.execute({}, agentActor);
      const shortcuts = replies.map((r) => r.shortcut);

      expect(shortcuts).toContain("global-1");
      expect(shortcuts).toContain("support-1");
      expect(shortcuts).not.toContain("billing-1");
    });

    it("admin puede ver todas las respuestas rápidas", async () => {
      const replies = await listUseCase.execute({}, adminActor);
      const shortcuts = replies.map((r) => r.shortcut);

      expect(shortcuts).toContain("global-1");
      expect(shortcuts).toContain("support-1");
      expect(shortcuts).toContain("billing-1");
    });
  });
});
