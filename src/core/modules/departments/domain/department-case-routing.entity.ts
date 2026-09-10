export type DepartmentHandlingMode = "ai_assisted" | "human_direct";

export interface DepartmentCaseRouting {
  id: string;
  departmentId: string;
  intentKey: string;
  label: string;
  description: string;
  handlingMode: DepartmentHandlingMode;
  workflowType: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
