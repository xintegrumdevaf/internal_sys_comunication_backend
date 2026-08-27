import * as XLSX from "xlsx";
import type { CreateRecipientInput } from "../ports/campaign-recipient.repository.port";

export type FileImportError = {
  row: number;
  phone?: string;
  reason: string;
};

export type FileImportResult = {
  validRecipients: CreateRecipientInput[];
  errors: FileImportError[];
  totalProcessed: number;
};

export class CampaignFileParserService {
  parseBuffer(buffer: Buffer): FileImportResult {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return {
        validRecipients: [],
        errors: [{ row: 0, reason: "El archivo no contiene hojas de trabajo válidas" }],
        totalProcessed: 0,
      };
    }

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return {
        validRecipients: [],
        errors: [{ row: 0, reason: "Hoja de trabajo vacía" }],
        totalProcessed: 0,
      };
    }

    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

    const validRecipients: CreateRecipientInput[] = [];
    const errors: FileImportError[] = [];

    for (let index = 0; index < rawRows.length; index++) {
      const row = rawRows[index]!;
      const rowNumber = index + 2; // Considerando fila 1 como encabezado

      const phoneRaw = this.extractFieldValue(row, [
        "number",
        "phone",
        "telefono",
        "celular",
        "numero",
        "wa_phone",
        "tel",
      ]);
      const nameRaw = this.extractFieldValue(row, ["name", "nombre", "contacto"]);
      const bodyRaw = this.extractFieldValue(row, ["body", "custombody", "mensaje", "message"]);

      if (!phoneRaw) {
        errors.push({
          row: rowNumber,
          phone: "",
          reason: "La columna de número telefónico ('number', 'phone', 'telefono') es requerida y está vacía",
        });
        continue;
      }

      const normalizedPhone = this.normalizePhone(phoneRaw);
      if (!this.isValidPhone(normalizedPhone)) {
        errors.push({
          row: rowNumber,
          phone: phoneRaw,
          reason: "El número telefónico no tiene un formato válido (debe tener entre 8 y 15 dígitos)",
        });
        continue;
      }

      validRecipients.push({
        phone: normalizedPhone,
        name: nameRaw || null,
        customBody: bodyRaw || null,
      });
    }

    return {
      validRecipients,
      errors,
      totalProcessed: rawRows.length,
    };
  }

  private extractFieldValue(row: Record<string, unknown>, possibleKeys: string[]): string {
    const lowerKeys = possibleKeys.map((k) => k.toLowerCase());
    for (const key of Object.keys(row)) {
      if (lowerKeys.includes(key.trim().toLowerCase())) {
        const val = row[key];
        return val !== undefined && val !== null ? String(val).trim() : "";
      }
    }
    return "";
  }

  private normalizePhone(phone: string): string {
    let clean = phone.replace(/[\s\-\(\)\.]/g, "");
    if (!clean.startsWith("+") && !clean.startsWith("00")) {
      // Si empieza con 0, quitarlo antes de validar (ej: 0999999999 -> 593999999999 o mantenerlo)
      // Mantener dígitos limpios
    }
    if (clean.startsWith("00")) {
      clean = "+" + clean.slice(2);
    }
    return clean;
  }

  private isValidPhone(phone: string): boolean {
    const digitsOnly = phone.replace(/\D/g, "");
    return digitsOnly.length >= 8 && digitsOnly.length <= 15;
  }
}
