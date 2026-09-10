import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import type {
  ZernioHistoricalConversation,
  ZernioHistoricalMessage,
} from "../../domain/zernio-history.types";
import type { ZernioHistoryPort } from "../../application/ports/zernio-history.port";

type RawConversation = {
  id: string;
  accountId: string;
  participantId?: string;
  participantName?: string;
  participantUsername?: string;
  lastMessage?: string;
  updatedTime?: string;
  unreadCount?: number;
};

type RawMessage = {
  id: string;
  conversationId: string;
  message?: string;
  direction?: "incoming" | "outgoing";
  senderId?: string;
  senderName?: string;
  senderPhoneNumber?: string;
  createdAt?: string;
  sentAt?: string;
  sentVia?: string;
  metadata?: { sentVia?: string };
  attachments?: Array<{
    type?: string;
    url?: string;
    mimeType?: string;
    filename?: string;
  }>;
};

export class ZernioHistoryGatewayHttp implements ZernioHistoryPort {
  private resolvedAccountId: string | null = null;
  private readonly baseUrl: string;

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {
    this.baseUrl = (this.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1").replace(/\/$/, "");
    if (this.env.ZERNIO_ACCOUNT_ID && /^[a-f\d]{24}$/i.test(this.env.ZERNIO_ACCOUNT_ID.trim())) {
      this.resolvedAccountId = this.env.ZERNIO_ACCOUNT_ID.trim();
    }
  }

  private async getAccountId(): Promise<string> {
    if (this.resolvedAccountId) {
      return this.resolvedAccountId;
    }

    const inputId = this.env.ZERNIO_ACCOUNT_ID?.trim();
    const url = `${this.baseUrl}/accounts`;

    const res = await this.fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error({ status: res.status, body: errText }, "Error al listar cuentas en Zernio");
      throw new Error(`Zernio accounts lookup fallo (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      accounts?: Array<{
        _id: string;
        platform: string;
        metadata?: { wabaId?: string; phoneNumberId?: string };
      }>;
    };

    const accounts = data.accounts || [];
    const matched = accounts.find(
      (a) =>
        a._id === inputId ||
        a.metadata?.wabaId === inputId ||
        a.metadata?.phoneNumberId === inputId ||
        a.platform === "whatsapp",
    );

    if (!matched) {
      throw new Error(
        `No se encontro ninguna cuenta de WhatsApp en Zernio para el identificador: ${inputId || "(vacio)"}`,
      );
    }

    this.resolvedAccountId = matched._id;
    return this.resolvedAccountId;
  }

  private async fetchWithRetry(url: string, init?: RequestInit, retries = 3): Promise<Response> {
    let attempt = 0;
    while (attempt < retries) {
      attempt++;
      try {
        const res = await fetch(url, init);
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            this.logger.warn({ status: res.status, attempt, delay }, "Reintentando llamada a Zernio API");
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }
        return res;
      } catch (err) {
        if (attempt >= retries) {
          throw err;
        }
        const delay = 1000 * attempt;
        this.logger.warn({ err, attempt, delay }, "Error de red al consultar Zernio, reintentando");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(`Fallo llamada a Zernio tras ${retries} intentos: ${url}`);
  }

  async fetchAllConversations(): Promise<ZernioHistoricalConversation[]> {
    const accountId = await this.getAccountId();
    const conversations: ZernioHistoricalConversation[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      let url = `${this.baseUrl}/inbox/conversations?accountId=${encodeURIComponent(accountId)}&limit=100`;
      if (cursor) {
        url += `&cursor=${encodeURIComponent(cursor)}`;
      }

      this.logger.debug({ url, cursor }, "Obteniendo pagina de conversaciones de Zernio");
      const res = await this.fetchWithRetry(url, {
        headers: {
          Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Error al listar conversaciones en Zernio (${res.status}): ${text}`);
      }

      const body = (await res.json()) as {
        data?: RawConversation[];
        pagination?: { hasMore?: boolean; nextCursor?: string };
      };

      const pageItems = body.data || [];
      for (const item of pageItems) {
        const phone = (item.participantId || item.participantUsername || "").replace(/\D/g, "");
        if (!phone) continue;

        conversations.push({
          id: item.id,
          participantId: phone,
          participantName: item.participantName || item.participantUsername || null,
          lastMessage: item.lastMessage || null,
          updatedTime: item.updatedTime || new Date().toISOString(),
          unreadCount: item.unreadCount || 0,
        });
      }

      hasMore = Boolean(body.pagination?.hasMore && body.pagination.nextCursor);
      cursor = body.pagination?.nextCursor || null;
    }

    this.logger.info({ totalConversations: conversations.length }, "Conversaciones recuperadas de Zernio");
    return conversations;
  }

  async fetchMessagesForConversation(zernioConversationId: string): Promise<ZernioHistoricalMessage[]> {
    const accountId = await this.getAccountId();
    const messages: ZernioHistoricalMessage[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      let url = `${this.baseUrl}/inbox/conversations/${encodeURIComponent(zernioConversationId)}/messages?accountId=${encodeURIComponent(accountId)}&limit=100`;
      if (cursor) {
        url += `&cursor=${encodeURIComponent(cursor)}`;
      }

      this.logger.debug({ zernioConversationId, cursor }, "Obteniendo pagina de mensajes de Zernio");
      const res = await this.fetchWithRetry(url, {
        headers: {
          Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Error al listar mensajes en Zernio (${res.status}): ${text}`);
      }

      const body = (await res.json()) as {
        messages?: RawMessage[];
        pagination?: { hasMore?: boolean; nextCursor?: string };
      };

      const pageItems = body.messages || [];
      for (const item of pageItems) {
        messages.push({
          id: item.id,
          conversationId: zernioConversationId,
          message: item.message || "",
          direction: item.direction === "outgoing" ? "outgoing" : "incoming",
          senderId: item.senderId || "",
          senderName: item.senderName || null,
          senderPhoneNumber: item.senderPhoneNumber || null,
          createdAt: item.createdAt || item.sentAt || new Date().toISOString(),
          sentVia: item.sentVia || item.metadata?.sentVia || null,
          attachments: item.attachments || [],
        });
      }

      hasMore = Boolean(body.pagination?.hasMore && body.pagination.nextCursor);
      cursor = body.pagination?.nextCursor || null;
    }

    // Ordenar cronológicamente (más antiguo primero) para inserción natural
    messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    this.logger.info(
      { zernioConversationId, messageCount: messages.length },
      "Mensajes de conversacion recuperados de Zernio",
    );
    return messages;
  }
}
