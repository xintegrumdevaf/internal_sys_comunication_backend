import type { Pool } from "pg";
import type {
  AgentPerformanceDto,
  AIEfficiencyDto,
  AnalyticsOverviewDto,
  CasesDistributionDto,
  InfrastructureAlertDto,
} from "../../domain/analytics.types";
import type {
  AnalyticsFilter,
  AnalyticsRepositoryPort,
} from "../../application/ports/analytics.repository.port";

export class AnalyticsRepositoryPg implements AnalyticsRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async getOverview(filter: AnalyticsFilter): Promise<AnalyticsOverviewDto> {
    const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
      ? filter.departmentIds
      : null;

    const query = `
      WITH scoped_cases AS (
        SELECT c.id,
               c.status,
               c.created_at,
               c.updated_at,
               c.department_id,
               EXISTS (
                 SELECT 1 FROM escalation e WHERE e.case_id = c.id
               ) AS was_escalated,
               EXISTS (
                 SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'agent'
               ) AS had_human_agent
        FROM "case" c
        WHERE c.created_at >= $1 AND c.created_at <= $2
          AND ($3::uuid[] IS NULL OR c.department_id = ANY($3::uuid[]))
      ),
      queue_waits AS (
        SELECT EXTRACT(EPOCH FROM (
                 COALESCE(
                   (SELECT MIN(we.occurred_at) FROM workflow_event we
                    WHERE we.case_id = e.case_id AND we.type IN ('CASE_CLAIMED', 'CASE_ASSIGNED', 'HUMAN_ACTIVE')),
                   e.resolved_at,
                   now()
                 ) - e.created_at
               )) AS wait_sec
        FROM escalation e
        JOIN "case" c ON c.id = e.case_id
        WHERE e.created_at >= $1 AND e.created_at <= $2
          AND ($3::uuid[] IS NULL OR e.department_id = ANY($3::uuid[]))
      )
      SELECT
        COUNT(*)::int AS total_cases,
        COUNT(*) FILTER (WHERE status IN ('NEW', 'ACTIVE', 'WAITING_USER', 'PAUSED', 'ESCALATED', 'HUMAN_ACTIVE'))::int AS active_cases,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_cases,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND NOT was_escalated AND NOT had_human_agent)::int AS bot_completed_cases,
        COUNT(*) FILTER (WHERE was_escalated)::int AS escalated_cases,
        AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (WHERE status = 'COMPLETED')::float AS avg_resolution_minutes,
        (SELECT AVG(wait_sec)::float FROM queue_waits WHERE wait_sec >= 0) AS avg_queue_wait_sec
      FROM scoped_cases;
    `;

    const { rows } = await this.pool.query(query, [filter.from, filter.to, scopedDept]);
    const r = rows[0] ?? {};

    const totalCases = Number(r.total_cases ?? 0);
    const activeCases = Number(r.active_cases ?? 0);
    const completedCases = Number(r.completed_cases ?? 0);
    const botCompletedCases = Number(r.bot_completed_cases ?? 0);
    const escalatedCases = Number(r.escalated_cases ?? 0);

    const botContainmentRate = completedCases > 0
      ? Math.round((botCompletedCases / completedCases) * 1000) / 10
      : 0;

    const escalationRate = totalCases > 0
      ? Math.round((escalatedCases / totalCases) * 1000) / 10
      : 0;

    const avgResolutionTimeMinutes = r.avg_resolution_minutes !== null && r.avg_resolution_minutes !== undefined
      ? Math.round(Number(r.avg_resolution_minutes) * 10) / 10
      : null;

    const avgQueueWaitTimeSeconds = r.avg_queue_wait_sec !== null && r.avg_queue_wait_sec !== undefined
      ? Math.round(Number(r.avg_queue_wait_sec))
      : null;

