import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createContainer } from "../src/core/composition/container";

describe("GET /health", () => {
  const container = createContainer();

  afterAll(async () => {
    await container.shutdown();
  });

  it("responde 200 con status ok cuando Postgres y Redis estan disponibles", async () => {
    const response = await request(container.app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      dependencies: { postgres: "up", redis: "up" },
    });
    expect(typeof response.body.timestamp).toBe("string");
  });
});
