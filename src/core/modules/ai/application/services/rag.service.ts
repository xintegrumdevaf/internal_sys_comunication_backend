import { PDFParse } from "pdf-parse";
import type { RagChunk, RagDocument, RagFaq, RagQueryResult, RagStats } from "../../domain/rag.entity";
import type { CreateRagFaqInput, RagDocumentRepositoryPort, UpdateRagFaqInput } from "../ports/rag-document.repository.port";
import type { VectorStorePort } from "../ports/vector-store.port";
import type { EmbeddingProviderPort } from "../ports/embedding-provider.port";
import type { Logger } from "../../../../../shared/logging/logger";

export interface RagServiceDeps {
  documentRepository: RagDocumentRepositoryPort;
  vectorStore: VectorStorePort;
  embeddingProvider: EmbeddingProviderPort;
  chatModelUrl?: string;
  chatModel?: string;
  logger?: Logger;
}

export class RagService {
  private readonly docRepo: RagDocumentRepositoryPort;
  private readonly vectorStore: VectorStorePort;
  private readonly embeddingProvider: EmbeddingProviderPort;
  private readonly chatModelUrl: string;
  private readonly chatModel: string;
  private readonly logger?: Logger;

  constructor(deps: RagServiceDeps) {
    this.docRepo = deps.documentRepository;
    this.vectorStore = deps.vectorStore;
    this.embeddingProvider = deps.embeddingProvider;
    this.chatModelUrl = deps.chatModelUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    this.chatModel = deps.chatModel || process.env.OLLAMA_MODEL || "qwen3.5:9b";
    this.logger = deps.logger?.child({ service: "RagService" });
  }

  // --- Documentos & FAQs (Delegados al Repository Port) ---
  async listDocuments(): Promise<RagDocument[]> {
    return this.docRepo.listDocuments();
  }

  async deleteDocument(id: string): Promise<boolean> {
    const doc = await this.docRepo.findDocumentById(id);
    if (doc) {
      await this.vectorStore.deleteBySource(doc.name);
    }
    return this.docRepo.deleteDocument(id);
  }

  async listFaqs(): Promise<RagFaq[]> {
    return this.docRepo.listFaqs();
  }

  async createFaq(input: CreateRagFaqInput): Promise<RagFaq> {
    return this.docRepo.createFaq(input);
  }

  async updateFaq(id: string, input: UpdateRagFaqInput): Promise<RagFaq | null> {
    return this.docRepo.updateFaq(id, input);
  }

  async deleteFaq(id: string): Promise<boolean> {
    return this.docRepo.deleteFaq(id);
  }

  async getStats(): Promise<RagStats> {
    return this.docRepo.getStats();
  }

  // --- Ingesta de Documentos ---
  async extractText(buffer: Buffer, mimeType: string, filename = "document"): Promise<string> {
    if (mimeType.includes("pdf") || buffer.slice(0, 4).toString() === "%PDF") {
      try {
        const parser = new PDFParse({ data: buffer });
        const res = await parser.getText();
        return res.text || "";
      } catch (err) {
        this.logger?.warn({ err, filename }, "Fallo al parsear PDF, intentando como texto plano");
      }
    }
    return buffer.toString("utf-8");
  }

