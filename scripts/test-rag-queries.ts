import pg from "pg";
import dotenv from "dotenv";
import { RagDocumentRepositoryPg } from "../src/core/modules/ai/infrastructure/postgres/rag-document.repository.pg";
import { PgVectorStoreAdapter } from "../src/core/modules/ai/infrastructure/postgres/pg-vector-store.adapter";
import { OllamaEmbeddingAdapter } from "../src/core/modules/ai/infrastructure/ollama/ollama-embedding.adapter";
import { RagService } from "../src/core/modules/ai/application/services/rag.service";

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function testRag() {
  const docRepo = new RagDocumentRepositoryPg(pool);
  const vectorStore = new PgVectorStoreAdapter(pool);
  const embeddingProvider = new OllamaEmbeddingAdapter({
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: "qwen3-embedding:4b",
  });

  const ragService = new RagService({
    documentRepository: docRepo,
    vectorStore,
    embeddingProvider,
    chatModelUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    chatModel: process.env.OLLAMA_MODEL || "qwen3.5:9b",
  });

  const questions = [
    "Donde se encuentran sus oficinas?",
    "Que paquetes de internet tienen?",
    "Vivo en Yanuncay",
    "Tienen cobertura en Yanuncay?",
  ];

  for (const q of questions) {
    console.log(`\n========================================`);
    console.log(`PREGUNTA: "${q}"`);
    const res = await ragService.query(q, 4);
    console.log(`FOUND: ${res.found} (Score: ${res.confidenceScore})`);
    console.log(`SOURCES:`, res.sources);
    console.log(`ANSWER:\n${res.answer}`);
  }

  await pool.end();
}

testRag().catch(console.error);
