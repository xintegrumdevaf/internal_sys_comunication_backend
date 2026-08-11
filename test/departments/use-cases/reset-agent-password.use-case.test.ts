import { describe, expect, it } from "vitest";
import { ResetAgentPasswordUseCase } from "../../../src/core/modules/departments/application/use-cases/reset-agent-password.use-case";
import { verifyPassword } from "../../../src/shared/security/password-hasher";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { silentLogger } from "../../support/silent-logger";

function build() {
  const agentRepo = new AgentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const useCase = new ResetAgentPasswordUseCase({ agentRepo, auditRepo, logger: silentLogger });
  return { agentRepo, auditRepo, useCase };
}

describe("ResetAgentPasswordUseCase (docs/spec/06_BACKEND_GAPS.md §1.b POST /api/agents/:id/reset-password)", () => {
  it("genera una contrasena temporal nueva que reemplaza cualquier contrasena anterior", async () => {
    const { agentRepo, auditRepo, useCase } = build();
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", passwordHash: "hash-viejo" });

    const { agent: updated, temporaryPassword } = await useCase.execute({
      agentId: agent.id,
      actorId: "admin-1",
    });

    expect(temporaryPassword).toHaveLength(12);
    expect(updated.passwordHash).not.toBe("hash-viejo");
    expect(await verifyPassword(updated.passwordHash!, temporaryPassword)).toBe(true);
    expect(auditRepo.events).toContainEqual(
      expect.objectContaining({ action: "AGENT_PASSWORD_RESET", resourceId: agent.id, actorId: "admin-1" }),
    );
  });

  it("funciona para un agente sembrado antes de esta migracion (sin contrasena todavia)", async () => {
    const { agentRepo, useCase } = build();
    const agent = agentRepo.seed({ name: "Admin Global", email: "admin@isp.local" }); // sin passwordHash

    const { agent: updated } = await useCase.execute({ agentId: agent.id, actorId: "admin-1" });
    expect(updated.passwordHash).toBeTruthy();
  });

  it("rechaza un agente inexistente", async () => {
    const { useCase } = build();
    await expect(useCase.execute({ agentId: "no-existe", actorId: "admin-1" })).rejects.toMatchObject({
      type: "NOT_FOUND",
    });
  });
});