  chunkDocument(rawText: string, _filename = "document"): Array<{ text: string; section?: string }> {
    const cleaned = rawText
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const sections = cleaned.split(/(?=\n#{1,3}\s+)/g);
    const chunks: Array<{ text: string; section?: string }> = [];

    for (const sec of sections) {
      const trimmed = sec.trim();
      if (!trimmed || trimmed.length < 30) continue;

      if (trimmed.includes("Ejemplos de consultas que este documento debe permitir responder")) {
        continue;
      }

      const headerMatch = trimmed.match(/^#{1,3}\s+(.+)/);
      const sectionName = headerMatch && headerMatch[1] ? headerMatch[1].trim() : undefined;

      if (trimmed.length <= 800) {
        chunks.push({ text: trimmed, section: sectionName });
      } else {
        const paras = trimmed.split(/\n\n+/);
        let current = "";
        for (const p of paras) {
          if (current.length + p.length <= 700) {
            current = current ? `${current}\n\n${p}` : p;
          } else {
            if (current) chunks.push({ text: current, section: sectionName });
            current = sectionName && !p.startsWith("#") ? `[${sectionName}]\n${p}` : p;
          }
        }
        if (current && current.length > 30) {
          chunks.push({ text: current, section: sectionName });
        }
      }
    }

    if (chunks.length === 0 && cleaned.length > 0) {
      const paras = cleaned.split(/\n\n+/);
      let current = "";
      for (const p of paras) {
        if (current.length + p.length <= 700) {
          current = current ? `${current}\n\n${p}` : p;
        } else {
          if (current) chunks.push({ text: current });
          current = p;
        }
      }
      if (current) chunks.push({ text: current });
    }

    return chunks;
  }

  async processAndIndexDocument(
    buffer: Buffer,
    input: { id: string; name: string; category: string; mimeType: string; sizeBytes: number; uploadedBy: string; sourceUrl?: string | null }
  ): Promise<RagDocument> {
    const rawText = await this.extractText(buffer, input.mimeType, input.name);
    const rawChunks = this.chunkDocument(rawText, input.name);

    // Eliminar chunks anteriores del mismo archivo
    await this.vectorStore.deleteBySource(input.name);

    // Generar embeddings para cada chunk
    const chunksToIndex = [];
    for (const [idx, chunk] of rawChunks.entries()) {
      const embedding = await this.embeddingProvider.generateEmbedding(chunk.text);
      chunksToIndex.push({
        text: chunk.text,
        embedding,
        metadata: {
          source: input.name,
          filename: input.name,
          chunkIndex: idx + 1,
          section: chunk.section,
        },
      });
    }

    const indexedCount = await this.vectorStore.indexChunks(chunksToIndex);
    this.logger?.info({ name: input.name, indexedCount }, "Chunks indexados en vector store");

    return this.docRepo.createDocument({
      id: input.id,
      name: input.name,
      category: input.category,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      chunksCount: indexedCount,
      uploadedBy: input.uploadedBy,
      sourceUrl: input.sourceUrl,
    });
  }

  // --- Consulta y Búsqueda Híbrida ---
  async searchHybrid(question: string, limit = 4): Promise<RagChunk[]> {
    const embedding = await this.embeddingProvider.generateEmbedding(question);
    const stopWords = new Set([
      "dame", "numero", "número", "cuál", "cual", "cuales", "cuáles", "donde", "dónde", "como", "cómo",
      "para", "este", "esta", "estos", "estas", "del", "los", "las", "por", "con", "sin",
      "que", "qué", "quien", "quién", "tiene", "tienen", "hacer", "puedo", "saber", "de", "el", "la", "en", "un", "una",
      "quiero", "quisiera", "informacion", "información", "sobre", "necesito", "favor", "dime", "busco", "buscar", "dar", "tengo"
    ]);
    const rawWords = question
      .toLowerCase()
      .replace(/[¿?¡!,.]/g, "")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && !stopWords.has(w));

    const keywordsSet = new Set<string>();
    for (const w of rawWords) {
      keywordsSet.add(w);
      if (w.endsWith("es") && w.length > 4) keywordsSet.add(w.slice(0, -2));
      else if (w.endsWith("s") && w.length > 3) keywordsSet.add(w.slice(0, -1));
    }
    const keywords = Array.from(keywordsSet);

    const candidateLimit = Math.max(limit, 10);
    const results = await this.vectorStore.searchHybrid({ embedding, keywords, limit: candidateLimit });

    // 1. Si la consulta es sobre planes/paquetes/precios y se recuperó la tabla comparativa de planes, priorizarla en #1
    const isPlanQuery = /plan|planes|paquete|paquetes|precio|precios|velocidad|velocidades|oferta|tarifa|cuanto/i.test(question);
    if (isPlanQuery && results.length > 1) {
      const planTableIdx = results.findIndex((c) =>
        c.contentSnippet.includes("Comparación rápida de planes") ||
        c.contentSnippet.includes("Plan | Velocidad") ||
        c.contentSnippet.includes("XGO Hogar")
      );
      if (planTableIdx > 0) {
        const [planChunk] = results.splice(planTableIdx, 1);
        results.unshift(planChunk!);
      }
    }

    // 2. Si la consulta es sobre horarios de atención y se recuperó el chunk de horarios, priorizarlo en #1
    const isScheduleQuery = /horario|horarios|atención|atencion|abren|cierran|hora|atender/i.test(question);
    if (isScheduleQuery && results.length > 1) {
      const scheduleIdx = results.findIndex((c) =>
        c.contentSnippet.includes("### Horarios") ||
        c.contentSnippet.includes("Atención al cliente:")
      );
      if (scheduleIdx > 0) {
        const [schChunk] = results.splice(scheduleIdx, 1);
        results.unshift(schChunk!);
      }
    }

    // 3. Si la consulta pide específicamente la oficina de Quito
    const isQuitoOffice = /quito/i.test(question) && /oficina|oficinas|ubicacion|ubicación|direccion|dirección|queda|quedan|donde|dónde|sucursal/i.test(question);
    if (isQuitoOffice && results.length > 1) {
      const quitoIdx = results.findIndex((c) =>
        c.contentSnippet.includes("Oficina Quito") ||
        c.contentSnippet.includes("República del Salvador")
      );
      if (quitoIdx > 0) {
        const [qChunk] = results.splice(quitoIdx, 1);
        results.unshift(qChunk!);
      }
    }

    // 4. Si la consulta pide específicamente la oficina de Cuenca
    const isCuencaOffice = /cuenca/i.test(question) && /oficina|oficinas|ubicacion|ubicación|direccion|dirección|queda|quedan|donde|dónde|sucursal/i.test(question);
    if (isCuencaOffice && results.length > 1) {
      const cuencaIdx = results.findIndex((c) =>
        c.contentSnippet.includes("Oficina Cuenca") ||
        c.contentSnippet.includes("Remigio Crespo")
      );
      if (cuencaIdx > 0) {
        const [cChunk] = results.splice(cuencaIdx, 1);
        results.unshift(cChunk!);
      }
    }

    return results.slice(0, limit);
  }

  async synthesizeAnswer(question: string, chunks: RagChunk[]): Promise<string> {
    if (chunks.length === 0) {
      return "No encontré información relevante en la base de conocimiento para responder a tu consulta.";
    }

    const context = chunks.map((c) => c.contentSnippet).join("\n---\n");
    const systemPrompt =
      "Eres el asistente oficial de atención al cliente de XGO. Responde ÚNICAMENTE en 1 o máximo 2 oraciones breves y concisas en español. Entrega únicamente la respuesta directa a lo que el usuario preguntó (ej. si pregunta por oficinas o ubicación, indica solo la dirección y ciudad sin listas de trámites ni viñetas adicionales).";
    const userPrompt = `Contexto de la empresa:\n${context}\n\nPregunta del cliente: ${question}\nRespuesta directa:`;

    // 1. Si Gemini API Key está configurada, usar Gemini para respuesta limpia e instantánea (sub-500ms)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 150 },
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (candidate) return candidate.replace(/^Respuesta:\s*/i, "").trim();
        }
      } catch (err) {
        this.logger?.warn({ err }, "Error sintetizando respuesta con Gemini, fallback a Ollama");
      }
    }

