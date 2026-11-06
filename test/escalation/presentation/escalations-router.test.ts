import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createEscalationsRouter } from "../../../src/core/modules/escalation/presentation/escalations.router";
import { ListEscalationsUseCase } from "../../../src/core/modules/escalation/application/use-cases/list-escalations.use-case";
import { EscalationRepositoryFake } from "../../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { AgentRepositoryFake } from "../../support/agent-audit.fakes";
import { DepartmentRepositoryFake } from "../../support/fakes";
import type { Agent } from "../../../src/core/modules/departments/domain/agent.entity";
import { createErrorHandler } from "../../../src/shared/http/middlewares/error-handler.middleware";
import { silentLogger } from "../../support/silent-logger";
import type { DrainDepartmentQueueService } from "../../../src/core/modules/escalation/application/services/drain-department-queue.service";

describe("Escalations Router (GET & POST /api/escalations)", () => {
  const adminAgent: Agent = {
    id: "admin-1",
    name: "Admin User",
    email: "admin@isp.local",
    role: "admin",
    primaryDepartmentId: "dept-support",
    active: true,
    autoAssignEnabled: false,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  function createTestApp(currentAgent: Agent | null, drainQueue?: DrainDepartmentQueueService) {
    const app = express();
    app.use(express.json());

    app.use((req, _res, next) => {
      if (currentAgent) {
        req.agent = currentAgent;
      }
      next();
    });

    const agentRepo = new AgentRepositoryFake();
    agentRepo.seed(adminAgent);
    const departmentRepo = new DepartmentRepositoryFake();
    departmentRepo.seed({ id: "dept-support", name: "Soporte", slug: "support" });
    const escalationRepo = new EscalationRepositoryFake();

    const listEscalations = new ListEscalationsUseCase({
      escalationRepo,
      agentRepo,
      departmentRepo,
    });

    const router = createEscalationsRouter({
      listEscalations,
      drainQueue,
      departmentRepo,
    });

    app.use(router);
    app.use(createErrorHandler(silentLogger));
    return app;
  }

  it("GET /api/escalations retorna lista de escalaciones", async () => {
    const app = createTestApp(adminAgent);
    const res = await request(app).get("/api/escalations");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("POST /api/escalations/drain drena la cola del departamento especificado", async () => {
    let calledWith: string | null = null;
    const fakeDrainService = {
      drainQueueForDepartment: async (deptId: string) => {
        calledWith = deptId;
        return 3;
      },
      drainQueueForAgent: async () => 0,
    } as unknown as DrainDepartmentQueueService;

    const app = createTestApp(adminAgent, fakeDrainService);
    const res = await request(app)
      .post("/api/escalations/drain")
      .send({ departmentId: "dept-support" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ drainedCount: 3 });
    expect(calledWith).toBe("dept-support");
  });

  it("POST /api/escalations/drain drena todos los departamentos activos si no se especifica departmentId", async () => {
    const drainedDepts: string[] = [];
    const fakeDrainService = {
      drainQueueForDepartment: async (deptId: string) => {
        drainedDepts.push(deptId);
        return 2;
      },
      drainQueueForAgent: async () => 0,
    } as unknown as DrainDepartmentQueueService;

    const app = createTestApp(adminAgent, fakeDrainService);
    const res = await request(app).post("/api/escalations/drain").send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ drainedCount: 2 });
    expect(drainedDepts).toContain("dept-support");
  });
});
