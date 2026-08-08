import { Pool } from "pg";
import { env } from "../src/shared/config/env";
import { AgentRepositoryPg } from "../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";
import { DepartmentRepositoryPg } from "../src/core/modules/departments/infrastructure/postgres/department.repository.pg";

/**
 * Seed minimo de desarrollo (05_BUILD_PLAN.md Etapa 1: "CRUD minimo + seed").
 * Idempotente: usa ON CONFLICT en los repositorios, se puede correr varias veces.
 */
async function run(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const departmentRepo = new DepartmentRepositoryPg(pool);
  const agentRepo = new AgentRepositoryPg(pool);

  try {
    const support = await departmentRepo.create({ slug: "support", name: "Soporte tecnico" });
    const billing = await departmentRepo.create({ slug: "billing", name: "Facturacion" });
    const sales = await departmentRepo.create({ slug: "sales", name: "Ventas" });

    const admin = await agentRepo.create({
      name: "Admin Global",
      email: "admin@isp.local",
      role: "admin",
    });
    const supportAgent = await agentRepo.create({
      name: "Agente de Soporte",
      email: "soporte@isp.local",
      primaryDepartmentId: support.id,
    });

    await agentRepo.addMembership(admin.id, support.id);
    await agentRepo.addMembership(admin.id, billing.id);
    await agentRepo.addMembership(admin.id, sales.id);
    await agentRepo.addMembership(supportAgent.id, support.id);

    console.log("[seed] OK: departments + agents + memberships");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("[seed] fallo el seed:", error);
  process.exit(1);
});
