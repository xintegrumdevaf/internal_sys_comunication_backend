import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { env } from "../src/shared/config/env";

export default function setup() {
  return async function teardown() {
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    try {
      const sql = readFileSync(join(__dirname, "..", "scripts", "wipe-conversation-test-data.sql"), "utf8");
      await pool.query(sql);

      // Clean test agents created with test domains
      const testAgents = await pool.query<{ id: string }>(
        "SELECT id FROM agent WHERE email LIKE '%@example.com' OR email LIKE '%@test.local' OR email LIKE 'agent_%'"
      );

      if (testAgents.rows.length > 0) {
        const ids = testAgents.rows.map((r) => r.id);
        await pool.query("UPDATE n8n_workflow_registry SET updated_by = NULL WHERE updated_by = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM quality_coaching_note WHERE author_agent_id = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM internal_message WHERE sender_agent_id = ANY($1::uuid[])", [ids]);
        await pool.query(
          "DELETE FROM internal_thread WHERE id IN (SELECT thread_id FROM internal_thread_participant WHERE agent_id = ANY($1::uuid[]))",
          [ids]
        );
        await pool.query("DELETE FROM internal_thread_participant WHERE agent_id = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM agent_membership WHERE agent_id = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM audit_event WHERE actor_id = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM agent WHERE id = ANY($1::uuid[])", [ids]);
      }
    } catch (err) {
      console.error("[globalSetup:teardown] Error al limpiar datos de prueba:", err);
    } finally {
      await pool.end();
    }
  };
}
