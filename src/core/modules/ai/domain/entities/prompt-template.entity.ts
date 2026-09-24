export interface PromptVariableDefinition {
  key: string;
  label: string;
  description: string;
  placeholder?: string;
  example?: string;
  required?: boolean;
}

export interface PromptTemplate {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  departmentId?: string | null;
  allowedVariables: string[];
  variableDefinitions?: PromptVariableDefinition[];
  activeVersionId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
