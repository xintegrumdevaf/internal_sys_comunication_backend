import { describe, it, expect } from "vitest";
import { SearchConversationsUseCase } from "../../src/core/modules/conversations/application/use-cases/search-conversations.use-case";
import {
  ConversationRepositoryFake,
  MessageRepositoryFake,
  DepartmentRepositoryFake,
} from "../support/fakes";
import { CaseRepositoryFake } from "../cases/fakes";

describe("SearchConversationsUseCase", () => {
  it("encuentra conversaciones por texto en mensajes históricos o datos del cliente", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();
    const departmentRepo = new DepartmentRepositoryFake();

    const conv1 = conversationRepo.createOpen({
      id: "conv-1",
      waPhone: "+593986528447",
      customerName: "PEREZ SIGUA KEVIN EDURDO",
      waProfileName: "Kevin",
    });
    messageRepo.seedText(conv1.id, "Buenas tardes, se quemó la fuente del router");

    const conv2 = conversationRepo.createOpen({
      id: "conv-2",
      waPhone: "+593999999001",
      customerName: "CARLOS MENDOZA",
    });
    messageRepo.seedText(conv2.id, "Todo bien con el servicio");

    // Mock search method on fake
    conversationRepo.search = async (query: string) => {
      const q = query.toLowerCase();
      if ("perez sigua".includes(q) || "quemó la fuente".includes(q)) {
        return [
          {
            conversation: conv1,
            matchedMessage: {
              id: "msg-1",
              body: "Buenas tardes, se quemó la fuente del router",
              author: "customer",
              createdAt: new Date(),
            },
          },
        ];
      }
      return [];
    };

    const useCase = new SearchConversationsUseCase(
      conversationRepo,
      messageRepo,
      caseRepo,
      undefined,
      departmentRepo,
    );

    const results = await useCase.execute({ query: "quemó la fuente" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("conv-1");
    expect(results[0]?.matchedMessage?.body).toBe("Buenas tardes, se quemó la fuente del router");
  });

  it("retorna array vacío si el término de búsqueda está vacío", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const useCase = new SearchConversationsUseCase(conversationRepo, messageRepo);

    const results = await useCase.execute({ query: "   " });
    expect(results).toEqual([]);
  });
});
