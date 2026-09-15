import express from "express";
import supertest from "supertest";
import { describe, expect, it, beforeEach } from "vitest";
import {
  QuickReplyRepositoryFake,
  DepartmentRepositoryFake,
  ConversationRepositoryFake,
} from "../support/fakes";
import { QuickReplyCatalogService } from "../../src/core/modules/quick-replies/application/services/quick-reply-catalog.service";
import { CreateQuickReplyUseCase } from "../../src/core/modules/quick-replies/application/use-cases/create-quick-reply.use-case";
import { UpdateQuickReplyUseCase } from "../../src/core/modules/quick-replies/application/use-cases/update-quick-reply.use-case";
import { DeleteQuickReplyUseCase } from "../../src/core/modules/quick-replies/application/use-cases/delete-quick-reply.use-case";
import { ListQuickRepliesUseCase } from "../../src/core/modules/quick-replies/application/use-cases/list-quick-replies.use-case";
import { ResolveQuickReplyUseCase } from "../../src/core/modules/quick-replies/application/use-cases/resolve-quick-reply.use-case";
import { createQuickRepliesRouter } from "../../src/core/modules/quick-replies/presentation/quick-replies.router";
import type { Agent } from "../../src/core/modules/departments/domain/agent.entity";
import type { Logger } from "../../src/shared/logging/logger";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

