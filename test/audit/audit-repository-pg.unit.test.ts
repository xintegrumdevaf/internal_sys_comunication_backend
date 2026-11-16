import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { AuditRepositoryPg } from "../../src/core/modules/audit/infrastructure/postgres/audit.repository.pg";

describe("AuditRepositoryPg (Unit Tests)", () => {
  it("getStats con filtro por departmentId genera SQL válido sin dobles WHERE", async () => {
    const executedQueries: Array<{ text: string; values?: unknown[] }> = [];

    const mockPool = {
      query: vi.fn().mockImplementation((queryText: string, values?: unknown[]) => {
        executedQueries.push({ text: queryText, values });
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;

    const repo = new AuditRepositoryPg(mockPool);
    const deptId = "11111111-2222-3333-4444-555555555555";

    const stats = await repo.getStats({ departmentId: deptId });

    expect(stats.totalEvents).toBe(0);
    expect(executedQueries.length).toBe(3);

    // Verificar que ninguna consulta SQL tenga doble WHERE (error sintáctico detectado anteriormente)
    for (const q of executedQueries) {
      const occurrences = (q.text.match(/\bWHERE\b/gi) || []).length;
      expect(occurrences).toBeLessThanOrEqual(1);
      // Debe incluir filtro por departmentId usando alias a. o COALESCE
      expect(q.text).toMatch(/COALESCE\(a\.department_id,\s*ag\.primary_department_id\)/);
      expect(q.values).toContain(deptId);
    }

    // La consulta de top actors debe tener actor_id IS NOT NULL combinado con AND
    const actorQuery = executedQueries[2]!;
    expect(actorQuery.text).toContain("a.actor_id IS NOT NULL");
    expect(actorQuery.text).toContain("AND");
  });

  it("list con filtro por departmentId incluye COALESCE y joins a departamentos", async () => {
    let capturedQuery = "";
    let capturedValues: unknown[] = [];

    const mockPool = {
      query: vi.fn().mockImplementation((queryText: string, values?: unknown[]) => {
        capturedQuery = queryText;
        capturedValues = values ?? [];
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;

    const repo = new AuditRepositoryPg(mockPool);
    const deptId = "11111111-2222-3333-4444-555555555555";

    await repo.list({ departmentId: deptId, limit: 10 });

    const whereMatches = (capturedQuery.match(/\bWHERE\b/gi) || []).length;
    expect(whereMatches).toBe(1);
    expect(capturedQuery).toContain("COALESCE(a.department_id, ag.primary_department_id) = $1");
    expect(capturedQuery).toContain("LEFT JOIN department ag_d ON ag_d.id = ag.primary_department_id");
    expect(capturedValues).toContain(deptId);
  });
});
