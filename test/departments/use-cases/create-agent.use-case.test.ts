import { describe, expect, it } from "vitest";
import { CreateAgentUseCase } from "../../../src/core/modules/departments/application/use-cases/create-agent.use-case";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { DepartmentRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

function build() {
  const agentRepo = new AgentRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const useCase = new CreateAgentUseCase({ agentRepo, departmentRepo, auditRepo, logger: silentLogger });
  return { agentRepo, departmentRepo, auditRepo, useCase };
}

describe("CreateAgentUseCase (docs/spec/06_BACKEND_GAPS.md §1 POST /api/agents)", () => {
  it("crea un agente con role 'agent' por defecto y registra audit_event", async () => {
    const { departmentRepo, auditRepo, useCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });

    const { agent, temporaryPassword } = await useCase.execute({
      name: "  Ana Torres  ",
      email: "Ana.Torres@ISP.local",
      primaryDepartmentId: support.id,
      actorId: "admin-1",
    });

    expect(agent).toMatchObject({
      name: "Ana Torres",
      email: "ana.torres@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      active: true,
    });
    expect(agent.passwordHash).toBeTruthy();
    expect(temporaryPassword).toHaveLength(12);
    expect(auditRepo.events).toContainEqual(
      expect.objectContaining({ action: "AGENT_CREATED", resourceId: agent.id, actorId: "admin-1" }),
    );
  });

  it("normaliza el email a minusculas para el chequeo de unicidad (case-insensitive)", async () => {
    const { agentRepo, useCase } = build();
    agentRepo.seed({ name: "Existente", email: "duplicado@isp.local" });

    await expect(
      useCase.execute({ name: "Otro Agente", email: "Duplicado@ISP.local", actorId: "admin-1" }),
    ).rejects.toMatchObject({ type: "BUSINESS_ERROR" });
  });

  it("rechaza un primaryDepartmentId que no existe", async () => {
    const { useCase } = build();

    await expect(
      useCase.execute({
        name: "Ana Torres",
        email: "ana@isp.local",
        primaryDepartmentId: "00000000-0000-0000-0000-000000000000",
        actorId: "admin-1",
      }),
    ).rejects.toMatchObject({ type: "VALIDATION_ERROR" });
  });

  it("rechaza un nombre demasiado corto", async () => {
    const { useCase } = build();

    await expect(
      useCase.execute({ name: "A", email: "a@isp.local", actorId: "admin-1" }),
    ).rejects.toMatchObject({ type: "VALIDATION_ERROR" });
  });
});
