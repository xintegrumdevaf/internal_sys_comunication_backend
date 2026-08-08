export interface Agent {
  id: string;
  name: string;
  email: string;
  isGlobalAdmin: boolean;
  primaryDepartmentId: string | null;
  active: boolean;
  createdAt: Date;
}
