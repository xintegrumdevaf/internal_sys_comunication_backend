import { validationError } from "../../../../shared/errors/domain-errors";
import type { SubmitTemplateInput } from "../application/ports/meta-templates-gateway.port";

const PROHIBITED_URL_SHORTENERS_REGEX =
  /(?:https?:\/\/)?(?:www\.)?(bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|rb\.gy|is\.gd|buff\.ly|adf\.ly|bit\.do)\b/i;

export class TemplatePolicyValidator {
  /**
   * Valida el nombre de la plantilla conforme a las reglas de Meta/Zernio.
   */
  static validateName(name: string): void {
    const trimmed = name ? name.trim() : "";
    if (!trimmed || !/^[a-z][a-z0-9_]*$/.test(trimmed)) {
      throw validationError(
        "El nombre de la plantilla debe empezar con una letra minúscula y solo contener letras minúsculas, números y guiones bajos (^[a-z][a-z0-9_]*$)",
      );
    }
  }

  /**
   * Valida las variables en el texto del cuerpo conforme a las reglas de Meta.
   */
  static validateVariables(bodyText: string): void {
    const text = bodyText.trim();

    // 1. Detectar variables contiguas sin texto entre ellas (ej. {{1}}{{2}})
    if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(text)) {
      throw validationError(
        "Meta rechaza plantillas con variables contiguas (ej. {{1}}{{2}}). Debe existir texto o espacio descriptivo entre ellas.",
      );
    }

    // 2. Extraer todas las variables {{N}}
    const varRegex = /\{\{\s*(\d+)\s*\}\}/g;
    const matches: number[] = [];
    let match: RegExpExecArray | null;

    while ((match = varRegex.exec(text)) !== null) {
      if (match[1]) {
        matches.push(parseInt(match[1], 10));
      }
    }

    if (matches.length > 0) {
      // Verificar que las variables inician en 1 y son secuenciales 1..N sin saltos
      const maxVar = Math.max(...matches);
      const uniqueVars = new Set(matches);

      for (let i = 1; i <= maxVar; i++) {
        if (!uniqueVars.has(i)) {
          throw validationError(
            `Las variables de la plantilla deben ser secuenciales iniciando en {{1}}. Falta la variable {{${i}}}.`,
          );
        }
      }

      // 3. Verificar que la plantilla no inicie ni termine directamente con una variable sin texto previo/posterior
      const startsWithVar = /^\{\{\s*\d+\s*\}\}/.test(text);
      const endsWithVar = /\{\{\s*\d+\s*\}\}$/.test(text);

      if (startsWithVar) {
        throw validationError(
          "La plantilla no puede iniciar directamente con una variable sin texto o palabras previas de contexto.",
        );
      }

      if (endsWithVar) {
        throw validationError(
          "La plantilla no puede finalizar directamente con una variable sin texto posterior o cierre adecuado.",
        );
      }
    }
  }

  /**
   * Valida la ausencia de acortadores de URL prohibidos por Meta.
   */
  static validateProhibitedLinks(text: string, fieldName = "El texto"): void {
    if (PROHIBITED_URL_SHORTENERS_REGEX.test(text)) {
      throw validationError(
        `${fieldName} contiene un acortador de URL prohibido por Meta (ej. bit.ly, tinyurl). Usa la URL completa HTTPS de tu dominio.`,
      );
    }
  }

  /**
   * Valida los límites de caracteres y restricciones de componentes (Header, Footer, Buttons).
   */
  static validateComponentLimits(input: SubmitTemplateInput): void {
    if (input.bodyText.length > 1024) {
      throw validationError("El texto del cuerpo (bodyText) no puede superar los 1024 caracteres");
    }

    this.validateProhibitedLinks(input.bodyText, "El cuerpo del mensaje");

    if (input.headerType === "TEXT" && input.headerContent) {
      if (input.headerContent.length > 60) {
        throw validationError("El encabezado de texto (headerContent) no puede superar los 60 caracteres");
      }
      this.validateProhibitedLinks(input.headerContent, "El encabezado");
    }

    if (input.footerText) {
      if (input.footerText.length > 60) {
        throw validationError("El pie de página (footerText) no puede superar los 60 caracteres");
      }
      this.validateProhibitedLinks(input.footerText, "El pie de página");
    }

    if (input.buttons && input.buttons.length > 0) {
      for (const btn of input.buttons) {
        if (btn.text.length > 25) {
          throw validationError(`El texto del botón '${btn.text}' no puede superar los 25 caracteres`);
        }
        if (btn.type === "URL" && btn.url) {
          this.validateProhibitedLinks(btn.url, `La URL del botón '${btn.text}'`);
        }
      }
    }
  }

  /**
   * Valida de forma integral una solicitud de creación de plantilla.
   */
  static validateAll(input: SubmitTemplateInput): void {
    this.validateName(input.name);
    this.validateVariables(input.bodyText);
    this.validateComponentLimits(input);
  }
}
