export interface GeneralInquiryContext {
  question?: string;
  answer?: string;
  found?: boolean;
  confidenceScore?: number;
  sources?: string[];
  retrievedChunks?: Array<{
    id: string;
    sourceName: string;
    contentSnippet: string;
    similarityScore: number;
    section?: string;
  }>;
  escalationReason?: string;
  /** true cuando el intent original era sales.upgrade — activa el paso de confirmación con especialista */
  wantsUpgrade?: boolean;
  /** departmentId para acotar la consulta RAG a los documentos de ese departamento si aplica */
  departmentId?: string | null;
}
