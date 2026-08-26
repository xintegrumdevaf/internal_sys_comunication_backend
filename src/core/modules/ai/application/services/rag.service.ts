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
  geminiApiKey?: string;
  geminiModel?: string;
  aiTimeoutMs?: number;
  logger?: Logger;
}

export class RagService {
  private readonly docRepo: RagDocumentRepositoryPort;
  private readonly vectorStore: VectorStorePort;
  private readonly embeddingProvider: EmbeddingProviderPort;
  private readonly chatModelUrl: string;
  private readonly chatModel: string;
  private readonly geminiApiKey?: string;
  private readonly geminiModel?: string;
  private readonly aiTimeoutMs: number;
  private readonly logger?: Logger;

  constructor(deps: RagServiceDeps) {
    this.docRepo = deps.documentRepository;
    this.vectorStore = deps.vectorStore;
    this.embeddingProvider = deps.embeddingProvider;
    this.chatModelUrl = deps.chatModelUrl || "http://localhost:11434";
    this.chatModel = deps.chatModel || "qwen3.5:4b";
    this.geminiApiKey = deps.geminiApiKey;
    this.geminiModel = deps.geminiModel || "gemini-2.5-flash-lite";
    this.aiTimeoutMs = deps.aiTimeoutMs || 45000;
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

      if (
        trimmed.includes("Ejemplos de consultas que este documento debe permitir responder") ||
        trimmed.includes("Reglas de interpretación para un asistente RAG") ||
        trimmed.includes("No inventar planes, precios, cuentas bancarias") ||
        trimmed.includes("Priorizar la información contenida en este documento")
      ) {
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

    // Expansión semántica para preguntas de cobertura, ciudades, ubicación o disponibilidad
    const isCoverageOrLocation = /operan|operaci[oó]n|cobertura|ciudad|ciudades|sector|sectores|disponib|llegada|llegan|est[aá]n|donde|d[oó]nde|ubicaci[oó]n|oficina|oficinas|lugar/i.test(question);
    if (isCoverageOrLocation) {
      keywordsSet.add("cobertura");
      keywordsSet.add("ciudades");
      keywordsSet.add("quito");
      keywordsSet.add("cuenca");
      keywordsSet.add("sectores");
    }

    // 1. Si la consulta es sobre planes/paquetes/precios/información, expandir keywords y priorizar tabla de planes
    const isPlanQuery = /plan|planes|paquete|paquetes|precio|precios|velocidad|velocidades|oferta|tarifa|cuanto|info|informaci[oó]n|interesa|interesar[ií]a|contratar|servicios|servicio|fibra|costo|costos/i.test(question);
    if (isPlanQuery) {
      keywordsSet.add("planes");
      keywordsSet.add("paquetes");
      keywordsSet.add("precios");
      keywordsSet.add("hogar");
      keywordsSet.add("mbps");
    }

    const keywords = Array.from(keywordsSet);

    const candidateLimit = Math.max(limit, 10);
    const rawResults = await this.vectorStore.searchHybrid({ embedding, keywords, limit: candidateLimit });

    // Filtrar cualquier fragmento de reglas internas/meta que no deba llegar al cliente
    const results = rawResults.filter(
      (c) =>
        !c.contentSnippet.includes("Reglas de interpretación para un asistente RAG") &&
        !c.contentSnippet.includes("No inventar planes, precios, cuentas bancarias")
    );

    return results.slice(0, limit);
  }

  async synthesizeAnswer(question: string, chunks: RagChunk[]): Promise<string> {
    if (chunks.length === 0) {
      return "No encontré información relevante en la base de conocimiento para responder a tu consulta.";
    }

    const context = chunks.map((c) => c.contentSnippet).join("\n---\n");
    const systemPrompt =
      "Eres el asesor de atención al cliente de la empresa. Responde de forma cordial, concisa y PUNTUAL (máximo 2 a 3 oraciones), basándote ÚNICAMENTE en el contexto documental proporcionado.\n" +
      "- Responde EXACTAMENTE a lo que el usuario pregunta, sin omitir datos específicos pedidos (por ejemplo, lista de sectores, precios o requisitos si fueron preguntados).\n" +
      "- NO agregues información no solicitada (no agregues correos, teléfonos, horarios de soporte ni detalles de planes a menos que el usuario los haya preguntado).\n" +
      "- NUNCA digas que eres una IA o asistente virtual ni que careces de catálogo o información.";
    const userPrompt = `Contexto documental:\n${context}\n\nPregunta del cliente: ${question}\nRespuesta puntual y directa:`;

    // 1. Si Gemini API Key está configurada, usar Gemini para respuesta limpia e instantánea (sub-500ms)
    if (this.geminiApiKey) {
      try {
        const model = this.geminiModel || "gemini-2.5-flash-lite";
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiApiKey}`, {
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

    // 2. Ollama local con /api/chat + timeout configurable
    const timeoutMs = this.aiTimeoutMs;
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

function extractSmartFallback(_question: string, snippet: string): string {
  const rawLines = snippet
    .replace(/^#{1,3}\s+.+\n?/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return rawLines.join("\n").trim() || snippet;
}
