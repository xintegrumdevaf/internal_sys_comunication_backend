import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { env } from "../src/shared/config/env";

/**
 * Script de generación de datos mock realistas para probar:
 * - Home Dashboard: Casos desatendidos, cola sin asignar, carga por agente y depto.
 * - Analytics: Tiempos de espera pendientes (maxPendingWaitMinutes), FRT, distribución y eficiencia.
 *
 * Ejecución:
 *   npx tsx scripts/seed-mock-analytics.ts
 */
async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  console.log("=== POBLANDO DATOS MOCK PARA DASHBOARD Y ANALYTICS ===");

  try {
    const { rows: agents } = await pool.query<{ id: string; name: string; primary_department_id: string | null }>(
      "SELECT id, name, primary_department_id FROM agent WHERE role = 'agent'"
    );
    const { rows: depts } = await pool.query<{ id: string; name: string; slug: string }>(
      "SELECT id, name, slug FROM department"
    );

    if (agents.length === 0 || depts.length === 0) {
      console.error("No se encontraron agentes o departamentos suficientes.");
      process.exit(1);
    }

    const supportDept = depts.find((d) => d.slug === "support") || depts[0]!;
    const billingDept = depts.find((d) => d.slug === "billing") || depts[1] || depts[0]!;
    const salesDept = depts.find((d) => d.slug === "sales") || depts[2] || depts[0]!;

    const supportAgent = agents.find((a) => a.primary_department_id === supportDept.id) || agents[0]!;
    const billingAgent = agents.find((a) => a.primary_department_id === billingDept.id) || agents[1] || agents[0]!;
    const salesAgent = agents.find((a) => a.primary_department_id === salesDept.id) || agents[2] || agents[0]!;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Clientes mock
      const mockClients = [
        { id: randomUUID(), phone: "+593991110001", name: "Carlos Mendoza" },
        { id: randomUUID(), phone: "+593991110002", name: "Lucía Paredes" },
        { id: randomUUID(), phone: "+593991110003", name: "Andrés Guitiérrez" },
        { id: randomUUID(), phone: "+593991110004", name: "Mariana Silva" },
        { id: randomUUID(), phone: "+593991110005", name: "Roberto Torres" },
        { id: randomUUID(), phone: "+593991110006", name: "Elena Salazar" },
        { id: randomUUID(), phone: "+593991110007", name: "Diego Benítez" },
        { id: randomUUID(), phone: "+593991110008", name: "Valeria Morales" },
        { id: randomUUID(), phone: "+593991110009", name: "Javier Viteri" },
        { id: randomUUID(), phone: "+593991110010", name: "Sofía Cárdenas" },
      ];

      for (const mc of mockClients) {
        await client.query(
          `INSERT INTO customer (id, wa_phone, full_name, created_at, updated_at)
           VALUES ($1, $2, $3, now() - INTERVAL '5 days', now())
           ON CONFLICT (wa_phone) DO UPDATE SET full_name = EXCLUDED.full_name`,
          [mc.id, mc.phone, mc.name]
        );
      }

      console.log("1. Creando casos NO ASIGNADOS (Cola / Triaje)...");
      // Caso 1: En cola de Soporte (sin asignar, esperando 12 minutos)
      await createCaseWithConversation(client, {
        customer: mockClients[0]!,
        workflowType: "SUPPORT_INTERNET",
        departmentId: supportDept.id,
        agentId: null,
        status: "ESCALATED",
        escalationReason: "Cliente reporta luz roja LOS en ONT",
        minutesAgo: 12,
        isUnassigned: true,
      });

      // Caso 2: En cola de Facturación (sin asignar, esperando 35 minutos)
      await createCaseWithConversation(client, {
        customer: mockClients[1]!,
        workflowType: "BILLING_BALANCE",
        departmentId: billingDept.id,
        agentId: null,
        status: "ESCALATED",
        escalationReason: "Doble débito bancario no acreditado",
        minutesAgo: 35,
        isUnassigned: true,
      });

      // Caso 3: En cola de Ventas (sin asignar, esperando 4 minutos)
      await createCaseWithConversation(client, {
        customer: mockClients[2]!,
        workflowType: "GENERAL_INQUIRY",
        departmentId: salesDept.id,
        agentId: null,
        status: "ESCALATED",
        escalationReason: "Interés en contratación de plan 300MB",
        minutesAgo: 4,
        isUnassigned: true,
      });

      console.log("2. Creando casos DESATENDIDOS (Asignados esperando respuesta de agente)...");
      // Caso 4: Asignado a Soporte, cliente preguntó hace 18 minutos, sin respuesta humana
      await createCaseWithConversation(client, {
        customer: mockClients[3]!,
        workflowType: "SUPPORT_INTERNET",
        departmentId: supportDept.id,
        agentId: supportAgent.id,
        status: "HUMAN_ACTIVE",
        escalationReason: "Corte intermitente",
        minutesAgo: 45,
        lastCustomerMessageMinutesAgo: 18,
      });

      // Caso 5: Asignado a Facturación, cliente esperando hace 70 minutos (SLA crítico)
      await createCaseWithConversation(client, {
        customer: mockClients[4]!,
        workflowType: "BILLING_BALANCE",
        departmentId: billingDept.id,
        agentId: billingAgent.id,
        status: "HUMAN_ACTIVE",
        escalationReason: "Revisión de factura con error en recargo",
        minutesAgo: 90,
        lastCustomerMessageMinutesAgo: 70,
      });

      // Caso 6: Asignado a Ventas, cliente esperando hace 8 minutos
      await createCaseWithConversation(client, {
        customer: mockClients[5]!,
        workflowType: "GENERAL_INQUIRY",
        departmentId: salesDept.id,
        agentId: salesAgent.id,
        status: "HUMAN_ACTIVE",
        escalationReason: "Consulta cobertura fibra en barrio norte",
        minutesAgo: 20,
        lastCustomerMessageMinutesAgo: 8,
      });

      console.log("3. Creando casos ACTIVOS ATENDIDOS (Con First Response Time)...");
      // Caso 7: Atendido por soporte con respuesta rápida (FRT 2 minutos)
      await createCaseWithConversation(client, {
        customer: mockClients[6]!,
        workflowType: "SUPPORT_INTERNET",
        departmentId: supportDept.id,
        agentId: supportAgent.id,
        status: "HUMAN_ACTIVE",
        escalationReason: "Configuración router",
        minutesAgo: 60,
        agentAnsweredMinutesAgo: 5,
        firstReplyMinutes: 2,
      });

      // Caso 8: Atendido por ventas (FRT 4 minutos)
      await createCaseWithConversation(client, {
        customer: mockClients[7]!,
        workflowType: "GENERAL_INQUIRY",
        departmentId: salesDept.id,
        agentId: salesAgent.id,
        status: "HUMAN_ACTIVE",
        escalationReason: "Cambio de domicilio",
        minutesAgo: 40,
        agentAnsweredMinutesAgo: 15,
        firstReplyMinutes: 4,
      });

      console.log("4. Creando casos COMPLETADOS (Para histórico y gráficas)...");
      for (let i = 8; i < mockClients.length; i++) {
        await createCaseWithConversation(client, {
          customer: mockClients[i]!,
          workflowType: i % 2 === 0 ? "SUPPORT_INTERNET" : "BILLING_BALANCE",
          departmentId: i % 2 === 0 ? supportDept.id : billingDept.id,
          agentId: i % 2 === 0 ? supportAgent.id : billingAgent.id,
          status: "COMPLETED",
          escalationReason: "Caso resuelto",
          minutesAgo: 180 + i * 30,
          completedMinutesAgo: 30 + i * 10,
          firstReplyMinutes: 3,
        });
      }

      await client.query("COMMIT");
      console.log("=== DATOS MOCK GENERADOS CON ÉXITO ===");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

interface CaseOpts {
  customer: { id: string; phone: string; name: string };
  workflowType: string;
  departmentId: string;
  agentId: string | null;
  status: "ESCALATED" | "HUMAN_ACTIVE" | "COMPLETED";
  escalationReason: string;
  minutesAgo: number;
  isUnassigned?: boolean;
  lastCustomerMessageMinutesAgo?: number;
  agentAnsweredMinutesAgo?: number;
  completedMinutesAgo?: number;
  firstReplyMinutes?: number;
}

async function createCaseWithConversation(client: any, opts: CaseOpts) {
  const caseId = randomUUID();
  const convId = randomUUID();
  const createdAt = new Date(Date.now() - opts.minutesAgo * 60000);
  const completedAt = opts.completedMinutesAgo
    ? new Date(Date.now() - opts.completedMinutesAgo * 60000)
    : null;

  // 1. Crear conversación
  await client.query(
    `INSERT INTO conversation (
       id, wa_phone, customer_id, status, active_case_id, unread_count, created_at, updated_at, last_activity_at
     ) VALUES ($1, $2, $3, $4, NULL, $5, $6, now(), now())`,
    [
      convId,
      opts.customer.phone,
      opts.customer.id,
      opts.status === "COMPLETED" ? "resolved" : "open",
      opts.lastCustomerMessageMinutesAgo ? 1 : 0,
      createdAt,
    ]
  );

  // 2. Crear Caso
  await client.query(
    `INSERT INTO "case" (
       id, conversation_id, workflow_type, status, department_id, assigned_agent_id,
       context, version, last_activity_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 1, now(), $7, now())`,
    [
      caseId,
      convId,
      opts.workflowType,
      opts.status,
      opts.departmentId,
      opts.agentId,
      createdAt,
    ]
  );

  // 2b. Vincular active_case_id si no está completado
  if (opts.status !== "COMPLETED") {
    await client.query(
      `UPDATE conversation SET active_case_id = $1 WHERE id = $2`,
      [caseId, convId]
    );
  }

  // 3. Crear Escalación si aplica
  if (opts.isUnassigned || opts.status === "ESCALATED" || opts.status === "HUMAN_ACTIVE" || opts.status === "COMPLETED") {
    await client.query(
      `INSERT INTO escalation (
         id, case_id, department_id, priority, reason, summary, status, assigned_agent_id, created_at, resolved_at
       ) VALUES ($1, $2, $3, 'normal', $4, '{}'::jsonb, $5, $6, $7, $8)`,
      [
        randomUUID(),
        caseId,
        opts.departmentId,
        opts.escalationReason,
        opts.isUnassigned ? "PENDING" : "RESOLVED",
        opts.agentId,
        createdAt,
        opts.isUnassigned ? null : createdAt,
      ]
    );
  }

  // 4. Crear Eventos de workflow para conteos de rendimiento
  if (opts.agentId) {
    await client.query(
      `INSERT INTO workflow_event (
         id, case_id, type, payload, occurred_at
       ) VALUES ($1, $2, 'CASE_ASSIGNED', $3, $4)`,
      [
        randomUUID(),
        caseId,
        JSON.stringify({ agentId: opts.agentId, departmentId: opts.departmentId, caseId }),
        createdAt,
      ]
    );
  }

  // 5. Mensajes
  // Mensaje inicial del cliente
  await client.query(
    `INSERT INTO message (
       id, conversation_id, case_id, direction, author, body, type, status, created_at
     ) VALUES ($1, $2, $3, 'inbound', 'customer', $4, 'text', 'delivered', $5)`,
    [
      randomUUID(),
      convId,
      caseId,
      `Hola, necesito ayuda con: ${opts.escalationReason}`,
      createdAt,
    ]
  );

  // Mensaje de respuesta del agente si aplica
  if (opts.firstReplyMinutes && opts.agentId) {
    const replyDate = new Date(createdAt.getTime() + opts.firstReplyMinutes * 60000);
    await client.query(
      `INSERT INTO message (
         id, conversation_id, case_id, direction, author, agent_id, body, type, status, created_at
       ) VALUES ($1, $2, $3, 'outbound', 'agent', $4, 'Hola, soy tu asesor. Con gusto te atiendo.', 'text', 'delivered', $5)`,
      [randomUUID(), convId, caseId, opts.agentId, replyDate]
    );
  }

  // Si está desatendido, añadir un último mensaje del cliente sin responder
  if (opts.lastCustomerMessageMinutesAgo) {
    const lastMsgDate = new Date(Date.now() - opts.lastCustomerMessageMinutesAgo * 60000);
    await client.query(
      `INSERT INTO message (
         id, conversation_id, case_id, direction, author, body, type, status, created_at
       ) VALUES ($1, $2, $3, 'inbound', 'customer', '¿Hola? Sigo esperando su respuesta por favor.', 'text', 'delivered', $4)`,
      [randomUUID(), convId, caseId, lastMsgDate]
    );
  } else if (opts.agentAnsweredMinutesAgo && opts.agentId) {
    const agentMsgDate = new Date(Date.now() - opts.agentAnsweredMinutesAgo * 60000);
    await client.query(
      `INSERT INTO message (
         id, conversation_id, case_id, direction, author, agent_id, body, type, status, created_at
       ) VALUES ($1, $2, $3, 'outbound', 'agent', $4, 'Ya validé tu línea, todo se encuentra en orden.', 'text', 'delivered', $5)`,
      [randomUUID(), convId, caseId, opts.agentId, agentMsgDate]
    );
  }
}

main().catch((err) => {
  console.error("Error en seed:", err);
  process.exit(1);
});
