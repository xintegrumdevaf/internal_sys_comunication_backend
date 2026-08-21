import { Pool } from "pg";
import { env } from "../src/shared/config/env";
import { AgentRepositoryPg } from "../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";
import { DepartmentRepositoryPg } from "../src/core/modules/departments/infrastructure/postgres/department.repository.pg";
import { hashPassword } from "../src/shared/security/password-hasher";

// SOLO DESARROLLO — nunca usar esta contrasena en un entorno real. En
// produccion los agentes deben recibir su contrasena via
// POST /api/agents/:id/reset-password (docs/spec/06_BACKEND_GAPS.md §1.b).
const DEV_PASSWORD = "ChangeMe123!";

/**
 * Seed minimo de desarrollo (05_BUILD_PLAN.md Etapa 1: "CRUD minimo + seed").
 * Idempotente: usa ON CONFLICT en los repositorios, se puede correr varias veces
 * (el password_hash solo se fija en el INSERT inicial — si el agente ya
 * existe con una contrasena real, no se pisa).
 */
async function run(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const departmentRepo = new DepartmentRepositoryPg(pool);
  const agentRepo = new AgentRepositoryPg(pool);

  try {
    const support = await departmentRepo.create({ slug: "support", name: "Soporte tecnico" });
    const billing = await departmentRepo.create({ slug: "billing", name: "Facturacion" });
    const sales = await departmentRepo.create({ slug: "sales", name: "Ventas" });

    const devPasswordHash = await hashPassword(DEV_PASSWORD);

    let admin = await agentRepo.create({
      name: "Admin Global",
      email: "admin@isp.local",
      role: "admin",
      passwordHash: devPasswordHash,
    });
    let manager = await agentRepo.create({
      name: "Manager General",
      email: "manager@isp.local",
      role: "manager",
      passwordHash: devPasswordHash,
    });
    let supportAgent = await agentRepo.create({
      name: "Agente de Soporte",
      email: "soporte@isp.local",
      primaryDepartmentId: support.id,
      passwordHash: devPasswordHash,
    });
    let salesAgent = await agentRepo.create({
      name: "Agente de Ventas",
      email: "ventas@isp.local",
      primaryDepartmentId: sales.id,
      passwordHash: devPasswordHash,
    });

    if (!admin.passwordHash) {
      admin = await agentRepo.update(admin.id, { passwordHash: devPasswordHash });
    }
    if (!manager.passwordHash) {
      manager = await agentRepo.update(manager.id, { passwordHash: devPasswordHash });
    }
    if (!supportAgent.passwordHash) {
      supportAgent = await agentRepo.update(supportAgent.id, { passwordHash: devPasswordHash });
    }
    if (!salesAgent.passwordHash) {
      salesAgent = await agentRepo.update(salesAgent.id, { passwordHash: devPasswordHash });
    }

    await agentRepo.addMembership(admin.id, support.id);
    await agentRepo.addMembership(admin.id, billing.id);
    await agentRepo.addMembership(admin.id, sales.id);
    await agentRepo.addMembership(manager.id, support.id);
    await agentRepo.addMembership(manager.id, billing.id);
    await agentRepo.addMembership(manager.id, sales.id);
    await agentRepo.addMembership(supportAgent.id, support.id);
    await agentRepo.addMembership(salesAgent.id, sales.id);

    console.log("[seed] OK: departments + agents + memberships");
    console.log(`[seed] Login de desarrollo: admin@isp.local / manager@isp.local / soporte@isp.local / ventas@isp.local — contrasena: ${DEV_PASSWORD}`);
    console.log("[seed] (si el agente ya existia de antes, su contrasena real actual no se modifico)");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("[seed] fallo el seed:", error);
  process.exit(1);
});
