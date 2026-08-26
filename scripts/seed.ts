import { Pool } from "pg";
import { env } from "../src/shared/config/env";
import { AgentRepositoryPg } from "../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";
import { DepartmentRepositoryPg } from "../src/core/modules/departments/infrastructure/postgres/department.repository.pg";
import { hashPassword } from "../src/shared/security/password-hasher";

// SOLO DESARROLLO — nunca usar esta contraseña en un entorno real. En
// producción los agentes deben recibir su contraseña via
// POST /api/agents/:id/reset-password.
const DEV_PASSWORD = "ChangeMe123!";

/**
 * Seed mínimo de desarrollo: 4 departamentos + admin + manager + 4 agentes.
 * Idempotente: usa ON CONFLICT en los repositorios, se puede correr varias veces.
 *
 * Departamentos: support, billing, sales, general
 * Agentes: admin@isp.local, manager@isp.local, soporte@isp.local,
 *          facturacion@isp.local, ventas@isp.local, general@isp.local
 *
 * NOTA: No se insertan conversaciones ni datos de prueba.
 */
async function run(): Promise<void> {
  console.error("[seed] BLOQUEADO: Los seeders están deshabilitados intencionalmente para no contaminar la base de datos real.");
  process.exit(1);
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const departmentRepo = new DepartmentRepositoryPg(pool);
  const agentRepo = new AgentRepositoryPg(pool);

  try {
    const support  = await departmentRepo.create({ slug: "support",  name: "Soporte Técnico" });
    const billing  = await departmentRepo.create({ slug: "billing",  name: "Facturación" });
    const sales    = await departmentRepo.create({ slug: "sales",    name: "Ventas" });
    const general  = await departmentRepo.create({ slug: "general",  name: "General" });

    const devPasswordHash = await hashPassword(DEV_PASSWORD);

    const ensureHash = async (agent: Awaited<ReturnType<typeof agentRepo.create>>) => {
      if (!agent.passwordHash) {
        return agentRepo.update(agent.id, { passwordHash: devPasswordHash });
      }
      return agent;
    };

    let admin   = await agentRepo.create({ name: "Admin Global",         email: "admin@isp.local",        role: "admin",   passwordHash: devPasswordHash });
    let manager = await agentRepo.create({ name: "Manager General",      email: "manager@isp.local",      role: "manager", passwordHash: devPasswordHash });
    let agSup   = await agentRepo.create({ name: "Agente de Soporte",    email: "soporte@isp.local",      primaryDepartmentId: support.id,  passwordHash: devPasswordHash });
    let agBil   = await agentRepo.create({ name: "Agente de Facturación",email: "facturacion@isp.local",  primaryDepartmentId: billing.id,  passwordHash: devPasswordHash });
    let agSal   = await agentRepo.create({ name: "Agente de Ventas",     email: "ventas@isp.local",       primaryDepartmentId: sales.id,    passwordHash: devPasswordHash });
    let agGen   = await agentRepo.create({ name: "Agente General",       email: "general@isp.local",      primaryDepartmentId: general.id,  passwordHash: devPasswordHash });

    admin   = await ensureHash(admin);
    manager = await ensureHash(manager);
    agSup   = await ensureHash(agSup);
    agBil   = await ensureHash(agBil);
    agSal   = await ensureHash(agSal);
    agGen   = await ensureHash(agGen);

    // Admin y Manager tienen acceso a todos los departamentos
    for (const deptId of [support.id, billing.id, sales.id, general.id]) {
      await agentRepo.addMembership(admin.id,   deptId);
      await agentRepo.addMembership(manager.id, deptId);
    }
    await agentRepo.addMembership(agSup.id, support.id);
    await agentRepo.addMembership(agBil.id, billing.id);
    await agentRepo.addMembership(agSal.id, sales.id);
    await agentRepo.addMembership(agGen.id, general.id);

    console.log("[seed] OK: 4 departamentos + admin + manager + 4 agentes");
    console.log(`[seed] Logins: admin@isp.local / manager@isp.local / soporte@isp.local / facturacion@isp.local / ventas@isp.local / general@isp.local`);
    console.log(`[seed] Contraseña de desarrollo: ${DEV_PASSWORD}`);
    console.log("[seed] (Si el agente ya existía, su contraseña actual NO se modifica)");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("[seed] falló el seed:", error);
  process.exit(1);
});
