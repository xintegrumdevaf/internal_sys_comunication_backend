import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  CampaignRecipientRepositoryFake,
  CampaignRepositoryFake,
} from "../../src/core/modules/campaigns/infrastructure/postgres/campaign.repository.pg";
import { CampaignQueueFake } from "../../src/core/modules/campaigns/infrastructure/queue/campaign-worker.service";
import { CampaignFileParserService } from "../../src/core/modules/campaigns/application/services/campaign-file-parser.service";
import { CreateCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/create-campaign.use-case";
import { ImportCampaignRecipientsUseCase } from "../../src/core/modules/campaigns/application/use-cases/import-campaign-recipients.use-case";
import { StartCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/start-campaign.use-case";
import { SuspendCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/suspend-campaign.use-case";
import { ResumeCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/resume-campaign.use-case";
import { ListCampaignsUseCase } from "../../src/core/modules/campaigns/application/use-cases/list-campaigns.use-case";
import { GetCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/get-campaign.use-case";
import { DeleteCampaignUseCase } from "../../src/core/modules/campaigns/application/use-cases/delete-campaign.use-case";
import { createCampaignsRouter } from "../../src/core/modules/campaigns/presentation/campaigns.router";
import type { Agent } from "../../src/core/modules/departments/domain/agent.entity";

describe("Campaigns Router (Integration)", () => {
  function setupApp() {
    const campaignRepo = new CampaignRepositoryFake();
    const recipientRepo = new CampaignRecipientRepositoryFake();
    const queue = new CampaignQueueFake();
    const parser = new CampaignFileParserService();

    const createCampaign = new CreateCampaignUseCase(campaignRepo);
    const importRecipients = new ImportCampaignRecipientsUseCase(
      campaignRepo,
      recipientRepo,
      parser,
    );
    const startCampaign = new StartCampaignUseCase(campaignRepo, recipientRepo, queue);
    const suspendCampaign = new SuspendCampaignUseCase(campaignRepo);
    const resumeCampaign = new ResumeCampaignUseCase(campaignRepo, queue);
    const listCampaigns = new ListCampaignsUseCase(campaignRepo);
    const getCampaign = new GetCampaignUseCase(campaignRepo, recipientRepo);
    const deleteCampaign = new DeleteCampaignUseCase(campaignRepo);

    const router = createCampaignsRouter({
      createCampaign,
      importRecipients,
      startCampaign,
      suspendCampaign,
      resumeCampaign,
      listCampaigns,
      getCampaign,
      deleteCampaign,
    });

    const app = express();
    app.use(express.json());

    // Middleware de sesión autenticada para tests
    app.use((req, _res, next) => {
      (req as unknown as { agent: Partial<Agent> }).agent = {
        id: "agent-test-1",
        email: "admin@isp.com",
        name: "Admin",
        role: "admin",
        active: true,
      };
      next();
    });

    app.use(router);

    // Middleware de errores básico
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(400).json({ error: err.message });
    });

    return { app, campaignRepo, recipientRepo };
  }

  it("POST /api/campaigns y GET /api/campaigns responden con éxito", async () => {
    const { app } = setupApp();

    const createRes = await supertest(app)
      .post("/api/campaigns")
      .send({
        name: "Campaña Navideña",
        messageBody: "Feliz Navidad {{name}}",
        quickMode: true,
        quickModeIntervalSeconds: 30,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.name).toBe("Campaña Navideña");
    expect(createRes.body.data.status).toBe("DRAFT");
    const campaignId = createRes.body.data.id;

    const listRes = await supertest(app).get("/api/campaigns");
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].id).toBe(campaignId);
    expect(listRes.body.data[0].progress).toBe(0);
  });

  it("POST /api/campaigns/:id/recipients/import procesa multipart file upload", async () => {
    const { app, campaignRepo } = setupApp();

    const campaign = await campaignRepo.create({ name: "Campaña Importación" });

    const rows = [{ number: "+593998887776", name: "Cliente 1" }];
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    const fileBuffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });

    const importRes = await supertest(app)
      .post(`/api/campaigns/${campaign.id}/recipients/import`)
      .attach("file", fileBuffer, "contactos.xlsx");

    expect(importRes.status).toBe(200);
    expect(importRes.body.summary.validCount).toBe(1);
    expect(importRes.body.summary.totalProcessed).toBe(1);

    const getRes = await supertest(app).get(`/api/campaigns/${campaign.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.totalRecipients).toBe(1);
    expect(getRes.body.data.recipients).toHaveLength(1);
    expect(getRes.body.data.recipients[0].phone).toBe("+593998887776");
  });

  it("DELETE /api/campaigns/:id elimina campañas en estado DRAFT", async () => {
    const { app, campaignRepo } = setupApp();

    const campaign = await campaignRepo.create({ name: "Campaña a borrar" });
    const deleteRes = await supertest(app).delete(`/api/campaigns/${campaign.id}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    const getRes = await supertest(app).get(`/api/campaigns/${campaign.id}`);
    expect(getRes.status).toBe(404);
  });
});
