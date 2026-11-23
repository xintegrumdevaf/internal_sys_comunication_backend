import type { Pool } from "pg";
import type {
  AnalyticsCaseAttentionMode,
  AnalyticsCaseItemDto,
  AnalyticsCustomerAgentSummary,
  AnalyticsCustomerCaseBrief,
  AnalyticsCustomerItemDto,
  AnalyticsExportEstimateDto,
  AnalyticsParticipatingAgent,
  DepartmentSummaryItemDto,
  PaginatedAnalyticsCasesDto,
  PaginatedAnalyticsCustomersDto,
} from "../../domain/analytics.types";
import type {
  AnalyticsCasesQueryFilter,
  AnalyticsCustomersQueryFilter,
  AnalyticsFilter,
} from "../../application/ports/analytics.repository.port";

const UUID_REGEX_SQL = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

function toIso(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function toIsoOrNull(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return toIso(val);
}

export async function queryDepartmentsSummary(
  pool: Pool,
  filter: AnalyticsFilter,
  maxCapacityThreshold: number,
): Promise<DepartmentSummaryItemDto[]> {
  const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
    ? filter.departmentIds
    : null;

  const query = `
    WITH scoped_depts AS (
      SELECT d.id, d.name, COALESCE(d.max_concurrent_cases, $4)::int AS max_per_agent
      FROM department d
      WHERE d.active = true
        AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[]))
    ),
    period_cases AS (
      SELECT
        COALESCE(c.department_id, (SELECT e.department_id FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at ASC LIMIT 1)) AS dept_id,
        c.id,
        c.status,
        COALESCE(conv.customer_id::text, conv.wa_phone) AS customer_key,
        EXISTS (SELECT 1 FROM escalation e WHERE e.case_id = c.id) AS was_escalated,
        EXISTS (SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'agent') AS had_human_agent
      FROM "case" c
      JOIN conversation conv ON conv.id = c.conversation_id
      WHERE c.created_at >= $1 AND c.created_at <= $2
        AND ($3::uuid[] IS NULL OR COALESCE(c.department_id, (SELECT e.department_id FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at ASC LIMIT 1)) = ANY($3::uuid[]))
    ),
    period_agg AS (
      SELECT
        dept_id,
        COUNT(*)::int AS total_cases,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_cases,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND NOT was_escalated AND NOT had_human_agent)::int AS bot_completed_cases,
        COUNT(*) FILTER (WHERE was_escalated)::int AS escalated_cases,
        COUNT(DISTINCT customer_key)::int AS unique_customers_count
      FROM period_cases
      WHERE dept_id IS NOT NULL
      GROUP BY dept_id
    ),
    live_agg AS (
      SELECT
        COALESCE(c.department_id, (SELECT e.department_id FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at ASC LIMIT 1)) AS dept_id,
        COUNT(*) FILTER (WHERE c.status IN ('NEW', 'ACTIVE', 'WAITING_USER', 'PAUSED', 'ESCALATED', 'HUMAN_ACTIVE'))::int AS active_cases,
        COUNT(*) FILTER (WHERE c.status = 'ESCALATED' AND c.assigned_agent_id IS NULL)::int AS unassigned_cases,
        COUNT(*) FILTER (WHERE c.status IN ('ESCALATED', 'HUMAN_ACTIVE') AND c.assigned_agent_id IS NOT NULL)::int AS active_human_cases
      FROM "case" c
      WHERE c.status IN ('NEW', 'ACTIVE', 'WAITING_USER', 'PAUSED', 'ESCALATED', 'HUMAN_ACTIVE')
      GROUP BY 1
    ),
    agent_agg AS (
      SELECT
        a.primary_department_id AS dept_id,
        COUNT(*)::int AS total_agents_count,
        COUNT(*) FILTER (WHERE a.auto_assign_enabled = true)::int AS on_shift_agents_count
      FROM agent a
      WHERE a.active = true AND a.primary_department_id IS NOT NULL
      GROUP BY a.primary_department_id
    )
    SELECT
      sd.id AS department_id,
      sd.name AS department_name,
      sd.max_per_agent,
      COALESCE(pa.total_cases, 0)::int AS total_cases,
      COALESCE(la.active_cases, 0)::int AS active_cases,
      COALESCE(pa.completed_cases, 0)::int AS completed_cases,
      COALESCE(pa.bot_completed_cases, 0)::int AS bot_completed_cases,
      COALESCE(pa.escalated_cases, 0)::int AS escalated_cases,
      COALESCE(la.unassigned_cases, 0)::int AS unassigned_cases,
      COALESCE(la.active_human_cases, 0)::int AS active_human_cases,
      COALESCE(pa.unique_customers_count, 0)::int AS unique_customers_count,
      COALESCE(aa.total_agents_count, 0)::int AS total_agents_count,
      COALESCE(aa.on_shift_agents_count, 0)::int AS on_shift_agents_count
    FROM scoped_depts sd
    LEFT JOIN period_agg pa ON pa.dept_id = sd.id
    LEFT JOIN live_agg la ON la.dept_id = sd.id
    LEFT JOIN agent_agg aa ON aa.dept_id = sd.id
    ORDER BY total_cases DESC, sd.name ASC;
  `;

  const { rows } = await pool.query(query, [
    filter.from,
    filter.to,
    scopedDept,
    maxCapacityThreshold,
  ]);

  return rows.map((r) => {
    const totalCases = Number(r.total_cases ?? 0);
    const completedCases = Number(r.completed_cases ?? 0);
    const botCompletedCases = Number(r.bot_completed_cases ?? 0);
    const escalatedCases = Number(r.escalated_cases ?? 0);
    const onShiftAgentsCount = Number(r.on_shift_agents_count ?? 0);
    const maxPerAgent = Number(r.max_per_agent ?? maxCapacityThreshold);
    const maxCapacity = onShiftAgentsCount * maxPerAgent;
    const activeHumanCases = Number(r.active_human_cases ?? 0);
    const saturationPct = maxCapacity > 0
      ? Math.min(Math.round((activeHumanCases / maxCapacity) * 100), 100)
      : activeHumanCases > 0
        ? 100
        : 0;

    return {
      departmentId: String(r.department_id),
      departmentName: String(r.department_name),
      totalCases,
      activeCases: Number(r.active_cases ?? 0),
      completedCases,
      botContainmentRate: completedCases > 0
        ? Math.round((botCompletedCases / completedCases) * 1000) / 10
        : 0,
      escalationRate: totalCases > 0
        ? Math.round((escalatedCases / totalCases) * 1000) / 10
        : 0,
      unassignedCases: Number(r.unassigned_cases ?? 0),
      uniqueCustomersCount: Number(r.unique_customers_count ?? 0),
      totalAgentsCount: Number(r.total_agents_count ?? 0),
      onShiftAgentsCount,
      maxCapacity,
      saturationPct,
    };
  });
}

export async function queryAttendedCases(
  pool: Pool,
  filter: AnalyticsCasesQueryFilter,
): Promise<PaginatedAnalyticsCasesDto> {
  const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
    ? filter.departmentIds
    : null;
  const page = Math.max(1, filter.page);
  const pageSize = Math.min(Math.max(1, filter.pageSize), 1000);
  const offset = (page - 1) * pageSize;
  const searchPattern = filter.search?.trim() ? `%${filter.search.trim()}%` : null;

  const query = `
    WITH base_cases AS (
      SELECT
        c.id AS case_id,
        c.conversation_id,
        c.created_at,
        c.updated_at,
        CASE
          WHEN c.status = 'COMPLETED' THEN COALESCE(
            CASE WHEN c.context->>'closedAt' IS NOT NULL THEN (c.context->>'closedAt')::timestamptz END,
            c.updated_at
          )
          ELSE NULL
        END AS closed_at,
        c.status,
        c.workflow_type,
        COALESCE(
          (SELECT e.reason FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at DESC LIMIT 1),
          NULLIF(TRIM(c.context->>'escalationReason'), ''),
          NULLIF(TRIM(c.context->>'closeReason'), '')
        ) AS reason,
        COALESCE(
          c.department_id,
          (SELECT e.department_id FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at ASC LIMIT 1)
        ) AS effective_dept_id,
        COALESCE(conv.customer_id::text, conv.wa_phone) AS customer_key,
        conv.customer_id,
        COALESCE(
          NULLIF(TRIM(cust.full_name), ''),
          NULLIF(TRIM(conv.wa_profile_name), ''),
          conv.wa_phone
        ) AS customer_name,
        conv.wa_phone,
        cust.national_id,
        c.assigned_agent_id AS owner_agent_id,
        COALESCE(
          CASE WHEN c.context->>'closedByAgentId' ~ ${UUID_REGEX_SQL} THEN (c.context->>'closedByAgentId')::uuid END,
          CASE WHEN c.status = 'COMPLETED' THEN c.assigned_agent_id END
        ) AS closed_by_agent_id,
        EXISTS (SELECT 1 FROM escalation e WHERE e.case_id = c.id) AS was_escalated,
        EXISTS (SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'agent') AS had_human_msg,
        EXISTS (SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'ai') AS had_ai_msg,
        (SELECT COUNT(*)::int FROM workflow_event we WHERE we.case_id = c.id AND we.type = 'CASE_TRANSFERRED') AS transfer_events_count
      FROM "case" c
      JOIN conversation conv ON conv.id = c.conversation_id
      LEFT JOIN customer cust ON cust.id = conv.customer_id
      WHERE c.created_at >= $1 AND c.created_at <= $2
        AND ($3::uuid[] IS NULL OR COALESCE(
          c.department_id,
          (SELECT e.department_id FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at ASC LIMIT 1)
        ) = ANY($3::uuid[]))
    ),
    case_participants AS (
      SELECT
        raw.case_id,
        raw.agent_id,
        MIN(raw.touched_at) AS first_touched_at
      FROM (
        SELECT bc.case_id, bc.owner_agent_id AS agent_id, bc.updated_at AS touched_at
        FROM base_cases bc WHERE bc.owner_agent_id IS NOT NULL
        UNION ALL
        SELECT bc.case_id, bc.closed_by_agent_id AS agent_id, COALESCE(bc.closed_at, bc.updated_at) AS touched_at
        FROM base_cases bc WHERE bc.closed_by_agent_id IS NOT NULL
        UNION ALL
        SELECT m.case_id, m.agent_id, m.created_at AS touched_at
        FROM message m
        JOIN base_cases bc ON bc.case_id = m.case_id
        WHERE m.author = 'agent' AND m.agent_id IS NOT NULL
        UNION ALL
        SELECT we.case_id,
               COALESCE(
                 CASE WHEN we.payload->>'agentUserId' ~ ${UUID_REGEX_SQL} THEN (we.payload->>'agentUserId')::uuid END,
                 CASE WHEN we.payload->>'assignedAgentId' ~ ${UUID_REGEX_SQL} THEN (we.payload->>'assignedAgentId')::uuid END,
                 CASE WHEN we.payload->>'fromAgentId' ~ ${UUID_REGEX_SQL} THEN (we.payload->>'fromAgentId')::uuid END
               ) AS agent_id,
               we.occurred_at AS touched_at
        FROM workflow_event we
        JOIN base_cases bc ON bc.case_id = we.case_id
        WHERE we.type IN ('HUMAN_ASSIGNED', 'CASE_ASSIGNED', 'CASE_CLAIMED', 'CASE_TRANSFERRED', 'CASE_COMPLETED')
      ) raw
      WHERE raw.agent_id IS NOT NULL
      GROUP BY raw.case_id, raw.agent_id
    ),
    participants_json AS (
      SELECT
        cp.case_id,
        jsonb_agg(
          jsonb_build_object('agentId', cp.agent_id, 'agentName', a.name)
          ORDER BY cp.first_touched_at ASC, a.name ASC
        ) AS participating_agents,
        array_agg(cp.agent_id) AS participating_agent_ids,
        COUNT(*)::int AS participants_count
      FROM case_participants cp
      JOIN agent a ON a.id = cp.agent_id
      GROUP BY cp.case_id
    ),
    enriched AS (
      SELECT
        bc.*,
        COALESCE(d.name, 'General / Sin Área') AS department_name,
        owner_ag.name AS owner_agent_name,
        closer_ag.name AS closed_by_agent_name,
        COALESCE(pj.participating_agents, '[]'::jsonb) AS participating_agents,
        COALESCE(pj.participating_agent_ids, ARRAY[]::uuid[]) AS participating_agent_ids,
        GREATEST(bc.transfer_events_count, GREATEST(0, COALESCE(pj.participants_count, 0) - 1))::int AS handoff_count,
        CASE
          WHEN NOT bc.was_escalated AND NOT bc.had_human_msg AND bc.owner_agent_id IS NULL THEN 'AI_ONLY'
          WHEN bc.had_ai_msg THEN 'AI_AND_HUMAN'
          ELSE 'HUMAN_DIRECT'
        END AS attention_mode
      FROM base_cases bc
      LEFT JOIN department d ON d.id = bc.effective_dept_id
      LEFT JOIN agent owner_ag ON owner_ag.id = bc.owner_agent_id
      LEFT JOIN agent closer_ag ON closer_ag.id = bc.closed_by_agent_id
      LEFT JOIN participants_json pj ON pj.case_id = bc.case_id
    ),
    filtered AS (
      SELECT *
      FROM enriched e
      WHERE ($4::uuid IS NULL OR $4::uuid = ANY(e.participating_agent_ids) OR e.owner_agent_id = $4::uuid OR e.closed_by_agent_id = $4::uuid)
        AND ($5::text IS NULL OR e.status = $5::text)
        AND ($6::text IS NULL OR e.attention_mode = $6::text)
        AND (
          $7::text IS NULL
          OR e.customer_name ILIKE $7::text
          OR e.wa_phone ILIKE $7::text
          OR COALESCE(e.national_id, '') ILIKE $7::text
          OR COALESCE(e.reason, '') ILIKE $7::text
          OR e.workflow_type ILIKE $7::text
          OR e.case_id::text ILIKE $7::text
        )
    )
    SELECT
      f.*,
      COUNT(*) OVER()::int AS total_count
    FROM filtered f
    ORDER BY f.created_at DESC
    LIMIT $8 OFFSET $9;
  `;

  const { rows } = await pool.query(query, [
    filter.from,
    filter.to,
    scopedDept,
    filter.agentId ?? null,
    filter.status ?? null,
    filter.attentionMode ?? null,
    searchPattern,
    pageSize,
    offset,
  ]);

  const total = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;
  const items: AnalyticsCaseItemDto[] = rows.map((r) => ({
    caseId: String(r.case_id),
    conversationId: String(r.conversation_id),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    closedAt: toIsoOrNull(r.closed_at),
    status: String(r.status),
    workflowType: String(r.workflow_type),
    reason: r.reason ? String(r.reason) : null,
    departmentId: r.effective_dept_id ? String(r.effective_dept_id) : null,
    departmentName: String(r.department_name),
    customerKey: String(r.customer_key),
    customerId: r.customer_id ? String(r.customer_id) : null,
    customerName: String(r.customer_name),
    waPhone: String(r.wa_phone),
    nationalId: r.national_id ? String(r.national_id) : null,
    attentionMode: r.attention_mode as AnalyticsCaseAttentionMode,
    ownerAgentId: r.owner_agent_id ? String(r.owner_agent_id) : null,
    ownerAgentName: r.owner_agent_name ? String(r.owner_agent_name) : null,
    closedByAgentId: r.closed_by_agent_id ? String(r.closed_by_agent_id) : null,
    closedByAgentName: r.closed_by_agent_name ? String(r.closed_by_agent_name) : null,
    participatingAgents: Array.isArray(r.participating_agents)
      ? (r.participating_agents as AnalyticsParticipatingAgent[])
      : [],
    handoffCount: Number(r.handoff_count ?? 0),
  }));

  return { items, total, page, pageSize };
}

export async function queryAttendedCustomers(
  pool: Pool,
  filter: AnalyticsCustomersQueryFilter,
): Promise<PaginatedAnalyticsCustomersDto> {
  const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
    ? filter.departmentIds
    : null;
  const page = Math.max(1, filter.page);
  const pageSize = Math.min(Math.max(1, filter.pageSize), 1000);
  const offset = (page - 1) * pageSize;
  const searchPattern = filter.search?.trim() ? `%${filter.search.trim()}%` : null;

  const query = `
    WITH base_cases AS (
      SELECT
        c.id AS case_id,
        c.conversation_id,
        c.created_at,
        c.updated_at,
        c.status,
        c.workflow_type,
        COALESCE(
          (SELECT e.reason FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at DESC LIMIT 1),
          NULLIF(TRIM(c.context->>'escalationReason'), ''),
          NULLIF(TRIM(c.context->>'closeReason'), '')
        ) AS reason,
        COALESCE(
          c.department_id,
          (SELECT e.department_id FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at ASC LIMIT 1)
        ) AS effective_dept_id,
        COALESCE(conv.customer_id::text, conv.wa_phone) AS customer_key,
        conv.customer_id,
        COALESCE(
          NULLIF(TRIM(cust.full_name), ''),
          NULLIF(TRIM(conv.wa_profile_name), ''),
          conv.wa_phone
        ) AS customer_name,
        conv.wa_phone,
        cust.national_id,
        c.assigned_agent_id AS owner_agent_id,
        COALESCE(
          CASE WHEN c.context->>'closedByAgentId' ~ ${UUID_REGEX_SQL} THEN (c.context->>'closedByAgentId')::uuid END,
          c.assigned_agent_id
        ) AS effective_last_agent_id
      FROM "case" c
      JOIN conversation conv ON conv.id = c.conversation_id
      LEFT JOIN customer cust ON cust.id = conv.customer_id
      WHERE c.created_at >= $1 AND c.created_at <= $2
        AND ($3::uuid[] IS NULL OR COALESCE(
          c.department_id,
          (SELECT e.department_id FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at ASC LIMIT 1)
        ) = ANY($3::uuid[]))
    ),
    case_participants AS (
      SELECT DISTINCT
        raw.case_id,
        raw.agent_id
      FROM (
        SELECT bc.case_id, bc.owner_agent_id AS agent_id FROM base_cases bc WHERE bc.owner_agent_id IS NOT NULL
        UNION ALL
        SELECT bc.case_id, bc.effective_last_agent_id AS agent_id FROM base_cases bc WHERE bc.effective_last_agent_id IS NOT NULL
        UNION ALL
        SELECT m.case_id, m.agent_id
        FROM message m
        JOIN base_cases bc ON bc.case_id = m.case_id
        WHERE m.author = 'agent' AND m.agent_id IS NOT NULL
        UNION ALL
        SELECT we.case_id,
               COALESCE(
                 CASE WHEN we.payload->>'agentUserId' ~ ${UUID_REGEX_SQL} THEN (we.payload->>'agentUserId')::uuid END,
                 CASE WHEN we.payload->>'assignedAgentId' ~ ${UUID_REGEX_SQL} THEN (we.payload->>'assignedAgentId')::uuid END,
                 CASE WHEN we.payload->>'fromAgentId' ~ ${UUID_REGEX_SQL} THEN (we.payload->>'fromAgentId')::uuid END
               ) AS agent_id
        FROM workflow_event we
        JOIN base_cases bc ON bc.case_id = we.case_id
        WHERE we.type IN ('HUMAN_ASSIGNED', 'CASE_ASSIGNED', 'CASE_CLAIMED', 'CASE_TRANSFERRED', 'CASE_COMPLETED')
      ) raw
      WHERE raw.agent_id IS NOT NULL
    ),
    scoped_cases AS (
      SELECT
        bc.*,
        COALESCE(d.name, 'General / Sin Área') AS department_name,
        ag.name AS effective_last_agent_name,
        COALESCE(
          (
            SELECT array_agg(DISTINCT a.name ORDER BY a.name)
            FROM case_participants cp
            JOIN agent a ON a.id = cp.agent_id
            WHERE cp.case_id = bc.case_id
          ),
          ARRAY[]::text[]
        ) AS case_agent_names
      FROM base_cases bc
      LEFT JOIN department d ON d.id = bc.effective_dept_id
      LEFT JOIN agent ag ON ag.id = bc.effective_last_agent_id
      WHERE (
        $4::uuid IS NULL
        OR bc.owner_agent_id = $4::uuid
        OR bc.effective_last_agent_id = $4::uuid
        OR EXISTS (
          SELECT 1 FROM case_participants cp
          WHERE cp.case_id = bc.case_id AND cp.agent_id = $4::uuid
        )
      )
      AND (
        $5::text IS NULL
        OR bc.customer_name ILIKE $5::text
        OR bc.wa_phone ILIKE $5::text
        OR COALESCE(bc.national_id, '') ILIKE $5::text
      )
    ),
    customer_rollup AS (
      SELECT
        sc.customer_key,
        (array_agg(sc.customer_id ORDER BY sc.created_at DESC) FILTER (WHERE sc.customer_id IS NOT NULL))[1] AS customer_id,
        (array_agg(sc.customer_name ORDER BY sc.created_at DESC))[1] AS customer_name,
        (array_agg(sc.wa_phone ORDER BY sc.created_at DESC))[1] AS wa_phone,
        (array_agg(sc.national_id ORDER BY sc.created_at DESC) FILTER (WHERE sc.national_id IS NOT NULL))[1] AS national_id,
        array_agg(DISTINCT sc.department_name ORDER BY sc.department_name) AS department_names,
        COUNT(*)::int AS total_cases,
        COUNT(*) FILTER (WHERE sc.status = 'COMPLETED')::int AS completed_cases,
        COUNT(*) FILTER (WHERE sc.status IN ('NEW', 'ACTIVE', 'WAITING_USER', 'PAUSED', 'ESCALATED', 'HUMAN_ACTIVE'))::int AS active_cases,
        MAX(sc.created_at) AS last_case_at,
        (array_agg(sc.status ORDER BY sc.created_at DESC))[1] AS last_case_status,
        (array_agg(sc.workflow_type ORDER BY sc.created_at DESC))[1] AS last_case_workflow_type,
        (array_agg(sc.reason ORDER BY sc.created_at DESC))[1] AS last_case_reason,
        (array_agg(sc.conversation_id ORDER BY sc.created_at DESC))[1] AS last_conversation_id,
        (array_agg(sc.effective_last_agent_id ORDER BY sc.created_at DESC))[1] AS last_agent_id,
        (array_agg(sc.effective_last_agent_name ORDER BY sc.created_at DESC))[1] AS last_agent_name
      FROM scoped_cases sc
      GROUP BY sc.customer_key
    ),
    paged_customers AS (
      SELECT
        cr.*,
        COUNT(*) OVER()::int AS total_count
      FROM customer_rollup cr
      ORDER BY cr.last_case_at DESC, cr.total_cases DESC
      LIMIT $6 OFFSET $7
    ),
    customer_agents AS (
      SELECT
        sc.customer_key,
        jsonb_agg(
          jsonb_build_object(
            'agentId', agg.agent_id,
            'agentName', agg.agent_name,
            'casesCount', agg.cases_count
          )
          ORDER BY agg.cases_count DESC, agg.agent_name ASC
        ) AS participating_agents,
        COUNT(*)::int AS distinct_agents_count
      FROM (
        SELECT
          sc2.customer_key,
          cp.agent_id,
          a.name AS agent_name,
          COUNT(DISTINCT sc2.case_id)::int AS cases_count
        FROM scoped_cases sc2
        JOIN paged_customers pc ON pc.customer_key = sc2.customer_key
        JOIN case_participants cp ON cp.case_id = sc2.case_id
        JOIN agent a ON a.id = cp.agent_id
        GROUP BY sc2.customer_key, cp.agent_id, a.name
      ) agg
      JOIN paged_customers sc ON sc.customer_key = agg.customer_key
      GROUP BY sc.customer_key
    ),
    customer_recent_cases AS (
      SELECT
        ranked.customer_key,
        jsonb_agg(
          jsonb_build_object(
            'caseId', ranked.case_id,
            'conversationId', ranked.conversation_id,
            'createdAt', ranked.created_at,
            'status', ranked.status,
            'workflowType', ranked.workflow_type,
            'reason', ranked.reason,
            'departmentName', ranked.department_name,
            'ownerAgentName', ranked.effective_last_agent_name,
            'participatingAgents', ranked.case_agent_names
          )
          ORDER BY ranked.created_at DESC
        ) AS recent_cases
      FROM (
        SELECT
          sc2.*,
          ROW_NUMBER() OVER (PARTITION BY sc2.customer_key ORDER BY sc2.created_at DESC) AS rn
        FROM scoped_cases sc2
        JOIN paged_customers pc ON pc.customer_key = sc2.customer_key
      ) ranked
      WHERE ranked.rn <= 10
      GROUP BY ranked.customer_key
    )
    SELECT
      pc.*,
      COALESCE(ca.participating_agents, '[]'::jsonb) AS participating_agents,
      COALESCE(ca.distinct_agents_count, 0)::int AS distinct_agents_count,
      COALESCE(crc.recent_cases, '[]'::jsonb) AS recent_cases
    FROM paged_customers pc
    LEFT JOIN customer_agents ca ON ca.customer_key = pc.customer_key
    LEFT JOIN customer_recent_cases crc ON crc.customer_key = pc.customer_key
    ORDER BY pc.last_case_at DESC, pc.total_cases DESC;
  `;

  const { rows } = await pool.query(query, [
    filter.from,
    filter.to,
    scopedDept,
    filter.agentId ?? null,
    searchPattern,
    pageSize,
    offset,
  ]);

  const total = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;
  const items: AnalyticsCustomerItemDto[] = rows.map((r) => ({
    customerKey: String(r.customer_key),
    customerId: r.customer_id ? String(r.customer_id) : null,
    customerName: String(r.customer_name),
    waPhone: String(r.wa_phone),
    nationalId: r.national_id ? String(r.national_id) : null,
    departmentNames: Array.isArray(r.department_names) ? (r.department_names as string[]) : [],
    totalCases: Number(r.total_cases ?? 0),
    completedCases: Number(r.completed_cases ?? 0),
    activeCases: Number(r.active_cases ?? 0),
    lastCaseAt: toIso(r.last_case_at),
    lastCaseStatus: String(r.last_case_status),
    lastCaseWorkflowType: String(r.last_case_workflow_type),
    lastCaseReason: r.last_case_reason ? String(r.last_case_reason) : null,
    lastConversationId: String(r.last_conversation_id),
    lastAgentId: r.last_agent_id ? String(r.last_agent_id) : null,
    lastAgentName: r.last_agent_name ? String(r.last_agent_name) : null,
    participatingAgents: Array.isArray(r.participating_agents)
      ? (r.participating_agents as AnalyticsCustomerAgentSummary[])
      : [],
    distinctAgentsCount: Number(r.distinct_agents_count ?? 0),
    recentCases: Array.isArray(r.recent_cases)
      ? (r.recent_cases as AnalyticsCustomerCaseBrief[])
      : [],
  }));

  return { items, total, page, pageSize };
}

export async function queryExportEstimate(
  pool: Pool,
  filter: AnalyticsFilter & { agentId?: string },
  maxRowsPerSheet: number,
): Promise<AnalyticsExportEstimateDto> {
  const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
    ? filter.departmentIds
    : null;

  const query = `
    WITH scoped_cases AS (
      SELECT
        c.id AS case_id,
        COALESCE(conv.customer_id::text, conv.wa_phone) AS customer_key,
        c.assigned_agent_id
      FROM "case" c
      JOIN conversation conv ON conv.id = c.conversation_id
      WHERE c.created_at >= $1 AND c.created_at <= $2
        AND ($3::uuid[] IS NULL OR COALESCE(
          c.department_id,
          (SELECT e.department_id FROM escalation e WHERE e.case_id = c.id ORDER BY e.created_at ASC LIMIT 1)
        ) = ANY($3::uuid[]))
        AND (
          $4::uuid IS NULL
          OR c.assigned_agent_id = $4::uuid
          OR EXISTS (
            SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'agent' AND m.agent_id = $4::uuid
          )
          OR EXISTS (
            SELECT 1 FROM workflow_event we
            WHERE we.case_id = c.id
              AND we.type IN ('HUMAN_ASSIGNED', 'CASE_ASSIGNED', 'CASE_CLAIMED', 'CASE_TRANSFERRED', 'CASE_COMPLETED')
              AND (
                we.payload->>'agentUserId' = $4::text
                OR we.payload->>'assignedAgentId' = $4::text
                OR we.payload->>'fromAgentId' = $4::text
              )
          )
        )
    )
    SELECT
      COUNT(*)::int AS total_cases,
      COUNT(DISTINCT customer_key)::int AS unique_customers,
      (
        SELECT COUNT(*)::int FROM agent a
        WHERE a.active = true
          AND (
            $3::uuid[] IS NULL
            OR a.primary_department_id = ANY($3::uuid[])
            OR EXISTS (SELECT 1 FROM agent_membership am WHERE am.agent_id = a.id AND am.department_id = ANY($3::uuid[]))
          )
      ) AS agents_count,
      (
        SELECT COUNT(*)::int FROM department d
        WHERE d.active = true AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[]))
      ) AS departments_count
    FROM scoped_cases;
  `;

  const { rows } = await pool.query(query, [
    filter.from,
    filter.to,
    scopedDept,
    filter.agentId ?? null,
  ]);
  const r = rows[0] ?? {};
  const totalCases = Number(r.total_cases ?? 0);
  const uniqueCustomers = Number(r.unique_customers ?? 0);

  return {
    totalCases,
    uniqueCustomers,
    agentsCount: Number(r.agents_count ?? 0),
    departmentsCount: Number(r.departments_count ?? 0),
    maxRowsPerSheet,
    exceedsLimit: totalCases > maxRowsPerSheet || uniqueCustomers > maxRowsPerSheet,
  };
}
