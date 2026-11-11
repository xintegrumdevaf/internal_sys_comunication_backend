import { describe, it, expect } from "vitest";
import {
  translateDeliveryError,
  is24HourWindowError,
} from "../../src/core/modules/conversations/domain/meta-delivery-error";

describe("translateDeliveryError", () => {
  it("translates Meta Error 131049 (ecosystem engagement limit)", () => {
    const raw =
      "In order to maintain a healthy ecosystem engagement, the message failed to be delivered. (Meta Error 131049)";
    const translated = translateDeliveryError(raw, 131049);
    expect(translated).toContain("Límite de protección de Meta");
    expect(translated).toContain("131049");
  });

  it("translates Meta Error 131047 (24 hour window)", () => {
    const raw = "131047 Re-engagement message / 24 hours window expired";
    const translated = translateDeliveryError(raw, "131047");
    expect(translated).toContain("Ventana de 24 horas cerrada");
    expect(is24HourWindowError(raw, 131047)).toBe(true);
  });

  it("translates Meta Error 131026 (message undeliverable)", () => {
    const raw = "Message undeliverable to this phone";
    const translated = translateDeliveryError(raw, 131026);
    expect(translated).toContain("Número no disponible");
    expect(translated).toContain("131026");
  });

  it("translates Meta Error 131056 (template param mismatch)", () => {
    const raw = "Param count mismatch in template";
    const translated = translateDeliveryError(raw, 131056);
    expect(translated).toContain("Error en plantilla");
    expect(translated).toContain("131056");
  });

  it("translates 429 rate limit", () => {
    const raw = "Rate limit exceeded. Please retry after 17 seconds.";
    const translated = translateDeliveryError(raw, 429);
    expect(translated).toContain("Límite de tasa alcanzado");
  });

  it("handles empty or generic errors gracefully", () => {
    expect(translateDeliveryError(null)).toBe("Error de entrega en WhatsApp / Meta");
    expect(translateDeliveryError("Error de entrega en WhatsApp / Meta")).toBe(
      "Error de entrega en WhatsApp / Meta",
    );
  });
});

