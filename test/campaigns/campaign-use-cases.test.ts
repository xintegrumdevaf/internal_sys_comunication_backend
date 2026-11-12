import { describe, expect, it, vi } from "vitest";
import {
  CampaignRecipientRepositoryFake,
  CampaignRepositoryFake,
} from "../../src/core/modules/campaigns/infrastructure/postgres/campaign.repository.pg";
import { MessageTemplateRepositoryFake } from "../support/message-template-fakes";
import { ConversationRepositoryFake, MessageRepositoryFake } from "../support/fakes";
import { CampaignQueueFake } from "../../src/core/modules/campaigns/infrastructure/queue/campaign-worker.service";
import { CampaignFileParserService } from "../../src/core/modules/campaigns/application/services/campaign-file-parser.service";
import { CreateCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/create-campaign.use-case";
import { ImportCampaignRecipientsUseCase } from "../../src/core/modules/campaigns/application/use-cases/import-campaign-recipients.use-case";
import { StartCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/start-campaign.use-case";
import { ProcessCampaignBatchUseCase } from "../../src/core/modules/campaigns/application/use-cases/process-campaign-batch.use-case";
import { SuspendCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/suspend-campaign.use-case";
import { ResumeCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/resume-campaign.use-case";
import { DeleteCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/delete-campaign.use-case";
import { ListCampaignsUseCase } from "../../src/core/modules/campaigns/application/use-cases/list-campaigns.use-case";
import { GetCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/get-campaign.use-case";
import type { WhatsAppSenderPort } from "../../src/core/modules/conversations/application/ports/whatsapp-sender.port";
import type { Logger } from "../../src/shared/logging/logger";
import * as XLSX from "xlsx";

const nullLogger: Logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => nullLogger,
} as unknown as Logger;

describe("Campaign Use Cases", () => {
  it("CreateCampaignUseCase crea una campaña en estado DRAFT", async () => {
    const repo = new CampaignRepositoryFake();
    const useCase = new CreateCampaignUseCase(repo);

    const campaign = await useCase.execute({
      name: "Oferta Fibra 300MB",
      messageBody: "Hola {{name}}, activa tu plan hoy!",
    });

    expect(campaign.id).toBeDefined();
    expect(campaign.name).toBe("Oferta Fibra 300MB");
    expect(campaign.status).toBe("DRAFT");
    expect(campaign.quickModeIntervalSeconds).toBe(45);
  });

  it("CreateCampaignUseCase auto-resuelve templateLanguage desde MessageTemplateRepository si el usuario no lo envió", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const templateRepo = new MessageTemplateRepositoryFake();

    await templateRepo.create({
      id: "tpl-1",
      name: "prueba_tres_de_plantilla",
      language: "es_EC",
      category: "MARKETING",
      status: "APPROVED",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Hola {{name}}",
      footerText: null,
      buttons: null,
      metaTemplateId: "1484414806784372",
      rejectedReason: null,
    });

    const useCase = new CreateCampaignUseCase(campaignRepo, templateRepo);

    const campaign = await useCase.execute({
      name: "Campaña prueba_tres",
      templateName: "prueba_tres_de_plantilla",
    });

    expect(campaign.templateName).toBe("prueba_tres_de_plantilla");
    expect(campaign.templateLanguage).toBe("es_EC");
  });

  it("CreateCampaignUseCase lanza error si el nombre excede 50 caracteres", async () => {
    const repo = new CampaignRepositoryFake();
    const useCase = new CreateCampaignUseCase(repo);

    await expect(
      useCase.execute({
        name: "A".repeat(51),
      }),
    ).rejects.toThrow("no puede exceder 50 caracteres");
  });

  it("ImportCampaignRecipientsUseCase importa destinatarios desde buffer xlsx", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();
    const parser = new CampaignFileParserService();

    const campaign = await campaignRepo.create({ name: "Campaña Test" });

    const rows = [
      { number: "+593991111111", name: "Juan" },
      { number: "+593992222222", name: "Ana" },
    ];
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });

    const importUseCase = new ImportCampaignRecipientsUseCase(
      campaignRepo,
      recipientRepo,
      parser,
    );
    const result = await importUseCase.execute(campaign.id, buffer);

    expect(result.summary.validCount).toBe(2);
    expect(result.summary.invalidCount).toBe(0);

    const updatedCampaign = await campaignRepo.findById(campaign.id);
    expect(updatedCampaign?.totalRecipients).toBe(2);
  });

  it("StartCampaignUseCase requiere destinatarios e inicia la campaña en RUNNING", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();
    const queue = new CampaignQueueFake();

    const campaign = await campaignRepo.create({ name: "Campaña para iniciar" });
    const startUseCase = new StartCampaignUseCase(campaignRepo, recipientRepo, queue);

    // Sin destinatarios debe fallar
    await expect(startUseCase.execute(campaign.id)).rejects.toThrow(
      "al menos un destinatario",
    );

    // Agregar destinatarios
    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593999999999", name: "Test" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);

    const started = await startUseCase.execute(campaign.id);
    expect(started.status).toBe("RUNNING");
    expect(started.startedAt).toBeDefined();
    expect(queue.enqueuedIds).toContain(campaign.id);
  });

  it("StartCampaignUseCase permite reenviar campañas en estado COMPLETED o FAILED reseteando destinatarios a PENDING", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();
    const queue = new CampaignQueueFake();

    const campaign = await campaignRepo.create({ name: "Campaña Reenviable" });
    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593999999999", name: "Test" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);
    await campaignRepo.updateStatus(campaign.id, "COMPLETED");

    // Marcar destinatario como SENT
    const recipients = await recipientRepo.listByCampaignId(campaign.id);
    await recipientRepo.updateStatus(recipients[0]!.id, "SENT", { externalId: "ext-1" });

    const startUseCase = new StartCampaignUseCase(campaignRepo, recipientRepo, queue);
    const restarted = await startUseCase.execute(campaign.id);

    expect(restarted.status).toBe("RUNNING");
    expect(queue.enqueuedIds).toContain(campaign.id);

    const resetRecipients = await recipientRepo.listByCampaignId(campaign.id);
    expect(resetRecipients[0]?.status).toBe("PENDING");
  });

  it("ProcessCampaignBatchUseCase interpola variables y envía via WhatsAppSenderPort", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn().mockResolvedValue({ externalId: "wa-msg-123" }),
      sendTemplate: vi.fn().mockResolvedValue({ externalId: "wa-template-123" }),
    };

    const campaign = await campaignRepo.create({
      name: "Promo Verano",
      messageBody: "Hola {{name}}, tu número es {{number}}",
      quickMode: false,
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593998887776", name: "Carlos" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
    );

    const result = await processBatch.execute(campaign.id);

    expect(result.finished).toBe(true);
    expect(result.processedCount).toBe(1);
    expect(mockSender.sendText).toHaveBeenCalledWith(
      "+593998887776",
      "Hola Carlos, tu número es +593998887776",
    );

    const recipients = await recipientRepo.listByCampaignId(campaign.id);
    expect(recipients[0]?.status).toBe("SENT");
    expect(recipients[0]?.externalId).toBe("wa-msg-123");

    const finalCampaign = await campaignRepo.findById(campaign.id);
    expect(finalCampaign?.status).toBe("COMPLETED");
    expect(finalCampaign?.sentCount).toBe(1);
  });

  it("ProcessCampaignBatchUseCase envía usando sendTemplate cuando la campaña especifica templateName", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn(),
      sendTemplate: vi.fn().mockResolvedValue({ externalId: "wa-template-789" }),
    };

    const campaign = await campaignRepo.create({
      name: "Promo plantilla oficial",
      templateName: "promo_fibra_300mb",
      templateLanguage: "es",
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593999918359", name: "Angel" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
    );

    const result = await processBatch.execute(campaign.id);

    expect(result.finished).toBe(true);
    expect(mockSender.sendTemplate).toHaveBeenCalledWith(
      "+593999918359",
      "promo_fibra_300mb",
      "es",
      ["Angel"],
    );

    const recipients = await recipientRepo.listByCampaignId(campaign.id);
    expect(recipients[0]?.status).toBe("SENT");
    expect(recipients[0]?.externalId).toBe("wa-template-789");
  });

  it("ProcessCampaignBatchUseCase envía [] como params cuando la plantilla de Meta no requiere variables (error 132000)", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();
    const templateRepo = new MessageTemplateRepositoryFake();

    await templateRepo.create({
      id: "tpl-sin-vars",
      name: "prueba_tres_de_plantilla",
      language: "es_EC",
      category: "MARKETING",
      status: "APPROVED",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Our in-house chefs have prepared some delicious food.",
      footerText: null,
      buttons: null,
      metaTemplateId: "1484414806784372",
      rejectedReason: null,
    });

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn(),
      sendTemplate: vi.fn().mockResolvedValue({ externalId: "wa-template-000" }),
    };

    const campaign = await campaignRepo.create({
      name: "Promo sin variables",
      templateName: "prueba_tres_de_plantilla",
      templateLanguage: "es_EC",
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593999918359", name: "Angel" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
      templateRepo,
    );

    const result = await processBatch.execute(campaign.id);

    expect(result.finished).toBe(true);
    expect(mockSender.sendTemplate).toHaveBeenCalledWith(
      "+593999918359",
      "prueba_tres_de_plantilla",
      "es_EC",
      [],
    );
  });

  it("ProcessCampaignBatchUseCase maneja fallos individuales sin detener el lote", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi
        .fn()
        .mockRejectedValueOnce(new Error("Error Meta API"))
        .mockResolvedValueOnce({ externalId: "wa-msg-456" }),
      sendTemplate: vi.fn(),
    };

    const campaign = await campaignRepo.create({
      name: "Promo Fallo Parcial",
      messageBody: "Mensaje {{name}}",
      quickMode: false,
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593991111111", name: "Falla" },
      { phone: "+593992222222", name: "Exito" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 2);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
    );

    const result = await processBatch.execute(campaign.id);

    expect(result.finished).toBe(true);
    expect(result.processedCount).toBe(2);

    const recipients = await recipientRepo.listByCampaignId(campaign.id);
    expect(recipients[0]?.status).toBe("FAILED");
    expect(recipients[0]?.errorMessage).toBe("Error Meta API");
    expect(recipients[1]?.status).toBe("SENT");

    const finalCampaign = await campaignRepo.findById(campaign.id);
    expect(finalCampaign?.status).toBe("COMPLETED");
    expect(finalCampaign?.sentCount).toBe(1);
    expect(finalCampaign?.failedCount).toBe(1);
  });

  it("SuspendCampaignUseCase y ResumeCampaignUseCase modifican el estado", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const queue = new CampaignQueueFake();

    const campaign = await campaignRepo.create({ name: "Campaña Suspendible" });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    const suspendUseCase = new SuspendCampaignUseCase(campaignRepo);
    const suspended = await suspendUseCase.execute(campaign.id);
    expect(suspended.status).toBe("SUSPENDED");

    const resumeUseCase = new ResumeCampaignUseCase(campaignRepo, queue);
    const resumed = await resumeUseCase.execute(campaign.id);
    expect(resumed.status).toBe("RUNNING");
    expect(queue.enqueuedIds).toContain(campaign.id);
  });

  it("DeleteCampaignUseCase solo elimina si la campaña está en DRAFT", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const deleteUseCase = new DeleteCampaignUseCase(campaignRepo);

    const draft = await campaignRepo.create({ name: "Eliminable" });
    const deleted = await deleteUseCase.execute(draft.id);
    expect(deleted).toBe(true);

    const running = await campaignRepo.create({ name: "No Eliminable" });
    await campaignRepo.updateStatus(running.id, "RUNNING");

    await expect(deleteUseCase.execute(running.id)).rejects.toThrow(/solo se pueden eliminar/i);
  });

  it("ProcessCampaignBatchUseCase resuelve parámetros de plantilla dinámicamente usando variableMapping y variables del Excel por destinatario", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();
    const templateRepo = new MessageTemplateRepositoryFake();

    await templateRepo.create({
      id: "tpl-var-1",
      name: "prueba_varible",
      language: "es_EC",
      category: "MARKETING",
      status: "APPROVED",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Hola buenos dias {{1}}, un gusto saludarte",
      footerText: null,
      buttons: null,
      metaTemplateId: "9876543210",
      rejectedReason: null,
    });

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn(),
      sendTemplate: vi.fn().mockResolvedValue({ externalId: "wa-template-var" }),
    };

    const campaign = await campaignRepo.create({
      name: "Campaña Mapeo CASH",
      templateName: "prueba_varible",
      templateLanguage: "es_EC",
      variableMapping: { "1": "Columna: CASH" },
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      {
        phone: "+593999183597",
        name: "A prueba 1",
        variables: { "Columna: CASH": "22", CASH: "22", NOMBRE: "A prueba 1" },
      },
      {
        phone: "+59390948957",
        name: "A prueba 2",
        variables: { "Columna: CASH": "23", CASH: "23", NOMBRE: "A prueba 2" },
      },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 2);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
      templateRepo,
    );

    const result = await processBatch.execute(campaign.id);

    expect(result.finished).toBe(true);
    expect(mockSender.sendTemplate).toHaveBeenNthCalledWith(
      1,
      "+593999183597",
      "prueba_varible",
      "es_EC",
      ["22"],
    );
    expect(mockSender.sendTemplate).toHaveBeenNthCalledWith(
      2,
      "+59390948957",
      "prueba_varible",
      "es_EC",
      ["23"],
    );
  });

  it("ProcessCampaignBatchUseCase usa la columna personalizada CASH como parámetro 1 por inferencia si variableMapping viene vacío", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();
    const templateRepo = new MessageTemplateRepositoryFake();

    await templateRepo.create({
      id: "tpl-var-2",
      name: "prueba_varible",
      language: "es_EC",
      category: "MARKETING",
      status: "APPROVED",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Hola buenos dias {{1}}, un gusto saludarte",
      footerText: null,
      buttons: null,
      metaTemplateId: "9876543211",
      rejectedReason: null,
    });

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn(),
      sendTemplate: vi.fn().mockResolvedValue({ externalId: "wa-template-infer" }),
    };

    const campaign = await campaignRepo.create({
      name: "Campaña Inferida CASH",
      templateName: "prueba_varible",
      templateLanguage: "es_EC",
      variableMapping: {},
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      {
        phone: "+593999183597",
        name: "A prueba 1",
        variables: { CASH: "22", NAME: "A prueba 1", NUMBER: "593999183597" },
      },
      {
        phone: "+59390948957",
        name: "A prueba 2",
        variables: { CASH: "23", NAME: "A prueba 2", NUMBER: "59390948957" },
      },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 2);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
      templateRepo,
    );

    const result = await processBatch.execute(campaign.id);

    expect(result.finished).toBe(true);
    expect(mockSender.sendTemplate).toHaveBeenNthCalledWith(
      1,
      "+593999183597",
      "prueba_varible",
      "es_EC",
      ["22"],
    );
    expect(mockSender.sendTemplate).toHaveBeenNthCalledWith(
      2,
      "+59390948957",
      "prueba_varible",
      "es_EC",
      ["23"],
    );
  });

  it("ProcessCampaignBatchUseCase programa reintento con backoff y mantiene PENDING ante fallos transitorios (HTTP 429)", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn(),
      sendTemplate: vi.fn().mockRejectedValue(new Error("WhatsApp sendTemplate fallo (429): Rate limit exceeded")),
    };

    const campaign = await campaignRepo.create({
      name: "Campaña transitoria",
      templateName: "promo_test",
      templateLanguage: "es",
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593999999999", name: "Carlos" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
    );

    const result = await processBatch.execute(campaign.id);

    // No debe finalizar la campaña porque el destinatario queda PENDING para reintento
    expect(result.finished).toBe(false);

    const recipients = await recipientRepo.listByCampaignId(campaign.id);
    expect(recipients[0]?.status).toBe("PENDING");
    expect(recipients[0]?.retryCount).toBe(1);
    expect(recipients[0]?.nextRetryAt).toBeInstanceOf(Date);
    expect(recipients[0]?.errorMessage).toContain("Reintento 1/3");

    // No incrementa contadores de fallidos
    const counts = await campaignRepo.findById(campaign.id);
    expect(counts?.failedCount).toBe(0);
  });

  it("ProcessCampaignBatchUseCase marca FAILED inmediatamente ante errores fatales no recuperables", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn(),
      sendTemplate: vi.fn().mockRejectedValue(new Error("Número de teléfono no registrado en WhatsApp (131026)")),
    };

    const campaign = await campaignRepo.create({
      name: "Campaña fatal",
      templateName: "promo_test",
      templateLanguage: "es",
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593999999999", name: "Carlos" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
    );

    const result = await processBatch.execute(campaign.id);

    // Campaña finaliza porque el destinatario pasó a FAILED
    expect(result.finished).toBe(true);

    const recipients = await recipientRepo.listByCampaignId(campaign.id);
    expect(recipients[0]?.status).toBe("FAILED");
    expect(recipients[0]?.retryCount).toBe(0);
    expect(recipients[0]?.nextRetryAt).toBeNull();

    // Incrementa contadores de fallidos
    const counts = await campaignRepo.findById(campaign.id);
    expect(counts?.failedCount).toBe(1);
  });

  it("ProcessCampaignBatchUseCase marca FAILED cuando se excede el máximo de reintentos (MAX_RECIPIENT_RETRIES = 3)", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn(),
      sendTemplate: vi.fn().mockRejectedValue(new Error("ETIMEDOUT: Connection timed out")),
    };

    const campaign = await campaignRepo.create({
      name: "Campaña max retries",
      templateName: "promo_test",
      templateLanguage: "es",
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593999999999", name: "Carlos" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);

    // Simulamos que ya se reintentó 3 veces
    const [recipient] = await recipientRepo.listByCampaignId(campaign.id);
    await recipientRepo.updateStatus(recipient!.id, "PENDING", {
      retryCount: 3,
      nextRetryAt: new Date(Date.now() - 1000), // Ya listo para procesar
    });

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
    );

    const result = await processBatch.execute(campaign.id);

    expect(result.finished).toBe(true);

    const recipients = await recipientRepo.listByCampaignId(campaign.id);
    expect(recipients[0]?.status).toBe("FAILED");
    expect(recipients[0]?.retryCount).toBe(3);

    const counts = await campaignRepo.findById(campaign.id);
    expect(counts?.failedCount).toBe(1);
  });

  it("ListCampaignsUseCase y GetCampaignUseCase calculan progreso considerando enviados + fallidos (100% al terminar)", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const campaign = await campaignRepo.create({
      name: "Campaña Mixta",
      messageBody: "Hola",
    });
    await campaignRepo.updateTotalRecipients(campaign.id, 4);
    // 1 enviado exitoso, 3 fallidos (como en el caso real)
    await campaignRepo.incrementCounters(campaign.id, { sent: 1, failed: 3 });
    await campaignRepo.updateStatus(campaign.id, "COMPLETED");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593999999901", name: "User 1" },
      { phone: "+593999999902", name: "User 2" },
      { phone: "+593999999903", name: "User 3" },
      { phone: "+593999999904", name: "User 4" },
    ]);

    const checkMessageStatusMock = vi.fn();
    const mockSender = {
      sendText: vi.fn(),
      checkMessageStatus: checkMessageStatusMock,
    } as unknown as WhatsAppSenderPort;

    const listUseCase = new ListCampaignsUseCase(campaignRepo);
    const getUseCase = new GetCampaignUseCase(campaignRepo, recipientRepo, mockSender);

    const listResult = await listUseCase.execute();
    expect(listResult[0]?.progress).toBe(100);

    const getResult = await getUseCase.execute(campaign.id);
    expect(getResult?.progress).toBe(100);
    // Verifica que NO se invocó checkMessageStatus hacia servicios externos
    expect(checkMessageStatusMock).not.toHaveBeenCalled();
  });

  it("ProcessCampaignBatchUseCase aplica chatRouting.initialStatus = CLOSED enviando la conversación a cerrados", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn().mockResolvedValue({ externalId: "wamid-batch-routing-1" }),
      sendTemplate: vi.fn().mockResolvedValue({ externalId: "wamid-batch-routing-1" }),
    };

    const campaign = await campaignRepo.create({
      name: "Campaña con initialStatus CLOSED",
      messageBody: "Aviso de mantenimiento",
      chatRouting: {
        initialStatus: "CLOSED",
        departmentId: null,
        assignedAgentId: null,
        keepAssignedToUser: false,
        delegateToBot: true,
        forceChatUpdate: false,
      },
    });
    await campaignRepo.updateStatus(campaign.id, "RUNNING");

    await recipientRepo.bulkInsert(campaign.id, [
      { phone: "+593991234567", name: "Maria Cliente" },
    ]);
    await campaignRepo.updateTotalRecipients(campaign.id, 1);

    const processBatch = new ProcessCampaignBatchUseCase(
      campaignRepo,
      recipientRepo,
      mockSender,
      nullLogger,
      undefined,
      conversationRepo,
      messageRepo,
    );

    const result = await processBatch.execute(campaign.id);
    expect(result.finished).toBe(true);
    expect(result.processedCount).toBe(1);

    // Verificar que la conversación se creó y su status quedó en 'closed' (bandeja de cerrados)
    const conv = await conversationRepo.findByWaPhone("+593991234567");
    expect(conv).toBeDefined();
    expect(conv?.status).toBe("closed");
    expect(conv?.waProfileName).toBe("Maria Cliente");

    // Verificar que el mensaje saliente quedó insertado en el historial de la conversación
    expect(messageRepo.messages).toHaveLength(1);
    expect(messageRepo.messages[0]?.conversationId).toBe(conv?.id);
    expect(messageRepo.messages[0]?.direction).toBe("outbound");
    expect(messageRepo.messages[0]?.body).toBe("Aviso de mantenimiento");
    expect(messageRepo.messages[0]?.externalId).toBe("wamid-batch-routing-1");
  });
});
