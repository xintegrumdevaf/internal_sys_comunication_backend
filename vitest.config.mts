import { defineConfig } from "vitest/config";

export const DB_INTEGRATION_TESTS = [
  "**/cases/case.repository.pg.test.ts",
  "**/cases/workflow-execution.repository.pg.test.ts",
  "**/cases/n8n-workflows.router.test.ts",
  "**/conversations/receive-inbound-message.use-case.test.ts",
  "**/conversations/reply-as-human.use-case.test.ts",
  "**/internal-chat/internal-chat.test.ts",
  "**/audit/audit.test.ts",
  "**/message-templates/message-templates.router.test.ts",
  "**/health.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...DB_INTEGRATION_TESTS,
    ],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});

