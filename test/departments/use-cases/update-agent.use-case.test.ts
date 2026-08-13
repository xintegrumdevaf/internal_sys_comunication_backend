import { describe, expect, it } from "vitest";
import { UpdateAgentUseCase } from "../../../src/core/modules/departments/application/use-cases/update-agent.use-case";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { DepartmentRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

function build() {
  const agentRepo = new AgentRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const useCase = new UpdateAgentUseCase({ agentRepo, departmentRepo, auditRepo, logger: silentLogger });
  return { agentRepo, departmentRepo, auditRepo, useCase };
}

describe("UpdateAgentUseCase (docs/spec/06_BACKEND_GAPS.md §1 PUT /api/agents/:id)", () => {
  it("actualiza los campos presentes en el patch y registra audit_event", async () => {
    const { agentRepo, auditRepo, useCase } = build();
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent" });

    const updated = await useCase.execute({
      agentId: agent.id,
      patch: { name: "Ana Torres", role: "manager" },
      actorId: "admin-1",
    });

    expect(updated).toMatchObject({ name: "Ana Torres", role: "manager", email: "ana@isp.local" });
    expect(auditRepo.events).toContainEqual(
      expect.objectContaining({ action: "AGENT_UPDATED", resourceId: agent.id, actorId: "admin-1" }),
    );
  });

  it("rechaza cambiar el email a uno que ya usa otro agente", async () => {
    const { agentRepo, useCase } = build();
    agentRepo.seed({ name: "Existente", email: "ocupado@isp.local" });
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local" });

    await expect(
      useCase.execute({ agentId: agent.id, patch: { email: "Ocupado@ISP.local" }, actorId: "admin-1" }),
    ).rejects.toMatchObject({ type: "BUSINESS_ERROR" });
  });

  it("permite conservar el propio email al actualizar otros campos", async () => {
    const { agentRepo, useCase } = build();
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local" });

    const updated = await useCase.execute({
      agentId: agent.id,
      patch: { email: "ana@isp.local", name: "Ana T." },
      actorId: "admin-1",
    });

    expect(updated.name).toBe("Ana T.");
  });

  it("rechaza un agente inexistente", async () => {
    const { useCase } = build();
    await expect(
      useCase.execute({ agentId: "no-existe", patch: { name: "X" }, actorId: "admin-1" }),
    ).rejects.toMatchObject({ type: "NOT_FOUND" });
  });

  it("no permite quitarle el rol admin al unico administrador activo", async () => {
    const { agentRepo, useCase } = build();
    const admin = agentRepo.seed({ name: "Admin", email: "admin@isp.local", role: "admin" });

    await expect(
      useCase.execute({ agentId: admin.id, patch: { role: "agent" }, actorId: admin.id }),
    ).rejects.toMatchObject({ type: "BUSINESS_ERROR" });
  });

  it("no permite desactivar al unico administrador activo via active:false", async () => {
    const { agentRepo, useCase } = build();
    const admin = agentRepo.seed({ name: "Admin", email: "admin@isp.local", role: "admin" });

    await expect(
      useCase.execute({ agentId: admin.id, patch: { active: false }, actorId: admin.id }),
    ).rejects.toMatchObject({ type: "BUSINESS_ERROR" });
  });

  it("permite activar y desactivar autoAssignEnabled via patch parcial", async () => {
    const { agentRepo, useCase } = build();
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent" });
    expect(agent.autoAssignEnabled).toBe(false);

    const enabled = await useCase.execute({
      agentId: agent.id,
      patch: { autoAssignEnabled: true },
      actorId: "admin-1",
    });
    expect(enabled.autoAssignEnabled).toBe(true);

    const disabled = await useCase.execute({
      agentId: agent.id,
      patch: { autoAssignEnabled: false },
      actorId: "admin-1",
    });
    expect(disabled.autoAssignEnabled).toBe(false);
  });

  it("si hay mas de un admin activo, si permite degradar o desactivar a uno de ellos", async () => {
    const { agentRepo, useCase } = build();
    const admin1 = agentRepo.seed({ name: "Admin 1", email: "admin1@isp.local", role: "admin" });
    agentRepo.seed({ name: "Admin 2", email: "admin2@isp.local", role: "admin" });

    const updated = await useCase.execute({
      agentId: admin1.id,
      patch: { active: false },
      actorId: "admin2-id",
    });

    expect(updated.active).toBe(false);
  });
});