    // 2. Ollama local con /api/chat + timeout configurable desde .env (AI_CALL_TIMEOUT_MS, por defecto 35s)
    const timeoutMs = Number(process.env.AI_CALL_TIMEOUT_MS) || 35_000;
    try {
      const controller = new AbortController();
      const ollamaTimeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.chatModelUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.chatModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            stream: false,
            options: { temperature: 0.1, num_predict: 120 },
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as { message?: { content?: string } };
          const content = data.message?.content?.trim();
          if (content) {
            return content.replace(/^Respuesta:\s*/i, "").trim();
          }
        }
      } finally {
        clearTimeout(ollamaTimeout);
      }
    } catch (err) {
      this.logger?.warn({ err }, "Error o timeout sintetizando respuesta con Ollama");
    }

    // 3. Fallback inteligente: extraer específicamente el dato relevante según la intención de la pregunta
    return extractSmartFallback(question, chunks[0]?.contentSnippet || "");
  }

  async query(question: string, limit = 4): Promise<RagQueryResult> {
    const startTime = Date.now();
    const chunks = await this.searchHybrid(question, limit);
    const topScore = chunks.length > 0 && chunks[0] ? chunks[0].similarityScore : 0;

    // Si encontramos chunks en el vector store con score suficiente (threshold 0.15)
    if (chunks.length > 0 && topScore >= 0.15) {
      const answer = await this.synthesizeAnswer(question, chunks);
      const sources = Array.from(new Set(chunks.map((c) => c.sourceName)));

      return {
        answer,
        found: true,
        confidenceScore: topScore,
        sources,
        retrievedChunks: chunks,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Fallback: Buscar en FAQs estructuradas
    const stopWords = new Set([
      "dame", "numero", "número", "cuál", "cual", "cuales", "cuáles", "donde", "dónde", "como", "cómo",
      "para", "este", "esta", "estos", "estas", "del", "los", "las", "por", "con", "sin",
      "que", "qué", "quien", "quién", "tiene", "tienen", "hacer", "puedo", "saber", "de", "el", "la", "en", "un", "una",
      "quiero", "quisiera", "informacion", "información", "sobre", "necesito", "favor", "dime", "busco", "buscar", "dar", "tengo"
    ]);
    const faqs = await this.docRepo.findActiveFaqs();
    const words = question.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w));
    const matchedFaq = words.length > 0 ? faqs.find((f) => {
      const textToSearch = `${f.question} ${(f.tags || []).join(" ")} ${(f.variations || []).join(" ")}`.toLowerCase();
      return words.some((w) => textToSearch.includes(w));
    }) : undefined;

    if (matchedFaq) {
      return {
        answer: matchedFaq.answer,
        found: true,
        confidenceScore: 0.92,
        sources: [`Base FAQ PostgreSQL (${matchedFaq.category})`],
        retrievedChunks: [
          {
            id: `chk-faq-${matchedFaq.id}`,
            sourceName: `PostgreSQL FAQ: ${matchedFaq.category}`,
            contentSnippet: `Pregunta: "${matchedFaq.question}" — Respuesta: "${matchedFaq.answer}"`,
            similarityScore: 0.92,
          },
        ],
        executionTimeMs: Date.now() - startTime,
      };
    }

    return {
      answer: "No se encontró información relevante en los documentos indexados para responder a tu consulta.",
      found: false,
      confidenceScore: 0.0,
      sources: [],
      retrievedChunks: [],
      executionTimeMs: Date.now() - startTime,
    };
  }
}

