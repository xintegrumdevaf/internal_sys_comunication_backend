/**
 * Script de importación de workflows a n8n
 * Uso:
 *   npx tsx scripts/import-workflows-to-prod.ts <N8N_URL> <N8N_API_KEY>
 * O mediante variables de entorno:
 *   N8N_PROD_URL=... N8N_PROD_API_KEY=... npx tsx scripts/import-workflows-to-prod.ts
 */
import fs from 'fs';
import path from 'path';

const N8N_URL = process.argv[2] || process.env.N8N_PROD_URL || process.env.N8N_API_URL;
const API_KEY = process.argv[3] || process.env.N8N_PROD_API_KEY || process.env.N8N_API_KEY;

if (!N8N_URL || !API_KEY) {
  console.error('Uso: npx tsx scripts/import-workflows-to-prod.ts <N8N_URL> <N8N_API_KEY>');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'X-N8N-API-KEY': API_KEY,
};

interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
}

async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<{ status: number; data: T }> {
  const url = `${N8N_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data };
}

async function main() {
  console.log(`Conectando a n8n en: ${N8N_URL}`);

  // 1. Obtener workflows existentes
  const existingRes = await apiRequest<{ data: N8nWorkflowSummary[] }>('/api/v1/workflows');
  if (existingRes.status !== 200) {
    throw new Error(`Error al listar workflows: ${existingRes.status} ${JSON.stringify(existingRes.data)}`);
  }
  const existingWorkflows = existingRes.data.data || [];
  console.log(`Workflows actuales en n8n: ${existingWorkflows.length}`);

  const workflowsDir = path.resolve('n8n');
  const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.json'));
  console.log(`Archivos a importar (${files.length}):`, files);

  const results: Array<{
    file: string;
    name: string;
    id: string;
    status: 'created' | 'updated';
    active: boolean;
    webhookPath?: string;
    error?: string;
  }> = [];

  for (const file of files) {
    const rawContent = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    const wf = JSON.parse(rawContent);
    const wfName = wf.name;

    console.log(`\nProcesando ${file} (${wfName})...`);

    // Adaptar nodes compatibles con la versión de n8n instalada en el host
    const sanitizedNodes = (wf.nodes || []).map((node: any) => {
      const copy = JSON.parse(JSON.stringify(node));

      // n8n prod soporta set hasta 3.4
      if (copy.type === 'n8n-nodes-base.set' && copy.typeVersion > 3.4) {
        copy.typeVersion = 3.4;
      }

      // n8n prod soporta formTrigger hasta 2.5
      if (copy.type === 'n8n-nodes-base.formTrigger' && copy.typeVersion > 2.5) {
        copy.typeVersion = 2.5;
      }

      return copy;
    });

    // Sanitizar settings
    const cleanSettings: Record<string, any> = {
      executionOrder: wf.settings?.executionOrder || 'v1',
    };
    if (wf.settings?.callerPolicy) cleanSettings.callerPolicy = wf.settings.callerPolicy;
    if (wf.settings?.availableInMCP !== undefined) cleanSettings.availableInMCP = wf.settings.availableInMCP;

    const payload = {
      name: wfName,
      nodes: sanitizedNodes,
      connections: wf.connections || {},
      settings: cleanSettings,
    };

    // Identificar si existe para actualizar o recrear
    const existing = existingWorkflows.find((w) => w.name === wfName);
    let targetId: string;
    let opStatus: 'created' | 'updated' = 'created';

    if (existing) {
      console.log(`  Actualizando workflow existente ID: ${existing.id}`);
      const updateRes = await apiRequest<any>(`/api/v1/workflows/${existing.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });

      if (updateRes.status !== 200) {
        console.error(`  Error actualizando ${wfName}:`, updateRes.data);
        results.push({
          file,
          name: wfName,
          id: existing.id,
          status: 'updated',
          active: false,
          error: updateRes.data?.message || String(updateRes.data),
        });
        continue;
      }
      targetId = existing.id;
      opStatus = 'updated';
    } else {
      console.log(`  Creando nuevo workflow: ${wfName}`);
      const createRes = await apiRequest<any>('/api/v1/workflows', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (createRes.status !== 200 && createRes.status !== 201) {
        console.error(`  Error creando ${wfName}:`, createRes.data);
        results.push({
          file,
          name: wfName,
          id: '',
          status: 'created',
          active: false,
          error: createRes.data?.message || String(createRes.data),
        });
        continue;
      }
      targetId = createRes.data.id;
    }

    // Activar workflow
    const actRes = await apiRequest<any>(`/api/v1/workflows/${targetId}/activate`, {
      method: 'POST',
    });

    const isActivated = actRes.status === 200;
    if (!isActivated) {
      console.warn(`  Aviso: no se pudo activar ${wfName}:`, actRes.data?.message || actRes.data);
    } else {
      console.log(`  Activado exitosamente: ${wfName} (${targetId})`);
    }

    // Extraer ruta de webhook / form si existe
    const whNode = sanitizedNodes.find(
      (n: any) => n.type === 'n8n-nodes-base.webhook' || n.type === 'n8n-nodes-base.formTrigger'
    );
    const pathValue = whNode?.parameters?.path || whNode?.parameters?.options?.path;

    results.push({
      file,
      name: wfName,
      id: targetId,
      status: opStatus,
      active: isActivated,
      webhookPath: pathValue,
      error: isActivated ? undefined : actRes.data?.message,
    });
  }

  console.log('\n================ RESUMEN DE IMPORTACIÓN ================');
  console.table(
    results.map((r) => ({
      Workflow: r.name,
      ID: r.id,
      Operación: r.status,
      Activo: r.active ? 'SÍ' : 'NO',
      WebhookPath: r.webhookPath || 'N/A',
      Error: r.error || 'Ninguno',
    }))
  );
}

main().catch((err) => {
  console.error('Fallo general:', err);
  process.exit(1);
});
