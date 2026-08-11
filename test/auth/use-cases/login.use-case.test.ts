import { describe, expect, it } from "vitest";
import { LoginUseCase } from "../../../src/core/modules/auth/application/use-cases/login.use-case";
import { hashPassword } from "../../../src/shared/security/password-hasher";
import { AgentRepositoryFake } from "../../support/agent-audit.fakes";
import { SessionStoreFake } from "../../support/session-store.fake";
import { silentLogger } from "../../support/silent-logger";

function build() {
  const agentRepo = new AgentRepositoryFake();
  const sessionStore = new SessionStoreFake();
  const useCase = new LoginUseCase({ agentRepo, sessionStore, sessionTtlSeconds: 43200, logger: silentLogger });
  return { agentRepo, sessionStore, useCase };
}

describe("LoginUseCase (docs/spec/06_BACKEND_GAPS.md §1.b POST /api/auth/login)", () => {
  it("con credenciales correctas crea una sesion real en el store", async () => {
    const { agentRepo, sessionStore, useCase } = build();
    const passwordHash = await hashPassword("Sup3rSecreta!");
    const agent = agentRepo.seed({ name: "Ana", email: "Ana@ISP.local", passwordHash });

    const { agent: loggedIn, session } = await useCase.execute({
      email: "ana@isp.local",
      password: "Sup3rSecreta!",
    });

    expect(loggedIn.id).toBe(agent.id);
    expect(session.agentId).toBe(agent.id);
    expect(sessionStore.sessions.has(session.token)).toBe(true);
  });

  it("rechaza una contrasena incorrecta con el mismo mensaje generico", async () => {
    const { agentRepo, useCase } = build();
    const passwordHash = await hashPassword("Sup3rSecreta!");
    agentRepo.seed({ name: "Ana", email: "ana@isp.local", passwordHash });

    await expect(
      useCase.execute({ email: "ana@isp.local", password: "incorrecta" }),
    ).rejects.toMatchObject({ type: "AUTHORIZATION_ERROR", message: "Correo o contraseña incorrectos" });
  });

  it("rechaza un correo que no existe con el mismo mensaje generico (no revela si el correo existe)", async () => {
    const { useCase } = build();

    await expect(
      useCase.execute({ email: "nadie@isp.local", password: "lo-que-sea" }),
    ).rejects.toMatchObject({ type: "AUTHORIZATION_ERROR", message: "Correo o contraseña incorrectos" });
  });

  it("rechaza a un agente inactivo aunque la contrasena sea correcta", async () => {
    const { agentRepo, useCase } = build();
    const passwordHash = await hashPassword("Sup3rSecreta!");
    agentRepo.seed({ name: "Ana", email: "ana@isp.local", passwordHash, active: false });

    await expect(
      useCase.execute({ email: "ana@isp.local", password: "Sup3rSecreta!" }),
    ).rejects.toMatchObject({ type: "AUTHORIZATION_ERROR" });
  });

  it("rechaza a un agente que todavia no tiene contrasena configurada", async () => {
    const { agentRepo, useCase } = build();
    agentRepo.seed({ name: "Ana", email: "ana@isp.local" }); // sin passwordHash

    await expect(
      useCase.execute({ email: "ana@isp.local", password: "cualquiera" }),
    ).rejects.toMatchObject({ type: "AUTHORIZATION_ERROR" });
  });
});
