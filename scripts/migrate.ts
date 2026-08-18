import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { env } from "../src/shared/config/env";

/**
 * Runner de migraciones minimalista (AGENTS.md: "migraciones SQL
 * versionadas y reproducibles, nunca synchronize/auto-schema magico").
 * Aplica en orden cada archivo .sql de migrations/ que no conste aun
 * en la tabla schema_migrations, dentro de una transaccion por archivo.
 */
async function run(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = join(process.cwd(), "migrations");
    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const { rows } = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.id));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] ya aplicada: ${file}`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      const client = await pool.connect();
      console.log(`[migrate] aplicando ${file}...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`[migrate] OK ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("[migrate] fallo la migracion:", error);
  process.exit(1);
});