    return {
      totalCases,
      activeCases,
      completedCases,
      botContainmentRate,
      avgResolutionTimeMinutes,
      avgQueueWaitTimeSeconds,
      escalationRate,
    };
  }

  async getCasesDistribution(filter: AnalyticsFilter): Promise<CasesDistributionDto> {
    const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
      ? filter.departmentIds
      : null;

    // 1. By Workflow
    const workflowQuery = `
      SELECT c.workflow_type, COUNT(*)::int AS count
      FROM "case" c
      WHERE c.created_at >= $1 AND c.created_at <= $2
        AND ($3::uuid[] IS NULL OR c.department_id = ANY($3::uuid[]))
      GROUP BY c.workflow_type
      ORDER BY count DESC;
    `;
    const workflowResult = await this.pool.query(workflowQuery, [filter.from, filter.to, scopedDept]);

    // 2. By Final Status
    const statusQuery = `
      SELECT c.status, COUNT(*)::int AS count
      FROM "case" c
      WHERE c.created_at >= $1 AND c.created_at <= $2
        AND ($3::uuid[] IS NULL OR c.department_id = ANY($3::uuid[]))
      GROUP BY c.status
      ORDER BY count DESC;
    `;
    const statusResult = await this.pool.query(statusQuery, [filter.from, filter.to, scopedDept]);

    // 3. Top Escalation Reasons
    const reasonsQuery = `
      SELECT e.reason, COUNT(*)::int AS count
      FROM escalation e
      JOIN "case" c ON c.id = e.case_id
      WHERE e.created_at >= $1 AND e.created_at <= $2
        AND ($3::uuid[] IS NULL OR e.department_id = ANY($3::uuid[]))
      GROUP BY e.reason
      ORDER BY count DESC
      LIMIT 5;
    `;
    const reasonsResult = await this.pool.query(reasonsQuery, [filter.from, filter.to, scopedDept]);

    const totalCases = statusResult.rows.reduce((acc, row) => acc + Number(row.count), 0);
    const totalEscalations = reasonsResult.rows.reduce((acc, row) => acc + Number(row.count), 0);

    return {
      totalCases,
      byWorkflow: workflowResult.rows.map((row) => ({
        workflowType: row.workflow_type || "TRIAGE",
        count: Number(row.count),
        percentage: totalCases > 0 ? Math.round((Number(row.count) / totalCases) * 1000) / 10 : 0,
      })),
      byFinalStatus: statusResult.rows.map((row) => ({
        status: row.status,
        count: Number(row.count),
        percentage: totalCases > 0 ? Math.round((Number(row.count) / totalCases) * 1000) / 10 : 0,
      })),
      topEscalationReasons: reasonsResult.rows.map((row) => ({
        reason: row.reason,
        count: Number(row.count),
        percentage: totalEscalations > 0 ? Math.round((Number(row.count) / totalEscalations) * 1000) / 10 : 0,
      })),
    };
  }

  async getAIEfficiency(filter: AnalyticsFilter): Promise<AIEfficiencyDto> {
    const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
      ? filter.departmentIds
      : null;

    const baseQuery = `
      WITH scoped_cases AS (
        SELECT c.id,
               c.status,
               c.created_at,
               c.updated_at,
               c.department_id,
               EXISTS (
                 SELECT 1 FROM escalation e WHERE e.case_id = c.id
               ) AS was_escalated,
               EXISTS (
                 SELECT 1 FROM message m WHERE m.case_id = c.id AND m.author = 'agent'
               ) AS had_human_agent
        FROM "case" c
        WHERE c.created_at >= $1 AND c.created_at <= $2
          AND ($3::uuid[] IS NULL OR c.department_id = ANY($3::uuid[]))
      )
      SELECT
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_cases,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND NOT was_escalated AND NOT had_human_agent)::int AS bot_completed_cases,
        COUNT(*) FILTER (WHERE was_escalated OR had_human_agent)::int AS human_escalated_cases
      FROM scoped_cases;
    `;
    const baseResult = await this.pool.query(baseQuery, [filter.from, filter.to, scopedDept]);
    const r = baseResult.rows[0] ?? {};

    const completedCases = Number(r.completed_cases ?? 0);
    const botCompletedCases = Number(r.bot_completed_cases ?? 0);
    const humanEscalatedCases = Number(r.human_escalated_cases ?? 0);

    const overallContainmentRate = completedCases > 0
      ? Math.round((botCompletedCases / completedCases) * 1000) / 10
      : 0;

    // Drop-off / Fricción por estado del workflow
    const dropOffQuery = `
      SELECT wi.workflow_type,
             wi.current_state AS state,
             COUNT(*)::int AS drop_count
      FROM workflow_instance wi
      JOIN "case" c ON c.id = wi.case_id
      WHERE c.created_at >= $1 AND c.created_at <= $2
        AND ($3::uuid[] IS NULL OR c.department_id = ANY($3::uuid[]))
        AND (
          EXISTS (SELECT 1 FROM escalation e WHERE e.case_id = c.id)
          OR c.status IN ('EXPIRED', 'CANCELLED')
        )
      GROUP BY wi.workflow_type, wi.current_state
      ORDER BY drop_count DESC
      LIMIT 10;
    `;
    const dropOffResult = await this.pool.query(dropOffQuery, [filter.from, filter.to, scopedDept]);
    const totalDropOff = dropOffResult.rows.reduce((acc, row) => acc + Number(row.drop_count), 0);

    // Conteo de casos derivados a triage por falta de entendimiento
    const triageQuery = `
      SELECT COUNT(*)::int AS count
      FROM escalation e
      JOIN "case" c ON c.id = e.case_id
      WHERE e.created_at >= $1 AND e.created_at <= $2
        AND ($3::uuid[] IS NULL OR e.department_id = ANY($3::uuid[]))
        AND (e.department_id IS NULL OR e.reason ILIKE '%unclear%' OR e.reason ILIKE '%unsupported%');
    `;
    const triageResult = await this.pool.query(triageQuery, [filter.from, filter.to, scopedDept]);
    const unclearTriageCount = Number(triageResult.rows[0]?.count ?? 0);

    return {
      overallContainmentRate,
      botCompletedCases,
      humanEscalatedCases,
      funnelDropOff: dropOffResult.rows.map((row) => ({
        workflowType: row.workflow_type,
        state: row.state,
        dropOffCount: Number(row.drop_count),
        percentage: totalDropOff > 0 ? Math.round((Number(row.drop_count) / totalDropOff) * 1000) / 10 : 0,
      })),
      unclearTriageCount,
    };
  }

  async getAgentsPerformance(
    filter: AnalyticsFilter,
    maxCapacityThreshold: number,
  ): Promise<AgentPerformanceDto[]> {
    const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
      ? filter.departmentIds
      : null;

    const query = `
      WITH scoped_agents AS (
        SELECT a.id,
               a.name,
               a.role,
               a.primary_department_id,
               d.name AS department_name,
               a.auto_assign_enabled
        FROM agent a
        LEFT JOIN department d ON d.id = a.primary_department_id
        WHERE a.active = true
          AND (
            $3::uuid[] IS NULL
            OR a.primary_department_id = ANY($3::uuid[])
            OR EXISTS (
              SELECT 1 FROM agent_membership am
              WHERE am.agent_id = a.id AND am.department_id = ANY($3::uuid[])
            )
          )
      ),
      active_now AS (
        SELECT c.assigned_agent_id AS agent_id, COUNT(*)::int AS count
        FROM "case" c
        WHERE c.status IN ('ESCALATED', 'HUMAN_ACTIVE')
          AND c.assigned_agent_id IS NOT NULL
        GROUP BY c.assigned_agent_id
      ),
      assigned_counts AS (
        SELECT c.assigned_agent_id AS agent_id, COUNT(*)::int AS count
        FROM "case" c
        WHERE c.assigned_agent_id IS NOT NULL
          AND c.created_at >= $1 AND c.created_at <= $2
        GROUP BY c.assigned_agent_id
      ),
      completed_stats AS (
        SELECT c.assigned_agent_id AS agent_id,
               COUNT(*)::int AS cases_completed,
               AVG(EXTRACT(EPOCH FROM (c.updated_at - c.created_at)) / 60)::float AS avg_handling_minutes,
               -- FCR: Cuántos casos NO tuvieron reapertura en la misma conversación dentro de las 48h
               COUNT(*) FILTER (
                 WHERE NOT EXISTS (
                   SELECT 1 FROM "case" c2
                   WHERE c2.conversation_id = c.conversation_id
                     AND c2.id != c.id
                     AND c2.created_at > c.updated_at
                     AND c2.created_at <= c.updated_at + INTERVAL '48 hours'
                 )
               )::int AS fcr_resolved_cases
        FROM "case" c
        WHERE c.status = 'COMPLETED'
          AND c.assigned_agent_id IS NOT NULL
          AND c.updated_at >= $1 AND c.updated_at <= $2
        GROUP BY c.assigned_agent_id
      ),
      transferred_counts AS (
        SELECT (we.payload->>'fromAgentId')::uuid AS agent_id, COUNT(*)::int AS count
        FROM workflow_event we
        WHERE we.type = 'CASE_TRANSFERRED'
          AND we.occurred_at >= $1 AND we.occurred_at <= $2
          AND we.payload->>'fromAgentId' IS NOT NULL
        GROUP BY 1
      ),
      first_reply_stats AS (
        SELECT cc.assigned_agent_id AS agent_id,
               AVG(
                 EXTRACT(EPOCH FROM (
                   (SELECT MIN(m.created_at) FROM message m
                    WHERE (m.case_id = cc.id OR (m.conversation_id = cc.conversation_id AND m.agent_id = cc.assigned_agent_id))
                      AND m.author = 'agent')
                   -
                   COALESCE(
                     (SELECT MIN(we.occurred_at) FROM workflow_event we
                      WHERE we.case_id = cc.id
                        AND we.type IN ('CASE_ESCALATED', 'HUMAN_ACTIVE', 'CASE_CLAIMED', 'CASE_ASSIGNED')),
                     cc.created_at
                   )
                 )) * 1000
               ) FILTER (WHERE cc.assigned_agent_id IS NOT NULL)::float AS avg_reply_ms
        FROM "case" cc
        WHERE cc.status = 'COMPLETED'
          AND cc.assigned_agent_id IS NOT NULL
          AND cc.updated_at >= $1 AND cc.updated_at <= $2
        GROUP BY cc.assigned_agent_id
      ),
      quality_stats AS (
        SELECT qr.agent_id,
               AVG(qr.cordiality_score) FILTER (WHERE qr.status IN ('ready', 'reviewed'))::float AS avg_score,
               COUNT(qf.id) FILTER (WHERE qf.severity = 'high')::int AS critical_alerts_count,
               COUNT(qcn.id) FILTER (WHERE qcn.ack_status = 'open')::int AS open_notes_count
        FROM quality_review qr
        LEFT JOIN quality_finding qf ON qf.review_id = qr.id
        LEFT JOIN quality_coaching_note qcn ON qcn.review_id = qr.id
        WHERE qr.created_at >= $1 AND qr.created_at <= $2
        GROUP BY qr.agent_id
      )
      SELECT
        sa.id AS agent_id,
        sa.name AS agent_name,
        sa.role AS agent_role,
        sa.primary_department_id,
        sa.department_name,
        sa.auto_assign_enabled,
        COALESCE(an.count, 0)::int AS active_cases_now,
        COALESCE(ac.count, 0)::int AS cases_assigned,
        COALESCE(cs.cases_completed, 0)::int AS cases_completed,
        cs.avg_handling_minutes,
        cs.fcr_resolved_cases,
        COALESCE(tc.count, 0)::int AS cases_transferred,
        frs.avg_reply_ms,
        qs.avg_score AS avg_cordiality,
        COALESCE(qs.critical_alerts_count, 0)::int AS critical_alerts_count,
        COALESCE(qs.open_notes_count, 0)::int AS open_notes_count
      FROM scoped_agents sa
      LEFT JOIN active_now an ON an.agent_id = sa.id
      LEFT JOIN assigned_counts ac ON ac.agent_id = sa.id
      LEFT JOIN completed_stats cs ON cs.agent_id = sa.id
      LEFT JOIN transferred_counts tc ON tc.agent_id = sa.id
      LEFT JOIN first_reply_stats frs ON frs.agent_id = sa.id
      LEFT JOIN quality_stats qs ON qs.agent_id = sa.id
      ORDER BY sa.name ASC;
    `;

    const { rows } = await this.pool.query(query, [filter.from, filter.to, scopedDept]);

    return rows.map((r) => {
      const casesCompleted = Number(r.cases_completed ?? 0);
      const fcrResolved = r.fcr_resolved_cases !== null ? Number(r.fcr_resolved_cases) : 0;
      const fcrRatePercentage = casesCompleted > 0
        ? Math.round((fcrResolved / casesCompleted) * 1000) / 10
        : null;

      const avgFirstResponseTimeMs = r.avg_reply_ms !== null && r.avg_reply_ms >= 0
        ? Math.round(Number(r.avg_reply_ms))
        : null;

      const avgHandlingTimeMinutes = r.avg_handling_minutes !== null
        ? Math.round(Number(r.avg_handling_minutes) * 10) / 10
        : null;

      const avgCordialityScore = r.avg_cordiality !== null
        ? Math.round(Number(r.avg_cordiality))
        : null;

      return {
        agentId: r.agent_id,
        agentName: r.agent_name,
        primaryDepartmentId: r.primary_department_id ?? null,
        primaryDepartmentName: r.department_name ?? null,
        role: r.agent_role,
        autoAssignEnabled: Boolean(r.auto_assign_enabled),
        activeCasesNow: Number(r.active_cases_now ?? 0),
        maxCapacityThreshold,
        casesAssigned: Number(r.cases_assigned ?? 0),
        casesCompleted,
        casesTransferred: Number(r.cases_transferred ?? 0),
        avgFirstResponseTimeMs,
        avgHandlingTimeMinutes,
        fcrRatePercentage,
        avgCordialityScore,
        criticalAlertsCount: Number(r.critical_alerts_count ?? 0),
        openCoachingNotesCount: Number(r.open_notes_count ?? 0),
      };
    });
  }

  async getInfrastructureAlerts(filter: AnalyticsFilter): Promise<InfrastructureAlertDto[]> {
    const scopedDept = filter.departmentIds && filter.departmentIds.length > 0
      ? filter.departmentIds
      : null;

    const query = `
      SELECT
        COALESCE(
          c.context->'contract'->>'sector',
          ct.sector,
          'Sin Sector'
        ) AS sector,
        COALESCE(
          c.context->'contract'->>'oltName',
          ct.olt_name
        ) AS olt_name,
        COUNT(*)::int AS active_cases_count
      FROM "case" c
      JOIN conversation conv ON conv.id = c.conversation_id
      LEFT JOIN contract ct ON ct.customer_id = conv.customer_id
      WHERE c.status IN ('NEW', 'ACTIVE', 'WAITING_USER', 'PAUSED', 'ESCALATED', 'HUMAN_ACTIVE')
        AND c.created_at >= $1 AND c.created_at <= $2
        AND ($3::uuid[] IS NULL OR c.department_id = ANY($3::uuid[]))
      GROUP BY 1, 2
      HAVING COUNT(*) > 0
      ORDER BY active_cases_count DESC
      LIMIT 20;
    `;

    const { rows } = await this.pool.query(query, [filter.from, filter.to, scopedDept]);

    return rows.map((r) => {
      const activeCasesCount = Number(r.active_cases_count);
      return {
        sector: r.sector,
        oltName: r.olt_name ?? null,
        activeCasesCount,
        isHighVolumeAlert: activeCasesCount >= 3,
      };
    });
  }
}
