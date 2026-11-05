export type DepartmentVisibility = "shared" | "restricted";

export interface Department {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  /**
   * 'shared' (default): cualquier agente autenticado puede VER (lectura) casos
   * de este departamento. 'restricted': solo agentes con agent_membership en
   * este departamento (docs/spec/01_DATA_MODEL.md §7).
   */
  visibility: DepartmentVisibility;
  active: boolean;
  /**
   * Cupo máximo de casos concurrentes en HUMAN_ACTIVE por agente en este departamento (default: 6).
   * Al alcanzar este límite, el agente no recibe más casos automáticos hasta que libere cupos.
   */
  maxConcurrentCases: number;
  createdAt: Date;
}
