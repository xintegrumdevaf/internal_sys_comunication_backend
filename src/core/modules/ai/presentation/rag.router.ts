import { Router } from "express";
import multer from "multer";
import type { Logger } from "../../../../shared/logging/logger";
import type { RagService } from "../application/services/rag.service";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

export type RagRouterDeps = {
  ragService: RagService;
  logger?: Logger;
};

export function createRagRouter({ ragService, logger }: RagRouterDeps): Router {
  const router = Router();

  // GET /api/rag/documents - Listar todos los documentos de RAG
  router.get("/api/rag/documents", async (req, res, next) => {
    try {
      const documents = await ragService.listDocuments();
      res.json({ data: documents });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/rag/documents - Subir, extraer, chunkear e indexar documento
  router.post("/api/rag/documents", upload.any(), async (req, res, next) => {
    try {
      const uploadedFile = req.file || (req.files && Array.isArray(req.files) ? req.files[0] : undefined);
      const name = uploadedFile?.originalname || req.body.name || "Documento_Sin_Nombre.pdf";
      const category = req.body.category || "General";
      const mimeType = uploadedFile?.mimetype || req.body.mimeType || "application/pdf";
      const sizeBytes = uploadedFile?.size || Number(req.body.sizeBytes) || 1000000;
      const uploadedBy = req.body.uploadedBy || "Admin Sistema";
      const sourceUrl = req.body.sourceUrl || null;
      const id = `doc-${Date.now()}`;

      if (uploadedFile?.buffer) {
        const doc = await ragService.processAndIndexDocument(uploadedFile.buffer, {
          id,
          name,
          category,
          mimeType,
          sizeBytes,
          uploadedBy,
          sourceUrl,
        });
        return res.status(201).json({ data: doc });
      }

      // Si no viene archivo binario, crear entrada directa
      const doc = await ragService.processAndIndexDocument(Buffer.from(req.body.content || ""), {
        id,
        name,
        category,
        mimeType: "text/plain",
        sizeBytes: (req.body.content || "").length,
        uploadedBy,
        sourceUrl,
      });

      res.status(201).json({ data: doc });
    } catch (error) {
      logger?.error({ err: error }, "Error procesando POST /api/rag/documents");
      next(error);
    }
  });

  // DELETE /api/rag/documents/:id - Eliminar documento y sus vectores asociados
  router.delete("/api/rag/documents/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const success = await ragService.deleteDocument(id);
      res.json({ success, id });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/rag/stats - Estadísticas de RAG
  router.get("/api/rag/stats", async (req, res, next) => {
    try {
      const stats = await ragService.getStats();
      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/rag/faqs - Listar FAQs
  router.get("/api/rag/faqs", async (req, res, next) => {
    try {
      const faqs = await ragService.listFaqs();
      res.json({ data: faqs });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/rag/faqs - Crear FAQ
  router.post("/api/rag/faqs", async (req, res, next) => {
    try {
      const { category, question, answer, tags = [], variations = [], priority = 5 } = req.body;
      const id = `faq-${Date.now()}`;
      const faq = await ragService.createFaq({ id, category, question, answer, tags, variations, priority });
      res.status(201).json({ data: faq });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/rag/faqs/:id - Actualizar FAQ
  router.put("/api/rag/faqs/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { category, question, answer, tags, variations, priority, active } = req.body;
      const updated = await ragService.updateFaq(id, { category, question, answer, tags, variations, priority, active });
      if (!updated) {
        return res.status(404).json({ error: "FAQ no encontrada" });
      }
      res.json({ data: updated });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/rag/faqs/:id - Eliminar FAQ
  router.delete("/api/rag/faqs/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const success = await ragService.deleteFaq(id);
      res.json({ success, id });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/rag/query - Consultar RAG Nativo
  router.post("/api/rag/query", async (req, res, next) => {
    try {
      const { question } = req.body;
      const q = (question || "").trim();
      if (!q) {
        return res.status(400).json({ error: "La pregunta no puede estar vacía" });
      }

      const result = await ragService.query(q, 4);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
