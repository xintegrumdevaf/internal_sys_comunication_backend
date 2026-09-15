import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { CampaignFileParserService } from "../../src/core/modules/campaigns/application/services/campaign-file-parser.service";

describe("CampaignFileParserService", () => {
  const parser = new CampaignFileParserService();

  it("parsea correctamente un archivo xlsx con filas válidas e inválidas", () => {
    const data = [
      { number: "+593999999991", name: "Juan Pérez", body: "Hola Juan" },
      { number: "0999999992", name: "Maria Lopez" },
      { number: "123", name: "Numero Corto" }, // Inválido (menos de 8 dígitos)
      { number: "", name: "Sin Numero" }, // Inválido (columna número vacía)
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Hoja1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = parser.parseBuffer(buffer);

    expect(result.totalProcessed).toBe(4);
    expect(result.validRecipients).toHaveLength(2);
    expect(result.validRecipients[0]).toEqual({
      phone: "+593999999991",
      name: "Juan Pérez",
      customBody: "Hola Juan",
      variables: expect.any(Object),
    });
    expect(result.validRecipients[1]).toEqual({
      phone: "0999999992",
      name: "Maria Lopez",
      customBody: null,
      variables: expect.any(Object),
    });

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.row).toBe(4);
    expect(result.errors[0]?.reason).toContain("formato válido");
    expect(result.errors[1]?.row).toBe(5);
    expect(result.errors[1]?.reason).toContain("requerida");
  });

  it("soporta nombres alternativos de columna como 'telefono' y 'mensaje' en la primera columna", () => {
    const data = [
      { telefono: "0987654321", nombre: "Carlos", mensaje: "Mensaje personalizado" },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Hoja1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "csv" });

    const result = parser.parseBuffer(buffer);

    expect(result.validRecipients).toHaveLength(1);
    expect(result.validRecipients[0]).toEqual({
      phone: "987654321",
      name: "Carlos",
      customBody: "Mensaje personalizado",
      variables: expect.any(Object),
    });
  });

  it("rechaza archivos donde la primera columna no sea de número telefónico (ej: CASH)", () => {
    const data = [
      { CASH: "", NAME: "22 A prueba 1" },
      { CASH: "", NAME: "23 A prueba 2" },
      { CASH: "", NAME: "24 A prueba 3" },
      { CASH: "", NAME: "25 A prueba 4" },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Hoja1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = parser.parseBuffer(buffer);

    expect(result.validRecipients).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toContain("primera columna");
  });

  it("rechaza archivos donde la columna de teléfono esté en una posición posterior a la primera", () => {
    const data = [
      { NAME: "Juan Pérez", NUMBER: "+593999999991" },
      { NAME: "Maria Lopez", NUMBER: "+593999999992" },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Hoja1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = parser.parseBuffer(buffer);

    expect(result.validRecipients).toHaveLength(0);
    expect(result.errors[0]?.reason).toContain("primera columna");
  });
});

