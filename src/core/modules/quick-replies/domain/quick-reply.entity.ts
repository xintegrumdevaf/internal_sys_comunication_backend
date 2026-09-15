export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  departmentId: string | null;
  category: string | null;
  mediaUrl: string | null;
  createdByAgentId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateQuickReplyDto {
  shortcut: string;
  title: string;
  body: string;
  departmentId?: string | null;
  category?: string | null;
  mediaUrl?: string | null;
}

export interface UpdateQuickReplyDto {
  shortcut?: string;
  title?: string;
  body?: string;
  departmentId?: string | null;
  category?: string | null;
  mediaUrl?: string | null;
  active?: boolean;
}

export interface QuickReplyFilter {
  departmentIds?: (string | null)[];
  activeOnly?: boolean;
  search?: string;
  category?: string;
}
