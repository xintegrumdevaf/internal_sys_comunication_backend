import { describe, expect, it, vi } from "vitest";
import {
  CampaignRecipientRepositoryFake,
  CampaignRepositoryFake,
} from "../../infrastructure/postgres/campaign.repository.pg";
import { CampaignQueueFake } from "../../infrastructure/queue/campaign-worker.service";
import { CampaignFileParserService } from "../services/campaign-file-parser.service";
import { CreateCampaignUseCase } from "./create-campaign.use-case";
import { ImportCampaignRecipientsUseCase } from "./import-campaign-recipients.use-case";
import { StartCampaignUseCase } from "./start-campaign.use-case";
import { ProcessCampaignBatchUseCase } from "./process-campaign-batch.use-case";
import { SuspendCampaignUseCase } from "./suspend-campaign.use-case";
import { ResumeCampaignUseCase } from "./resume-campaign.use-case";
import { DeleteCampaignUseCase } from "./delete-campaign.use-case";
import { ListCampaignsUseCase } from "./list-campaigns.use-case";
import { GetCampaignUseCase } from "./get-campaign.use-case";
import type { WhatsAppSenderPort } from "../../../conversations/application/ports/whatsapp-sender.port";
import type { Logger } from "../../../../../shared/logging/logger";
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

  it("ProcessCampaignBatchUseCase interpola variables y envía via WhatsAppSenderPort", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi.fn().mockResolvedValue({ externalId: "wa-msg-123" }),
      sendTemplate: vi.fn().mockResolvedValue({ externalId: "wa-tpl-123" }),
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

  it("ProcessCampaignBatchUseCase maneja fallos individuales sin detener el lote", async () => {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();

    const mockSender: WhatsAppSenderPort = {
      sendText: vi
        .fn()
        .mockRejectedValueOnce(new Error("Error Meta API"))
        .mockResolvedValueOnce({ externalId: "wa-msg-456" }),
      sendTemplate: vi.fn().mockResolvedValue({ externalId: "wa-tpl-456" }),
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

    await expect(deleteUseCase.execute(running.id)).rejects.toThrow("solo se pueden eliminar");
  });
});
