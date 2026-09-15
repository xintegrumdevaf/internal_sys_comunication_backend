import { describe, expect, it } from "vitest";
import { CreateMessageTemplateUseCase } from "../../src/core/modules/message-templates/application/use-cases/create-message-template.use-case";
import { ListMessageTemplatesUseCase } from "../../src/core/modules/message-templates/application/use-cases/list-message-templates.use-case";
import { DeleteMessageTemplateUseCase } from "../../src/core/modules/message-templates/application/use-cases/delete-message-template.use-case";
import { SyncTemplateStatusUseCase } from "../../src/core/modules/message-templates/application/use-cases/sync-template-status.use-case";
import { SyncRemoteTemplatesUseCase } from "../../src/core/modules/message-templates/application/use-cases/sync-remote-templates.use-case";
import { RealtimeBroadcaster } from "../../src/core/modules/realtime/application/realtime-broadcaster";
import {
  MessageTemplateRepositoryFake,
  MetaTemplatesGatewayFake,
} from "../support/message-template-fakes";

describe("MessageTemplates Use Cases", () => {
  it("CreateMessageTemplateUseCase: valida nombre (regex ^[a-z0-9_]+$), longitud de body (<=1024), guarda en PENDING y asigna metaTemplateId", async () => {
    const templateRepo = new MessageTemplateRepositoryFake();
    const metaGateway = new MetaTemplatesGatewayFake();
    const useCase = new CreateMessageTemplateUseCase({ templateRepo, metaGateway });

    // 1. Nombre invalido (con mayusculas o espacios o guion medio)
    await expect(
      useCase.execute({
        name: "Invalid-Name",
        category: "UTILITY",
        bodyText: "Hola {{1}}",
      }),
    ).rejects.toThrow("^[a-z0-9_]+$");

    // 2. Body invalido (>1024 caracteres)
    const longBody = "a".repeat(1025);
    await expect(
      useCase.execute({
        name: "valid_name",
        category: "UTILITY",
        bodyText: longBody,
      }),
    ).rejects.toThrow("1024 caracteres");

    // 3. Exito
    const created = await useCase.execute({
      name: "bienvenida_cliente",
      category: "MARKETING",
      language: "es",
      bodyText: "Hola {{1}}, bienvenido a nuestro servicio ISP.",
      footerText: "Responde CANCELAR para salir",
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe("bienvenida_cliente");
    expect(created.category).toBe("MARKETING");
    expect(created.status).toBe("PENDING");
    expect(created.metaTemplateId).toMatch(/^meta-/);
    expect(metaGateway.submitted.length).toBe(1);
    expect(metaGateway.submitted[0]?.name).toBe("bienvenida_cliente");
  });

  it("CreateMessageTemplateUseCase: exige headerContent cuando headerType es IMAGE, VIDEO o DOCUMENT", async () => {
    const templateRepo = new MessageTemplateRepositoryFake();
    const metaGateway = new MetaTemplatesGatewayFake();
    const useCase = new CreateMessageTemplateUseCase({ templateRepo, metaGateway });

    await expect(
      useCase.execute({
        name: "promo_imagen_sin_url",
        category: "MARKETING",
        headerType: "IMAGE",
        bodyText: "Mira esta oferta {{1}}",
      }),
    ).rejects.toThrow("headerContent");

    const created = await useCase.execute({
      name: "promo_imagen_valida",
      category: "MARKETING",
      headerType: "IMAGE",
      headerContent: "https://example.com/imagen.jpg",
      bodyText: "Mira esta oferta {{1}}",
    });

    expect(created.headerType).toBe("IMAGE");
    expect(created.headerContent).toBe("https://example.com/imagen.jpg");
  });

  it("ListMessageTemplatesUseCase: filtra por categoria, estado, busqueda y paginacion", async () => {
    const templateRepo = new MessageTemplateRepositoryFake();
    const listUseCase = new ListMessageTemplatesUseCase(templateRepo);

    await templateRepo.create({
      id: "tpl-1",
      name: "promocion_fibra",
      category: "MARKETING",
      language: "es",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Descuento en fibra optica",
      footerText: null,
      buttons: null,
      status: "APPROVED",
      metaTemplateId: "meta-1",
      rejectedReason: null,
    });

    await templateRepo.create({
      id: "tpl-2",
      name: "alerta_corte",
      category: "UTILITY",
      language: "es",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Mantenimiento programado de red",
      footerText: null,
      buttons: null,
      status: "PENDING",
      metaTemplateId: "meta-2",
      rejectedReason: null,
    });

    const marketing = await listUseCase.execute({ category: "MARKETING" });
    expect(marketing.total).toBe(1);
    expect(marketing.templates[0]?.id).toBe("tpl-1");

    const pending = await listUseCase.execute({ status: "PENDING" });
    expect(pending.total).toBe(1);
    expect(pending.templates[0]?.id).toBe("tpl-2");

    const searchResult = await listUseCase.execute({ search: "mantenimiento" });
    expect(searchResult.total).toBe(1);
    expect(searchResult.templates[0]?.id).toBe("tpl-2");
  });

  it("DeleteMessageTemplateUseCase: elimina en Meta y en BD", async () => {
    const templateRepo = new MessageTemplateRepositoryFake();
    const metaGateway = new MetaTemplatesGatewayFake();
    const useCase = new DeleteMessageTemplateUseCase({ templateRepo, metaGateway });

    await templateRepo.create({
      id: "tpl-del",
      name: "plantilla_obsoleta",
      category: "UTILITY",
      language: "es",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Texto de prueba",
      footerText: null,
      buttons: null,
      status: "APPROVED",
      metaTemplateId: "meta-del-123",
      rejectedReason: null,
    });

    const result = await useCase.execute("tpl-del");
    expect(result.success).toBe(true);
    expect(result.id).toBe("tpl-del");
    expect(metaGateway.deleted.length).toBe(1);
    expect(metaGateway.deleted[0]?.metaTemplateId).toBe("meta-del-123");
    expect(await templateRepo.findById("tpl-del")).toBeNull();
  });

  it("SyncTemplateStatusUseCase: actualiza estado/rejectedReason y emite evento realtime", async () => {
    const templateRepo = new MessageTemplateRepositoryFake();
    const metaGateway = new MetaTemplatesGatewayFake();
    const broadcaster = new RealtimeBroadcaster();
    const useCase = new SyncTemplateStatusUseCase({ templateRepo, metaGateway, broadcaster });

    const publishedEvents: unknown[] = [];
    broadcaster.subscribe({
      userId: "user-test",
      role: "admin",
      departmentIds: new Set(),
      send: (ev) => publishedEvents.push(ev),
    });

    await templateRepo.create({
      id: "tpl-sync",
      name: "notificacion_factura",
      category: "UTILITY",
      language: "es",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Tu factura esta lista",
      footerText: null,
      buttons: null,
      status: "PENDING",
      metaTemplateId: "meta-sync-1",
      rejectedReason: null,
    });

    // 1. Sync con status explícito (ej. desde webhook)
    const updated1 = await useCase.execute({
      metaTemplateId: "meta-sync-1",
      status: "APPROVED",
    });

    expect(updated1.status).toBe("APPROVED");
    expect(publishedEvents.length).toBe(1);
    expect(publishedEvents[0]).toEqual({
      type: "MESSAGE_TEMPLATE_UPDATED",
      templateId: "tpl-sync",
      metaTemplateId: "meta-sync-1",
      status: "APPROVED",
      rejectedReason: null,
    });

    // 2. Sync consultando a Meta (sin status explícito en input)
    metaGateway.statusMap.set("meta-sync-1", {
      status: "REJECTED",
      rejectedReason: "INSUFFICIENT_PROMOTION_DETAILS",
    });

    const updated2 = await useCase.execute({ id: "tpl-sync" });
    expect(updated2.status).toBe("REJECTED");
    expect(updated2.rejectedReason).toBe("INSUFFICIENT_PROMOTION_DETAILS");
    expect(publishedEvents.length).toBe(2);
  });

  it("SyncRemoteTemplatesUseCase: descarga plantillas remotas y crea las faltantes / actualiza existentes", async () => {
    const templateRepo = new MessageTemplateRepositoryFake();
    const metaGateway = new MetaTemplatesGatewayFake();
    const broadcaster = new RealtimeBroadcaster();

    // Mock fetchAllTemplates
    metaGateway.fetchAllTemplates = async () => [
      {
        metaTemplateId: "zernio-101",
        name: "prueba_varible",
        category: "MARKETING",
        language: "es_EC",
        headerType: "NONE",
        bodyText: "Hola {{1}}, esto es una prueba mas",
        status: "APPROVED",
      },
      {
        metaTemplateId: "zernio-102",
        name: "prueba_test",
        category: "MARKETING",
        language: "es_EC",
        headerType: "NONE",
        bodyText: "Buenos dias esta va a ser una prueba",
        status: "APPROVED",
      },
    ];

    // Crear plantilla obsoleta en BD local que no está en Zernio
    await templateRepo.create({
      id: "tpl-stale-1",
      name: "prueba_envio_informacion",
      category: "MARKETING",
      language: "es_EC",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Texto de plantilla obsoleta",
      footerText: null,
      buttons: null,
      status: "APPROVED",
      metaTemplateId: "stale-1",
      rejectedReason: null,
    });

    const syncRemote = new SyncRemoteTemplatesUseCase({ templateRepo, metaGateway, broadcaster });

    const result = await syncRemote.execute();
    expect(result.syncedCount).toBe(2);

    const createdVarible = await templateRepo.findByName("prueba_varible");
    expect(createdVarible).not.toBeNull();
    expect(createdVarible?.status).toBe("APPROVED");
    expect(createdVarible?.language).toBe("es_EC");

    const createdTest = await templateRepo.findByName("prueba_test");
    expect(createdTest).not.toBeNull();
    expect(createdTest?.status).toBe("APPROVED");

    // Verificar que la plantilla obsoleta fue eliminada de la BD local
    const staleTemplate = await templateRepo.findByName("prueba_envio_informacion");
    expect(staleTemplate).toBeNull();
  });
});
