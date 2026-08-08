import { Pool, type PoolClient } from "pg";
import type { Env } from "../config/env";

export function createPostgresPool(env: Env): Pool {
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  pool.on("error", (error) => {
    // Conexiones ociosas del pool pueden fallar de forma asincrona;
    // sin este handler, Node tumba el proceso con un error no capturado.
    console.error("[postgres] error inesperado en el pool", error);
  });

  return pool;
}

export async function checkPostgresConnection(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Unit of Work explicito (docs/skills/design-patterns-backend.md).
 * Usar siempre que una operacion toque mas de una tabla de forma atomica
 * (ej. crear Case + WorkflowInstance + WorkflowEvent en la misma transaccion).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
