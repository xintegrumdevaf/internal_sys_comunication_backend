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

const PHONE_COLUMN_HEADERS = [
  "number",
  "phone",
  "telefono",
  "celular",
  "numero",
  "wa_phone",
  "tel",
];

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

    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    if (matrix.length === 0) {
      return {
        validRecipients: [],
        errors: [{ row: 0, reason: "Hoja de trabajo vacía" }],
        totalProcessed: 0,
      };
    }

    const headersRow = matrix[0] || [];
    const rawFirstHeader = String(headersRow[0] ?? "").trim();
    const cleanFirstHeader = rawFirstHeader.toLowerCase();

    const isFirstColPhoneHeader = PHONE_COLUMN_HEADERS.includes(cleanFirstHeader);

    let sampleValidPhoneCount = 0;
    let sampleTotalCount = 0;
    const sampleRows = matrix.slice(1, 11);
    for (const row of sampleRows) {
      const val = String(row[0] ?? "").trim();
      if (val) {
        sampleTotalCount++;
        const norm = this.normalizePhone(val);
        if (this.isValidPhone(norm)) {
          sampleValidPhoneCount++;
        }
      }
    }

    const isFirstColumnValidPhone =
      isFirstColPhoneHeader ||
      (sampleTotalCount > 0 && sampleValidPhoneCount / sampleTotalCount >= 0.5);

    if (!isFirstColumnValidPhone) {
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      return {
        validRecipients: [],
        errors: [
          {
            row: 1,
            phone: "",
            reason:
              "La primera columna (Columna A) del archivo debe ser la columna de número de teléfono ('number', 'phone', 'telefono', etc.) y tener un formato válido.",
          },
        ],
        totalProcessed: rawRows.length,
      };
    }

    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const validRecipients: CreateRecipientInput[] = [];
    const errors: FileImportError[] = [];

    for (let index = 0; index < rawRows.length; index++) {
      const row = rawRows[index]!;
      const rowNumber = index + 2;

      const keys = Object.keys(row);
      const firstKey = keys[0];
      let phoneRaw = "";
      if (firstKey && row[firstKey] !== undefined && row[firstKey] !== null) {
        phoneRaw = String(row[firstKey]).trim();
      }

      if (!phoneRaw) {
        phoneRaw = this.extractFieldValue(row, PHONE_COLUMN_HEADERS);
      }

      const nameRaw = this.extractFieldValue(row, ["name", "nombre", "contacto"]);
      const bodyRaw = this.extractFieldValue(row, ["body", "custombody", "mensaje", "message"]);

      if (!phoneRaw) {
        errors.push({
          row: rowNumber,
          phone: "",
          reason:
            "La columna de número telefónico en la primera columna ('number', 'phone', 'telefono') es requerida y está vacía",
        });
        continue;
      }

      const normalizedPhone = this.normalizePhone(phoneRaw);
      if (!this.isValidPhone(normalizedPhone)) {
        errors.push({
          row: rowNumber,
          phone: phoneRaw,
          reason:
            "El número telefónico en la primera columna no tiene un formato válido (debe tener entre 8 y 15 dígitos)",
        });
        continue;
      }

      const variables: Record<string, string> = {};
      for (const [key, val] of Object.entries(row)) {
        if (val !== undefined && val !== null) {
          const strVal = String(val).trim();
          const cleanKey = key.trim();
          if (cleanKey && !cleanKey.toLowerCase().startsWith("__empty")) {
            variables[cleanKey] = strVal;
            const strippedKey = cleanKey.replace(/^columna:\s*/i, "").trim();
            if (strippedKey && strippedKey !== cleanKey) {
              variables[strippedKey] = strVal;
            }
          }
        }
      }
      if (nameRaw) {
        variables["name"] = nameRaw;
        variables["nombre"] = nameRaw;
      }
      if (phoneRaw) {
        variables["phone"] = phoneRaw;
        variables["telefono"] = phoneRaw;
      }

      validRecipients.push({
        phone: normalizedPhone,
        name: nameRaw || null,
        customBody: bodyRaw || null,
        variables,
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

