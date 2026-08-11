import { describe, expect, it } from "vitest";
import { ChangePasswordUseCase } from "../../../src/core/modules/auth/application/use-cases/change-password.use-case";
import { hashPassword, verifyPassword } from "../../../src/shared/security/password-hasher";
import { AgentRepositoryFake } from "../../support/agent-audit.fakes";
import { silentLogger } from "../../support/silent-logger";

function build() {
  const agentRepo = new AgentRepositoryFake();
  const useCase = new ChangePasswordUseCase({ agentRepo, logger: silentLogger });
  return { agentRepo, useCase };
}

describe("ChangePasswordUseCase (docs/spec/06_BACKEND_GAPS.md §1.b POST /api/auth/change-password)", () => {
  it("cambia la contrasena cuando la actual es correcta", async () => {
    const { agentRepo, useCase } = build();
    const passwordHash = await hashPassword("temporal123");
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", passwordHash });

    await useCase.execute({ agentId: agent.id, currentPassword: "temporal123", newPassword: "MiPropia2024!" });

    const updated = agentRepo.agents.get(agent.id)!;
    expect(await verifyPassword(updated.passwordHash!, "MiPropia2024!")).toBe(true);
    expect(await verifyPassword(updated.passwordHash!, "temporal123")).toBe(false);
  });

  it("rechaza si la contrasena actual no coincide", async () => {
    const { agentRepo, useCase } = build();
    const passwordHash = await hashPassword("temporal123");
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", passwordHash });

    await expect(
      useCase.execute({ agentId: agent.id, currentPassword: "incorrecta", newPassword: "MiPropia2024!" }),
    ).rejects.toMatchObject({ type: "AUTHORIZATION_ERROR" });
  });

  it("rechaza una contrasena nueva demasiado corta", async () => {
    const { agentRepo, useCase } = build();
    const passwordHash = await hashPassword("temporal123");
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", passwordHash });

    await expect(
      useCase.execute({ agentId: agent.id, currentPassword: "temporal123", newPassword: "corta" }),
    ).rejects.toMatchObject({ type: "VALIDATION_ERROR" });
  });
});