describe("Quick Replies Router (Integration)", () => {
  let quickReplyRepo: QuickReplyRepositoryFake;
  let departmentRepo: DepartmentRepositoryFake;
  let conversationRepo: ConversationRepositoryFake;
  let catalogService: QuickReplyCatalogService;
  let supportDeptId: string;

  let currentActor: Agent;

  function buildApp() {
    const createQuickReply = new CreateQuickReplyUseCase({
      quickReplyRepo,
      departmentRepo,
      catalogService,
    });
    const updateQuickReply = new UpdateQuickReplyUseCase({
      quickReplyRepo,
      departmentRepo,
      catalogService,
    });
    const deleteQuickReply = new DeleteQuickReplyUseCase({
      quickReplyRepo,
      catalogService,
    });
    const listQuickReplies = new ListQuickRepliesUseCase(quickReplyRepo);
    const resolveQuickReply = new ResolveQuickReplyUseCase({
      catalogService,
      conversationRepo,
    });

    const router = createQuickRepliesRouter({
      createQuickReply,
      updateQuickReply,
      deleteQuickReply,
      listQuickReplies,
      resolveQuickReply,
    });

    const app = express();
    app.use(express.json());

    // Inyecta el actor actual en req.agent para simular requireAuth
    app.use((req, _res, next) => {
      (req as unknown as { agent: Agent }).agent = currentActor;
      next();
    });

    app.use(router);

    // Error handler mínimo para mapear DomainError a código HTTP
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status =
        err.type === "AUTHORIZATION_ERROR"
          ? 403
          : err.type === "NOT_FOUND"
          ? 404
          : err.type === "VALIDATION_ERROR"
          ? 400
          : 500;
      res.status(status).json({ error: err.message, type: err.type });
    });

    return app;
  }

  beforeEach(() => {
    quickReplyRepo = new QuickReplyRepositoryFake();
    departmentRepo = new DepartmentRepositoryFake();
    conversationRepo = new ConversationRepositoryFake();
    catalogService = new QuickReplyCatalogService(quickReplyRepo, silentLogger);

    const supportDept = departmentRepo.seed({
      slug: "support",
      name: "Soporte Técnico",
      description: "Área de soporte",
    });
    supportDeptId = supportDept.id;

    currentActor = {
      id: "admin-1",
      name: "Administrador General",
      email: "admin@isp.com",
      role: "admin",
      primaryDepartmentId: null,
      active: true,
      autoAssignEnabled: false,
      mustChangePassword: false,
      createdAt: new Date(),
      passwordHash: null,
    };
  });

  it("POST /api/quick-replies crea una respuesta rápida global con rol admin", async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post("/api/quick-replies")
      .send({
        shortcut: "/bienvenida",
        title: "Mensaje de Bienvenida",
        body: "Hola {{nombre}}, un gusto saludarte.",
        category: "general",
      });

    expect(res.status).toBe(201);
    expect(res.body.quickReply).toBeDefined();
    expect(res.body.quickReply.shortcut).toBe("bienvenida");
    expect(res.body.quickReply.departmentId).toBeNull();
  });

  it("POST /api/quick-replies rechaza si un agent intenta crear una respuesta", async () => {
    currentActor = {
      ...currentActor,
      role: "agent",
    };
    const app = buildApp();

    const res = await supertest(app)
      .post("/api/quick-replies")
      .send({
        shortcut: "/saludo",
        title: "Intento no permitido",
        body: "Texto",
      });

    expect(res.status).toBe(403);
  });

  it("GET /api/quick-replies devuelve la lista de respuestas disponibles", async () => {
    quickReplyRepo.seed({
      id: "qr-1",
      shortcut: "pago",
      title: "Confirmación de Pago",
      body: "Su pago ha sido registrado.",
      departmentId: null,
      category: "billing",
      mediaUrl: null,
      createdByAgentId: "admin-1",
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = buildApp();
    const res = await supertest(app).get("/api/quick-replies");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.quickReplies)).toBe(true);
    expect(res.body.quickReplies.length).toBe(1);
    expect(res.body.quickReplies[0].shortcut).toBe("pago");
  });

  it("GET /api/quick-replies/resolve interpola variables contextuales y de conversación", async () => {
    quickReplyRepo.seed({
      id: "qr-2",
      shortcut: "bienvenida",
      title: "Bienvenida Cliente",
      body: "Estimado {{nombre}}, te atiende {{agente}}.",
      departmentId: null,
      category: "general",
      mediaUrl: null,
      createdByAgentId: "admin-1",
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await catalogService.loadCache();

    const conversation = conversationRepo.createOpen({
      waProfileName: "Juan Pérez",
    });

    const app = buildApp();
    const res = await supertest(app)
      .get(`/api/quick-replies/resolve?shortcut=bienvenida&conversationId=${conversation.id}`);

    expect(res.status).toBe(200);
    expect(res.body.interpolatedBody).toBe("Estimado Juan Pérez, te atiende Administrador General.");
  });

  it("PUT /api/quick-replies/:id actualiza el contenido de una respuesta rápida", async () => {
    const qr = quickReplyRepo.seed({
      id: "qr-edit-1",
      shortcut: "mantenimiento",
      title: "Aviso de Mantenimiento",
      body: "Habrá corte de 2 a 4 am.",
      departmentId: null,
      category: "soporte",
      mediaUrl: null,
      createdByAgentId: "admin-1",
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = buildApp();
    const res = await supertest(app)
      .put(`/api/quick-replies/${qr.id}`)
      .send({
        title: "Aviso de Mantenimiento Programado",
        body: "Habrá corte de 3 a 5 am.",
      });

    expect(res.status).toBe(200);
    expect(res.body.quickReply.title).toBe("Aviso de Mantenimiento Programado");
    expect(res.body.quickReply.body).toBe("Habrá corte de 3 a 5 am.");
  });

  it("DELETE /api/quick-replies/:id elimina una respuesta rápida", async () => {
    const qr = quickReplyRepo.seed({
      id: "qr-del-1",
      shortcut: "borrame",
      title: "Por borrar",
      body: "Texto",
      departmentId: null,
      category: null,
      mediaUrl: null,
      createdByAgentId: "admin-1",
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = buildApp();
    const res = await supertest(app).delete(`/api/quick-replies/${qr.id}`);

    expect(res.status).toBe(204);
    const found = await quickReplyRepo.findById(qr.id);
    expect(found).toBeNull();
  });
});
