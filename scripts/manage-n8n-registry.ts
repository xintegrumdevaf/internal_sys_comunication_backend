/**
 * Script administrativo para gestionar el catalogo `n8n_workflow_registry`.
 *
 * Uso:
 *   npx tsx scripts/manage-n8n-registry.ts list
 *   npx tsx scripts/manage-n8n-registry.ts set-base-url <http://n8n-host:puerto>
 *   npx tsx scripts/manage-n8n-registry.ts set-url <ACTION> <URL>
 *   npx tsx scripts/manage-n8n-registry.ts toggle <ACTION> [true|false]
 */
import { Pool } from 'pg';
import { env } from '../src/shared/config/env';

interface RegistryRow {
  action: string;
  category: string;
  url: string;
  description: string | null;
  timeout_ms: number;
  max_retries: number;
  active: boolean;
  updated_at: Date;
}

async function main() {
  const command = process.argv[2] || 'list';
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  try {
    if (command === 'list') {
      const { rows } = await pool.query<RegistryRow>(
        `SELECT action, category, url, timeout_ms, max_retries, active, updated_at 
         FROM n8n_workflow_registry 
         ORDER BY category, action`
      );

      console.log(`\n=== n8n_workflow_registry (${rows.length} registros) ===`);
      console.table(
        rows.map((r) => ({
          Acción: r.action,
          Categoría: r.category,
          URL: r.url,
          'Timeout (ms)': r.timeout_ms,
          Activo: r.active ? 'SÍ' : 'NO',
          'Última act.': r.updated_at.toISOString(),
        }))
      );
      return;
    }

    if (command === 'set-base-url') {
      const newBaseUrl = process.argv[3];
      if (!newBaseUrl) {
        console.error('Error: Debes proporcionar la nueva URL base.');
        console.error('Ejemplo: npx tsx scripts/manage-n8n-registry.ts set-base-url http://n8n.tu-dominio.com');
        process.exit(1);
      }

      const cleanBase = newBaseUrl.replace(/\/+$/, '');
      const { rows } = await pool.query<RegistryRow>('SELECT action, url FROM n8n_workflow_registry');

      let updatedCount = 0;
      for (const row of rows) {
        try {
          const parsed = new URL(row.url);
          const pathAndQuery = parsed.pathname + parsed.search;
          const updatedUrl = `${cleanBase}${pathAndQuery}`;

          await pool.query(
            `UPDATE n8n_workflow_registry 
             SET url = $1, updated_at = NOW() 
             WHERE action = $2`,
            [updatedUrl, row.action]
          );
          console.log(`✓ [${row.action}] -> ${updatedUrl}`);
          updatedCount++;
        } catch {
          console.warn(`! URL no válida para la acción ${row.action}: ${row.url}`);
        }
      }

      console.log(`\nSe actualizaron exitosamente ${updatedCount} URLs con base: ${cleanBase}`);
      return;
    }

    if (command === 'set-url') {
      const action = process.argv[3]?.toUpperCase();
      const newUrl = process.argv[4];

      if (!action || !newUrl) {
        console.error('Error: Faltan argumentos.');
        console.error('Ejemplo: npx tsx scripts/manage-n8n-registry.ts set-url CHECK_BALANCE http://.../webhook/check-balance');
        process.exit(1);
      }

      const res = await pool.query(
        `UPDATE n8n_workflow_registry 
         SET url = $1, updated_at = NOW() 
         WHERE action = $2`,
        [newUrl, action]
      );

      if (res.rowCount === 0) {
        console.error(`No se encontró la acción '${action}' en n8n_workflow_registry.`);
        process.exit(1);
      }

      console.log(`✓ Acción '${action}' actualizada a: ${newUrl}`);
      return;
    }

    if (command === 'toggle') {
      const action = process.argv[3]?.toUpperCase();
      const explicitState = process.argv[4];

      if (!action) {
        console.error('Error: Faltan argumentos.');
        console.error('Ejemplo: npx tsx scripts/manage-n8n-registry.ts toggle CHECK_BALANCE [true|false]');
        process.exit(1);
      }

      let query: string;
      let params: any[];

      if (explicitState !== undefined) {
        query = 'UPDATE n8n_workflow_registry SET active = $1, updated_at = NOW() WHERE action = $2 RETURNING active';
        params = [explicitState.toLowerCase() === 'true', action];
      } else {
        query = 'UPDATE n8n_workflow_registry SET active = NOT active, updated_at = NOW() WHERE action = $1 RETURNING active';
        params = [action];
      }

      const res = await pool.query(query, params);
      if (res.rowCount === 0) {
        console.error(`No se encontró la acción '${action}' en n8n_workflow_registry.`);
        process.exit(1);
      }

      console.log(`✓ Acción '${action}' ahora tiene active = ${res.rows[0].active}`);
      return;
    }

    console.log(`Comando desconocido: ${command}`);
    console.log('Comandos disponibles: list, set-base-url, set-url, toggle');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
