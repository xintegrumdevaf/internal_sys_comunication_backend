import { Pool } from "pg";
import Redis from "ioredis";
import { env } from "../src/shared/config/env";

async function cleanDatabase() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL);

  console.log("=== INICIANDO LIMPIEZA DE BASE DE DATOS Y REDIS ===");

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Romper FKs circulares
      console.log("1. Rompiendo FKs circulares...");
      await client.query("UPDATE conversation SET active_case_id = NULL");
      await client.query("UPDATE message SET case_id = NULL WHERE case_id IS NOT NULL");

      // 2. Limpiar tablas de calidad
      console.log("2. Limpiando calidad...");
      await client.query("DELETE FROM quality_coaching_note");
      await client.query("DELETE FROM quality_finding");
      await client.query("DELETE FROM quality_review");

      // 3. Limpiar chat interno
      console.log("3. Limpiando chat interno...");
      await client.query("DELETE FROM internal_message");
      await client.query("DELETE FROM internal_thread_participant");
      await client.query("DELETE FROM internal_thread");

      // 4. Limpiar casos, workflows y mensajes
      console.log("4. Limpiando casos, workflows, escalaciones y mensajes...");
      await client.query("DELETE FROM escalation");
      await client.query("DELETE FROM automation_state");
      await client.query("DELETE FROM workflow_event");
      await client.query("DELETE FROM workflow_execution");
      await client.query("DELETE FROM workflow_instance");
      await client.query("DELETE FROM message");
      await client.query('DELETE FROM "case"');
      await client.query("DELETE FROM conversation");

      // 5. Limpiar efectos de prueba n8n
      console.log("5. Limpiando pagos/cuentas n8n...");
      await client.query("DELETE FROM n8n_recorded_payments");
      await client.query("DELETE FROM n8n_bank_account_requests");

      // 6. Limpiar clientes y contratos (MikroTik / Identidad)
      console.log("6. Limpiando clientes y contratos de prueba...");
      await client.query("DELETE FROM contract");
      await client.query("DELETE FROM customer");

      // 7. Limpiar eventos de auditoría
      console.log("7. Limpiando eventos de auditoría...");
      await client.query("DELETE FROM audit_event");

      // 8. Limpiar agentes temporales creados por tests (manteniendo los esenciales de seed)
      console.log("8. Limpiando agentes de prueba...");
      const testAgents = await client.query<{ id: string }>(
        "SELECT id FROM agent WHERE email LIKE '%@example.com' OR email LIKE '%@test.local' OR email LIKE 'agent_%'"
      );
      if (testAgents.rows.length > 0) {
        const ids = testAgents.rows.map((r) => r.id);
        await client.query("UPDATE n8n_workflow_registry SET updated_by = NULL WHERE updated_by = ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM agent_membership WHERE agent_id = ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM agent WHERE id = ANY($1::uuid[])", [ids]);
        console.log(`   Eliminados ${ids.length} agentes de prueba.`);
      }

      await client.query("COMMIT");
      console.log("✓ Transacción de PostgreSQL completada exitosamente.");
    } catch (dbErr) {
      await client.query("ROLLBACK");
      throw dbErr;
    } finally {
      client.release();
    }

    // 9. Limpiar buffers y colas en Redis
    console.log("9. Limpiando Redis (buffers, queues)...");
    const queueKeys = await redis.keys("queue:conversation:*");
    const bufferKeys = await redis.keys("buffer:*");
    const lockKeys = await redis.keys("lock:*");
    const allKeysToDelete = [...queueKeys, ...bufferKeys, ...lockKeys];

    if (allKeysToDelete.length > 0) {
      await redis.del(...allKeysToDelete);
      console.log(`   Eliminadas ${allKeysToDelete.length} claves de cola/buffer en Redis.`);
    } else {
      console.log("   No habían claves de cola/buffer pendientes en Redis.");
    }

    // 10. Resumen de estado actual
    console.log("\n=== ESTADO FINAL DE TABLAS ESENCIALES ===");
    const agentsFinal = await pool.query("SELECT id, name, email, role FROM agent ORDER BY email");
    console.log("Agentes conservados:");
    console.table(agentsFinal.rows);

    const deptsFinal = await pool.query("SELECT id, slug, name FROM department ORDER BY slug");
    console.log("Departamentos conservados:");
    console.table(deptsFinal.rows);

    const counts = await pool.query(`
      SELECT 'conversation' AS tbl, count(*) FROM conversation
      UNION ALL SELECT 'message', count(*) FROM message
      UNION ALL SELECT 'case', count(*) FROM "case"
      UNION ALL SELECT 'workflow_instance', count(*) FROM workflow_instance
      UNION ALL SELECT 'workflow_execution', count(*) FROM workflow_execution
      UNION ALL SELECT 'customer', count(*) FROM customer
      UNION ALL SELECT 'contract', count(*) FROM contract
      UNION ALL SELECT 'audit_event', count(*) FROM audit_event
    `);
    console.log("Recuento de tablas de datos limpios (deben estar en 0):");
    console.table(counts.rows);

  } finally {
    await pool.end();
    await redis.quit();
  }
}

cleanDatabase().catch((err) => {
  console.error("Error durante la limpieza:", err);
  process.exit(1);
});
