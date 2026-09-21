import { describe, expect, it } from "vitest";
import { TemplatePolicyValidator } from "../../src/core/modules/message-templates/domain/template-policy-validator";
import type { SubmitTemplateInput } from "../../src/core/modules/message-templates/application/ports/meta-templates-gateway.port";

describe("TemplatePolicyValidator", () => {
  describe("validateName", () => {
    it("acepta nombres válidos en minúsculas comenzando con letra", () => {
      expect(() => TemplatePolicyValidator.validateName("plantilla_1")).not.toThrow();
      expect(() => TemplatePolicyValidator.validateName("aviso_pago")).not.toThrow();
    });

    it("rechaza nombres que inician con número o guion bajo", () => {
      expect(() => TemplatePolicyValidator.validateName("1_plantilla")).toThrow("empezar con una letra");
      expect(() => TemplatePolicyValidator.validateName("_plantilla")).toThrow("empezar con una letra");
    });

    it("rechaza mayúsculas, espacios o guiones medios", () => {
      expect(() => TemplatePolicyValidator.validateName("Plantilla")).toThrow("empezar con una letra");
      expect(() => TemplatePolicyValidator.validateName("mi-plantilla")).toThrow("empezar con una letra");
      expect(() => TemplatePolicyValidator.validateName("mi plantilla")).toThrow("empezar con una letra");
    });
  });

  describe("validateVariables", () => {
    it("acepta variables secuenciales válidas {{1}}, {{2}} con texto descriptivo", () => {
      expect(() =>
        TemplatePolicyValidator.validateVariables("Hola {{1}}, tu factura de {{2}} vence el 15."),
      ).not.toThrow();
    });

    it("rechaza variables no secuenciales (salto de {{1}} a {{3}})", () => {
      expect(() =>
        TemplatePolicyValidator.validateVariables("Hola {{1}}, tu código es {{3}}."),
      ).toThrow("secuenciales iniciando en {{1}}");
    });

    it("rechaza variables contiguas sin texto entre ellas {{1}}{{2}}", () => {
      expect(() =>
        TemplatePolicyValidator.validateVariables("Hola {{1}}{{2}}, confirmamos tu cita."),
      ).toThrow("variables contiguas");
    });

    it("rechaza plantillas que inician directamente con una variable sin texto descriptivo previo", () => {
      expect(() =>
        TemplatePolicyValidator.validateVariables("{{1}} confirmamos tu cita de servicio."),
      ).toThrow("iniciar directamente con una variable");
    });

    it("rechaza plantillas que terminan directamente con una variable sin texto o cierre", () => {
      expect(() =>
        TemplatePolicyValidator.validateVariables("Hola estimado cliente, tu saldo pendiente es {{1}}"),
      ).toThrow("finalizar directamente con una variable");
    });
  });

  describe("validateProhibitedLinks", () => {
    it("detecta acortadores de URL prohibidos (bit.ly, tinyurl.com, rb.gy, etc.)", () => {
      expect(() =>
        TemplatePolicyValidator.validateProhibitedLinks("Ingresa a bit.ly/mi-oferta"),
      ).toThrow("acortador de URL prohibido");

      expect(() =>
        TemplatePolicyValidator.validateProhibitedLinks("Ver en https://tinyurl.com/xyz"),
      ).toThrow("acortador de URL prohibido");
    });

    it("permite dominios completos HTTPS", () => {
      expect(() =>
        TemplatePolicyValidator.validateProhibitedLinks("Ingresa a https://miempresa.com/pago"),
      ).not.toThrow();
    });
  });

  describe("validateComponentLimits", () => {
    it("rechaza encabezados de texto de más de 60 caracteres", () => {
      const input: SubmitTemplateInput = {
        name: "test_template",
        category: "UTILITY",
        language: "es",
        headerType: "TEXT",
        headerContent: "A".repeat(61),
        bodyText: "Hola {{1}}, este es un mensaje de prueba válido.",
      };
      expect(() => TemplatePolicyValidator.validateComponentLimits(input)).toThrow(
        "encabezado de texto (headerContent) no puede superar los 60 caracteres",
      );
    });

    it("rechaza pies de página de más de 60 caracteres", () => {
      const input: SubmitTemplateInput = {
        name: "test_template",
        category: "UTILITY",
        language: "es",
        bodyText: "Hola {{1}}, este es un mensaje de prueba válido.",
        footerText: "B".repeat(61),
      };
      expect(() => TemplatePolicyValidator.validateComponentLimits(input)).toThrow(
        "pie de página (footerText) no puede superar los 60 caracteres",
      );
    });

    it("rechaza texto de botones de más de 25 caracteres", () => {
      const input: SubmitTemplateInput = {
        name: "test_template",
        category: "UTILITY",
        language: "es",
        bodyText: "Hola {{1}}, este es un mensaje de prueba válido.",
        buttons: [{ type: "QUICK_REPLY", text: "C".repeat(26) }],
      };
      expect(() => TemplatePolicyValidator.validateComponentLimits(input)).toThrow(
        "texto del botón 'CCCCCCCCCCCCCCCCCCCCCCCCCC' no puede superar los 25 caracteres",
      );
    });
  });

  describe("validateAll", () => {
    it("pasa la validación completa en una plantilla válida", () => {
      const input: SubmitTemplateInput = {
        name: "aviso_pago_vencido",
        category: "UTILITY",
        language: "es",
        headerType: "TEXT",
        headerContent: "Aviso de Pago",
        bodyText: "Estimado cliente {{1}}, su servicio vence el {{2}}. Evite cortes.",
        footerText: "Soporte ISP",
        buttons: [{ type: "URL", text: "Ver Factura", url: "https://isp.com/factura" }],
      };

      expect(() => TemplatePolicyValidator.validateAll(input)).not.toThrow();
    });
  });
});
