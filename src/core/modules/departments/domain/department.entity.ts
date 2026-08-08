export type DepartmentVisibility = "shared" | "restricted";

export interface Department {
  id: string;
  slug: string;
  name: string;
  /**
   * 'shared' (default): cualquier agente autenticado puede VER (lectura) casos
   * de este departamento. 'restricted': solo agentes con agent_membership en
   * este departamento (docs/spec/01_DATA_MODEL.md §7).
   */
  visibility: DepartmentVisibility;
  active: boolean;
  createdAt: Date;
}
