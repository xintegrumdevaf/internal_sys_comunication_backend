import type { Department } from "../../domain/department.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";

export const GENERAL_FALLBACK_SLUGS = [
  "general",
  "atencion",
  "atencion-al-cliente",
  "recepcion",
];

/**
 * Resuelve el departamento General activo como destino por defecto para cualquier
 * caso o escalación que no pudo ser clasificada automáticamente, evitando que
 * quede estancado sin área asignada en el pool de triage.
 */
export async function resolveGeneralDepartment(
  departmentRepo: DepartmentRepositoryPort,
): Promise<Department | null> {
  for (const slug of GENERAL_FALLBACK_SLUGS) {
    const dept = await departmentRepo.findBySlug(slug);
    if (dept && dept.active !== false) {
      return dept;
    }
  }

  try {
    const allDepts = await departmentRepo.list();
    const match = allDepts.find((d) => {
      if (d.active === false) return false;
      const normSlug = d.slug.toLowerCase();
      const normName = d.name.toLowerCase();
      return (
        normSlug === "general" ||
        normName === "general" ||
        normSlug.includes("general") ||
        normName.includes("general") ||
        normSlug.includes("atencion") ||
        normSlug.includes("recepcion")
      );
    });
    return match ?? null;
  } catch {
    return null;
  }
}