function extractSmartFallback(question: string, snippet: string): string {
  const q = question.toLowerCase();
  const rawLines = snippet
    .replace(/^#{1,3}\s+.+\n?/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const lines = rawLines.filter(
    (l) =>
      !l.toLowerCase().startsWith("en las oficinas") &&
      !l.toLowerCase().startsWith("los problemas") &&
      !l.toLowerCase().startsWith("preguntas frecuentes")
  );

  // 1. Pregunta sobre planes / paquetes / precios
  if (
    q.includes("plan") ||
    q.includes("planes") ||
    q.includes("paquete") ||
    q.includes("paquetes") ||
    q.includes("precio") ||
    q.includes("precios") ||
    q.includes("velocidad") ||
    q.includes("cuanto") ||
    q.includes("cuánto")
  ) {
    if (
      snippet.includes("Comparación rápida de planes") ||
      snippet.includes("Plan | Velocidad") ||
      snippet.includes("XGO Hogar") ||
      snippet.includes("Mbps")
    ) {
      return snippet;
    }
  }

  // 2. Pregunta sobre horario de atención
  if (q.includes("horario") || q.includes("hora") || q.includes("atencion") || q.includes("atención")) {
    const horarioLines = lines.filter(
      (l) =>
        l.toLowerCase().includes("horario") ||
        l.toLowerCase().includes("lunes") ||
        l.toLowerCase().includes("sábado") ||
        l.toLowerCase().includes("domingo") ||
        l.toLowerCase().includes("atención") ||
        l.toLowerCase().includes("soporte")
    );
    if (horarioLines.length > 0) {
      return horarioLines.join("\n");
    }
  }

  // 2. Pregunta sobre ubicación / oficinas / dirección
  if (
    q.includes("oficina") ||
    q.includes("ubicacion") ||
    q.includes("ubicación") ||
    q.includes("donde") ||
    q.includes("dónde") ||
    q.includes("direccion") ||
    q.includes("dirección")
  ) {
    const direccionLines = lines.filter(
      (l) =>
        l.toLowerCase().includes("dirección") ||
        l.toLowerCase().includes("oficina") ||
        l.toLowerCase().includes("edificio") ||
        l.toLowerCase().includes("av.") ||
        l.toLowerCase().includes("calle")
    );
    if (direccionLines.length > 0) {
      return direccionLines.join("\n");
    }
  }

  let textOnly = lines.join("\n");
  const cutIdx = textOnly.indexOf("En las oficinas se puede:");
  if (cutIdx > 0) {
    textOnly = textOnly.slice(0, cutIdx).trim();
  }
  return textOnly || snippet;
}
