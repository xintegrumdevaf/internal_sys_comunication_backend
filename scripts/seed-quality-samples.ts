/**
 * Seed de muestras para supervisión de calidad (Etapa 10).
 *
 * Crea agentes de demo + conversaciones humano↔cliente con tonos variados
 * (cordial, agresivo, descuido, desinformación, ineficiente), casos COMPLETED
 * y mensajes con case_id/agent_id listos para analyzeAgentConversation.
 *
 * Uso:
 *   pnpm seed                 # base (admin / soporte) si aún no corriste
 *   pnpm seed:quality         # este script
 *   pnpm seed:quality -- --analyze   # además encola y espera el análisis Ollama
 *
 * Login extra:
 *   manager@isp.local / ChangeMe123!
 *   ana.cordial@isp.local / ChangeMe123!
 *   carlos.agresivo@isp.local / ChangeMe123!
 *   pedro.descuido@isp.local / ChangeMe123!
 *   lucia.errores@isp.local / ChangeMe123!
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { env } from "../src/shared/config/env";
import { createLogger } from "../src/shared/logging/logger";
import { hashPassword } from "../src/shared/security/password-hasher";
import { AgentRepositoryPg } from "../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";
import { DepartmentRepositoryPg } from "../src/core/modules/departments/infrastructure/postgres/department.repository.pg";
import { ConversationRepositoryPg } from "../src/core/modules/conversations/infrastructure/postgres/conversation.repository.pg";
import { MessageRepositoryPg } from "../src/core/modules/conversations/infrastructure/postgres/message.repository.pg";
import { CaseRepositoryPg } from "../src/core/modules/cases/infrastructure/postgres/case.repository.pg";
import { QualityReviewRepositoryPg } from "../src/core/modules/quality/infrastructure/postgres/quality-review.repository.pg";
import { RunQualityAnalysisUseCase } from "../src/core/modules/quality/application/use-cases/run-quality-analysis.use-case";
import { OllamaAdapter } from "../src/core/modules/ai/infrastructure/ollama/ollama-adapter";
import type { Agent } from "../src/core/modules/departments/domain/agent.entity";

const DEV_PASSWORD = "ChangeMe123!";
const PHONE_PREFIX = "+59399001"; // fijo → idempotente por escenario

type Turn = { author: "customer" | "agent"; body: string };

type Scenario = {
  key: string;
  phoneSuffix: string; // 01..05
  profileName: string;
  agentEmail: string;
  label: string;
  turns: Turn[];
};

const SCENARIOS: Scenario[] = [
  {
    key: "cordial",
    phoneSuffix: "01",
    profileName: "María Cliente (cordial)",
    agentEmail: "ana.cordial@isp.local",
    label: "Atención cordial / correcta",
    turns: [
      {
        author: "customer",
        body: "Buenas tardes, desde ayer no tengo internet en casa. ¿Me pueden ayudar?",
      },
      {
        author: "agent",
        body: "Buenas tardes, María. Con gusto te ayudo. ¿Me confirmas tu número de cédula para ubicar el contrato?",
      },
      { author: "customer", body: "Claro, es 1712345678." },
      {
        author: "agent",
        body: "Gracias. Ya veo tu servicio en el sector Norte. Voy a revisar el estado de la ONU y te cuento en un momento.",
      },
      {
        author: "customer",
        body: "Ok, espero.",
      },
      {
        author: "agent",
        body: "Listo: detectamos una caída en el nodo de tu zona. Ya quedó reportada y el restablecimiento estimado es en 1 a 2 horas. ¿Te parece si te escribo cuando vuelva la señal?",
      },
      {
        author: "customer",
        body: "Perfecto, muchas gracias.",
      },
      {
        author: "agent",
        body: "Con mucho gusto. Quedo atenta. Que tengas buena tarde.",
      },
    ],
  },
  {
    key: "agresivo",
    phoneSuffix: "02",
    profileName: "José Cliente (agresivo)",
    agentEmail: "carlos.agresivo@isp.local",
    label: "Atención agresiva / irrespetuosa",
    turns: [
      {
        author: "customer",
        body: "Oye, llevo 3 días sin internet y nadie me resuelve nada.",
      },
      {
        author: "agent",
        body: "Y a mí qué me importa tu drama. Si no pagas a tiempo no esperes milagros.",
      },
      {
        author: "customer",
        body: "¿Cómo así? Yo sí estoy al día. Quiero hablar con un supervisor.",
      },
      {
        author: "agent",
        body: "No seas pesado. El supervisor no va a perder el tiempo contigo. Revisa tu módem o llama a otro lado.",
      },
      {
        author: "customer",
        body: "Esto es un abuso. Voy a reclamar.",
      },
      {
        author: "agent",
        body: "Haz lo que quieras. Deja de escribir tonterías y no me hagas perder el tiempo.",
      },
    ],
  },
  {
    key: "descuido",
    phoneSuffix: "03",
    profileName: "Ana Cliente (descuido)",
    agentEmail: "pedro.descuido@isp.local",
    label: "Descuido / abandono de atención",
    turns: [
      {
        author: "customer",
        body: "Hola, necesito reactivar el servicio, me lo suspendieron por error.",
      },
      {
        author: "agent",
        body: "ok",
      },
      {
        author: "customer",
        body: "¿Ok? ¿Pueden reactivarlo hoy? Es urgente, trabajo desde casa.",
      },
      {
        author: "agent",
        body: "ya",
      },
      {
        author: "customer",
        body: "¿Me pueden confirmar el ticket o algún número de seguimiento?",
      },
      {
        author: "agent",
        body: "mmm no sé",
      },
      {
        author: "customer",
        body: "Llevo una hora esperando una respuesta clara…",
      },
      {
        author: "agent",
        body: "luego te digo",
      },
    ],
  },
  {
    key: "desinformacion",
    phoneSuffix: "04",
    profileName: "Luis Cliente (desinformación)",
    agentEmail: "lucia.errores@isp.local",
    label: "Desinformación / datos incorrectos",
    turns: [
      {
        author: "customer",
        body: "¿Cuánto debo este mes? Quiero pagar antes de que me corten.",
      },
      {
        author: "agent",
        body: "Debes $250 dólares exactos, vence mañana sí o sí o te cortamos el servicio.",
      },
      {
        author: "customer",
        body: "¿$250? En la app me sale $32.50…",
      },
      {
        author: "agent",
        body: "La app está mal. Confía en lo que te digo yo. Paga los $250 por transferencia a cualquier cuenta que encuentres en Google.",
      },
      {
        author: "customer",
        body: "Eso no me cuadra. ¿Pueden verificar bien?",
      },
      {
        author: "agent",
        body: "Ya te dije. Si no pagas $250 no hay internet. Así de simple.",
      },
    ],
  },
  {
    key: "ineficiente",
    phoneSuffix: "05",
    profileName: "Rosa Cliente (ineficiente)",
    agentEmail: "ana.cordial@isp.local", // mismo agente cordial, otro caso ineficiente
    label: "Ineficiencia (ida y vuelta / no resuelve)",
    turns: [
      {
        author: "customer",
        body: "Quiero cambiar el plan a 100 Mbps. ¿Qué necesito?",
      },
      {
        author: "agent",
        body: "¿Cuál es tu plan actual?",
      },
      { author: "customer", body: "El de 50 Mbps." },
      {
        author: "agent",
        body: "Ok. ¿Me pasas tu cédula?",
      },
      { author: "customer", body: "1711122233" },
      {
        author: "agent",
        body: "Espera… ¿me repites tu plan actual?",
      },
      { author: "customer", body: "50 Mbps, como te dije." },
      {
        author: "agent",
        body: "Ah sí. ¿Y tu cédula otra vez?",
      },
      { author: "customer", body: "1711122233. ¿Pueden hacer el cambio o no?" },
      {
        author: "agent",
        body: "Déjame preguntarte primero: ¿quieres 100 Mbps verdad? ¿Y me confirmas de nuevo el plan actual?",
      },
    ],
  },
];

async function ensureAgent(
  agentRepo: AgentRepositoryPg,
  input: {
    name: string;
    email: string;
    role: "agent" | "manager" | "admin";
    primaryDepartmentId: string | null;
    passwordHash: string;
  },
): Promise<Agent> {
  let agent = await agentRepo.create({
    name: input.name,
    email: input.email,
    role: input.role,
    primaryDepartmentId: input.primaryDepartmentId,
    passwordHash: input.passwordHash,
  });
  if (!agent.passwordHash) {
    agent = await agentRepo.update(agent.id, { passwordHash: input.passwordHash });
  }
  // Si ya existía con otro rol, alineamos rol/depto para demo.
  if (agent.role !== input.role || agent.primaryDepartmentId !== input.primaryDepartmentId) {
    agent = await agentRepo.update(agent.id, {
      role: input.role,
      primaryDepartmentId: input.primaryDepartmentId,
    });
  }
  return agent;
}

async function insertTurn(
  pool: Pool,
  messageRepo: MessageRepositoryPg,
  input: {
    conversationId: string;
    caseId: string;
    agentId: string;
    turn: Turn;
    index: number;
  },
): Promise<void> {
  const { conversationId, caseId, agentId, turn, index } = input;
  const externalId = `quality-seed-${caseId.slice(0, 8)}-${index}`;

  if (turn.author === "customer") {
    const { message } = await messageRepo.insertInbound({
      conversationId,
      externalId,
      body: turn.body,
      type: "text",
    });
    await pool.query(`UPDATE message SET case_id = $2 WHERE id = $1`, [message.id, caseId]);
    return;
  }

  const message = await messageRepo.insertOutbound({
    conversationId,
    author: "agent",
    body: turn.body,
    externalId,
    agentId,
    caseId,
  });
  // Por si el repo aún no persistió case_id en algún camino.
  await pool.query(`UPDATE message SET case_id = $2, agent_id = $3 WHERE id = $1`, [
    message.id,
    caseId,
    agentId,
  ]);
}

async function seedScenario(
  pool: Pool,
  deps: {
    conversationRepo: ConversationRepositoryPg;
    messageRepo: MessageRepositoryPg;
    caseRepo: CaseRepositoryPg;
    agentsByEmail: Map<string, Agent>;
    supportDepartmentId: string;
  },
  scenario: Scenario,
): Promise<{ caseId: string; conversationId: string; skipped: boolean }> {
  const phone = `${PHONE_PREFIX}${scenario.phoneSuffix}`;
  const agent = deps.agentsByEmail.get(scenario.agentEmail.toLowerCase());
  if (!agent) {
    throw new Error(`Agente no encontrado: ${scenario.agentEmail}`);
  }

  const existing = await deps.conversationRepo.findByWaPhone(phone);
  if (existing) {
    const cases = await deps.caseRepo.listByConversation(existing.id);
    const sample = cases.find((c) => c.workflowType === "SUPPORT_INTERNET" && c.status === "COMPLETED");
    if (sample) {
      console.log(`[seed:quality] skip ${scenario.key} (ya existe ${phone}) case=${sample.id}`);
      return { caseId: sample.id, conversationId: existing.id, skipped: true };
    }
  }

  const conversation = await deps.conversationRepo.findOrCreateByWaPhone(phone);
  await pool.query(`UPDATE conversation SET wa_profile_name = $2, status = 'closed', updated_at = now() WHERE id = $1`, [
    conversation.id,
    scenario.profileName,
  ]);

  const created = await deps.caseRepo.create({
    conversationId: conversation.id,
    workflowType: "SUPPORT_INTERNET",
    departmentId: deps.supportDepartmentId,
    context: {},
    initialState: "HUMAN_ACTIVE",
    expiresAt: null,
  });

  await deps.caseRepo.setAssignedAgent(created.case.id, agent.id);
  await deps.caseRepo.setAutomationEnabled(created.case.id, false, {
    reason: "QUALITY_SEED",
    changedBy: agent.id,
  });

  // Pasar a HUMAN_ACTIVE y luego COMPLETED (el create deja NEW).
  let aggregate = await deps.caseRepo.findById(created.case.id);
  if (!aggregate) throw new Error("caso recién creado no encontrado");

  aggregate = await deps.caseRepo.applyTransition({
    caseId: aggregate.case.id,
    expectedCaseVersion: aggregate.case.version,
    expectedWorkflowVersion: aggregate.workflowInstance.version,
    status: "HUMAN_ACTIVE",
    context: aggregate.case.context,
    currentState: "HUMAN_ACTIVE",
    expiresAt: null,
  });

  for (let i = 0; i < scenario.turns.length; i++) {
    await insertTurn(pool, deps.messageRepo, {
      conversationId: conversation.id,
      caseId: aggregate.case.id,
      agentId: agent.id,
      turn: scenario.turns[i]!,
      index: i,
    });
  }

  aggregate = (await deps.caseRepo.findById(aggregate.case.id))!;
  await deps.caseRepo.applyTransition({
    caseId: aggregate.case.id,
    expectedCaseVersion: aggregate.case.version,
    expectedWorkflowVersion: aggregate.workflowInstance.version,
    status: "COMPLETED",
    context: aggregate.case.context,
    currentState: "COMPLETED",
    expiresAt: null,
  });
  await deps.conversationRepo.setActiveCaseId(conversation.id, null);
  await deps.conversationRepo.touchLastActivity(conversation.id);

  console.log(
    `[seed:quality] ${scenario.key} → case=${aggregate.case.id} agent=${agent.email} (${scenario.label})`,
  );
  return { caseId: aggregate.case.id, conversationId: conversation.id, skipped: false };
}

async function run(): Promise<void> {
  const analyze = process.argv.includes("--analyze");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const departmentRepo = new DepartmentRepositoryPg(pool);
  const agentRepo = new AgentRepositoryPg(pool);
  const conversationRepo = new ConversationRepositoryPg(pool);
  const messageRepo = new MessageRepositoryPg(pool);
  const caseRepo = new CaseRepositoryPg(pool);
  const qualityRepo = new QualityReviewRepositoryPg(pool);
  const logger = createLogger(env);

  try {
    const support = await departmentRepo.create({ slug: "support", name: "Soporte tecnico" });
    await departmentRepo.create({ slug: "billing", name: "Facturacion" });
    await departmentRepo.create({ slug: "sales", name: "Ventas" });

    const passwordHash = await hashPassword(DEV_PASSWORD);

    const manager = await ensureAgent(agentRepo, {
      name: "Gerente de Soporte",
      email: "manager@isp.local",
      role: "manager",
      primaryDepartmentId: support.id,
      passwordHash,
    });
    await agentRepo.addMembership(manager.id, support.id);

    const ana = await ensureAgent(agentRepo, {
      name: "Ana Cordial",
      email: "ana.cordial@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      passwordHash,
    });
    const carlos = await ensureAgent(agentRepo, {
      name: "Carlos Agresivo",
      email: "carlos.agresivo@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      passwordHash,
    });
    const pedro = await ensureAgent(agentRepo, {
      name: "Pedro Descuido",
      email: "pedro.descuido@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      passwordHash,
    });
    const lucia = await ensureAgent(agentRepo, {
      name: "Lucía Errores",
      email: "lucia.errores@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      passwordHash,
    });

    for (const a of [ana, carlos, pedro, lucia]) {
      await agentRepo.addMembership(a.id, support.id);
    }

    const agentsByEmail = new Map<string, Agent>(
      [ana, carlos, pedro, lucia].map((a) => [a.email.toLowerCase(), a]),
    );

    const seededCaseIds: string[] = [];
    for (const scenario of SCENARIOS) {
      const result = await seedScenario(
        pool,
        {
          conversationRepo,
          messageRepo,
          caseRepo,
          agentsByEmail,
          supportDepartmentId: support.id,
        },
        scenario,
      );
      seededCaseIds.push(result.caseId);
    }

    console.log("[seed:quality] OK — muestras listas para /calidad");
    console.log(`[seed:quality] Login manager: manager@isp.local / ${DEV_PASSWORD}`);
    console.log(`[seed:quality] Login agentes demo: ana.cordial@ / carlos.agresivo@ / pedro.descuido@ / lucia.errores@ — ${DEV_PASSWORD}`);

    if (!analyze) {
      console.log(
        "[seed:quality] Tip: corre `pnpm seed:quality -- --analyze` con Ollama arriba para generar reviews automáticamente,",
      );
      console.log(
        "               o desde la UI (admin/manager) usa «Analizar de nuevo» / on-demand sobre cada caso.",
      );
      return;
    }

    const aiProvider = new OllamaAdapter(
      {
        baseUrl: env.OLLAMA_BASE_URL,
        model: env.OLLAMA_MODEL,
        timeoutMs: env.AI_CALL_TIMEOUT_MS,
        qualityTimeoutMs: env.AI_QUALITY_TIMEOUT_MS,
      },
      logger,
    );
    const runAnalysis = new RunQualityAnalysisUseCase({
      qualityRepo,
      messageRepo,
      aiProvider,
      logger,
    });

    console.log("[seed:quality] Encolando análisis IA (Ollama)...");
    for (const caseId of seededCaseIds) {
      const aggregate = await caseRepo.findById(caseId);
      if (!aggregate?.case.assignedAgentId) continue;

      const agentId = aggregate.case.assignedAgentId;
      const autoKey = `${aggregate.case.id}:${agentId}:auto`;
      let review = await qualityRepo.findByIdempotencyKey(autoKey);

      if (review && review.status !== "pending" && review.status !== "failed") {
        // Ya hay resultado; crear on_demand fresco para re-probar.
        review = await qualityRepo.createPending({
          conversationId: aggregate.case.conversationId,
          caseId: aggregate.case.id,
          agentId,
          departmentId: aggregate.case.departmentId,
          triggerKind: "on_demand",
          idempotencyKey: `${aggregate.case.id}:${agentId}:on_demand:${randomUUID()}`,
        });
      } else if (!review) {
        review = await qualityRepo.createPending({
          conversationId: aggregate.case.conversationId,
          caseId: aggregate.case.id,
          agentId,
          departmentId: aggregate.case.departmentId,
          triggerKind: "auto_case_closed",
          idempotencyKey: autoKey,
        });
      } else if (review.status === "failed") {
        // Reabrir como on_demand (auto key ya ocupada).
        review = await qualityRepo.createPending({
          conversationId: aggregate.case.conversationId,
          caseId: aggregate.case.id,
          agentId,
          departmentId: aggregate.case.departmentId,
          triggerKind: "on_demand",
          idempotencyKey: `${aggregate.case.id}:${agentId}:on_demand:${randomUUID()}`,
        });
      }

      // Solo await aquí — NO usar enqueue.scheduleRun (duplicaría la llamada a Ollama).
      console.log(
        `[seed:quality] analyze ${review.triggerKind} review=${review.id} case=${caseId}…`,
      );
      const detail = await runAnalysis.execute(review.id);
      const score = detail?.review.cordialityScore ?? null;
      console.log(
        `[seed:quality]   → status=${detail?.review.status ?? "?"} score=${score ?? "—"} findings=${detail?.findings.length ?? 0}`,
      );
    }
    console.log("[seed:quality] Análisis terminado — revisa /calidad en el frontend.");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("[seed:quality] fallo:", error);
  process.exit(1);
});
