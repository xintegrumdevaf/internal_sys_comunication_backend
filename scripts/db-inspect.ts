/**
 * Script de diagnóstico y estado de la Base de Datos.
 *
 * Uso:
 *   npx tsx scripts/db-inspect.ts
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { env } from '../src/shared/config/env';

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  try {
    console.log('\n====================================================');
    console.log('       INSPECCIÓN GENERAL DE LA BASE DE DATOS       ');
    console.log('====================================================');

    // 1. Conexión y versión
    const { rows: versionRows } = await pool.query<{ version: string; current_database: string }>(
      'SELECT version(), current_database()'
    );
    const dbName = versionRows[0]?.current_database || 'desconocida';
    const dbVer = versionRows[0]?.version?.split(' on ')[0] || 'desconocida';
    console.log(`Base de datos activa: ${dbName}`);
    console.log(`Motor: ${dbVer}`);

    // 2. Estado de Migraciones
    let appliedCount = 0;
    try {
      const { rows: migRows } = await pool.query<{ count: string }>('SELECT count(*)::text as count FROM schema_migrations');
      appliedCount = parseInt(migRows[0]?.count || '0', 10);
    } catch {
      console.warn('! Tabla schema_migrations no encontrada o no accesible.');
    }

    const migrationsDir = join(process.cwd(), 'migrations');
    const localMigrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    console.log(`Migraciones en disco: ${localMigrationFiles.length} | Aplicadas en BD: ${appliedCount}`);

    // 3. Conteo en tablas clave
    const tablesToCheck = [
      'department',
      'agent',
      'agent_membership',
      'customer',
      'contract',
      'conversation',
      'message',
      '"case"',
      'workflow_instance',
      'workflow_execution',
      'workflow_event',
      'automation_state',
      'escalation',
      'n8n_workflow_registry',
      'rag_documents',
      'n8n_vectors',
      'audit_event',
    ];

    const counts: Array<{ Tabla: string; Registros: number; Estado: string }> = [];

    for (const table of tablesToCheck) {
      try {
        const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text as count FROM ${table}`);
        const count = parseInt(rows[0]?.count || '0', 10);
        counts.push({
          Tabla: table,
          Registros: count,
          Estado: 'OK',
        });
      } catch (err: any) {
        counts.push({
          Tabla: table,
          Registros: 0,
          Estado: `Error: ${err.message}`,
        });
      }
    }

    console.log('\n--- Conteo de Registros por Tabla ---');
    console.table(counts);

    // 4. Detalle de Casos por Estado
    try {
      const { rows: caseStatusRows } = await pool.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text as count FROM "case" GROUP BY status ORDER BY count DESC`
      );
      if (caseStatusRows.length > 0) {
        console.log('\n--- Casos por Estado ---');
        console.table(caseStatusRows.map((r) => ({ Estado: r.status, Cantidad: parseInt(r.count, 10) })));
      }
    } catch {
      // Ignorar si case no tiene datos
    }

    // 5. Verificación de URLs en n8n_workflow_registry
    try {
      const { rows: registryRows } = await pool.query<{ action: string; url: string; active: boolean }>(
        'SELECT action, url, active FROM n8n_workflow_registry'
      );
      const localhostUrls = registryRows.filter((r) => r.url.includes('localhost') || r.url.includes('127.0.0.1'));
      if (localhostUrls.length > 0) {
        console.log(`\n⚠️  ADVERTENCIA: Hay ${localhostUrls.length} workflows apuntando a localhost:`);
        localhostUrls.forEach((w) => console.log(`   - [${w.action}]: ${w.url}`));
        console.log('   Si este es un entorno remoto/producción, actualízalas con scripts/manage-n8n-registry.ts');
      } else {
        console.log('\n✓ URLs de n8n_workflow_registry configuradas (sin localhost).');
      }
    } catch {
      // Ignorar
    }

    console.log('\n====================================================\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error durante la inspección:', err);
  process.exit(1);
});
