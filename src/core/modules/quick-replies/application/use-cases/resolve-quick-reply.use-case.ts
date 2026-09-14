import type { QuickReplyCatalogService } from "../services/quick-reply-catalog.service";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { CustomerRepositoryPort } from "../../../customers/application/ports/customer.repository.port";
import type { QuickReply } from "../../domain/quick-reply.entity";
import type { Agent } from "../../../departments/domain/agent.entity";
import { notFound, validationError } from "../../../../../shared/errors/domain-errors";

export interface ResolveQuickReplyDeps {
  catalogService: QuickReplyCatalogService;
  conversationRepo?: ConversationRepositoryPort;
  customerRepo?: CustomerRepositoryPort;
}

export interface ResolveQuickReplyInput {
  shortcut: string;
  departmentId?: string | null;
  conversationId?: string;
  actor: Agent;
}

export interface ResolveQuickReplyResult {
  quickReply: QuickReply;
  interpolatedBody: string;
  contextUsed: Record<string, string>;
}

export class ResolveQuickReplyUseCase {
  constructor(private readonly deps: ResolveQuickReplyDeps) {}

  async execute(input: ResolveQuickReplyInput): Promise<ResolveQuickReplyResult> {
    const rawShortcut = input.shortcut?.trim();
    if (!rawShortcut) {
      throw validationError("El atajo (shortcut) es requerido");
    }

    const quickReply = await this.deps.catalogService.resolve(rawShortcut, input.departmentId);
    if (!quickReply || !quickReply.active) {
      throw notFound(`No se encontró ninguna respuesta rápida activa para el atajo "${rawShortcut}"`);
    }

    const context: Record<string, string> = {
      agent_name: input.actor.name,
      agent_email: input.actor.email,
    };

    if (input.conversationId && this.deps.conversationRepo) {
      const conversation = await this.deps.conversationRepo.findById(input.conversationId);
      if (conversation) {
        context.customer_phone = conversation.waPhone;
        if (conversation.waProfileName) {
          context.customer_name = conversation.waProfileName;
        }

        if (conversation.customerId && this.deps.customerRepo) {
          const customer = await this.deps.customerRepo.findById(conversation.customerId);
          if (customer) {
            if (customer.fullName) {
              context.customer_name = customer.fullName;
            }
            if (customer.nationalId) {
              context.national_id = customer.nationalId;
            }
          }
        }
      }
    }

    // Sinónimos comunes para interpolación amigable
    if (context.customer_name) {
      context.nombre = context.customer_name;
      context.name = context.customer_name;
      context.cliente = context.customer_name;
    }
    if (context.national_id) {
      context.cedula = context.national_id;
    }
    if (context.customer_phone) {
      context.telefono = context.customer_phone;
      context.phone = context.customer_phone;
    }
    if (context.agent_name) {
      context.asesor = context.agent_name;
      context.agente = context.agent_name;
    }

    const interpolatedBody = this.deps.catalogService.interpolate(quickReply.body, context);

    return {
      quickReply,
      interpolatedBody,
      contextUsed: context,
    };
  }
}
