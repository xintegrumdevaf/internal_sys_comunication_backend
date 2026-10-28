import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CoverageService } from "../../src/core/modules/coverage/application/services/coverage.service";
import { KmlParserService } from "../../src/core/modules/coverage/application/services/kml-parser.service";
import type { CoverageZone } from "../../src/core/modules/coverage/domain/coverage-zone.entity";
import type { CoverageRepositoryPort } from "../../src/core/modules/coverage/domain/coverage.repository.port";

class FakeCoverageRepository implements CoverageRepositoryPort {
  private zones: CoverageZone[] = [];

  public async replaceAll(zones: CoverageZone[]): Promise<void> {
    this.zones = [...zones];
  }

  public async findAllActive(): Promise<CoverageZone[]> {
    return [...this.zones];
  }

  public async count(): Promise<number> {
    return this.zones.length;
  }
}

describe("CoverageService (Point-in-Polygon y Detección de Cobertura)", () => {
  let coverageService: CoverageService;
  let fakeRepo: FakeCoverageRepository;
  let parser: KmlParserService;

  beforeEach(async () => {
    fakeRepo = new FakeCoverageRepository();
    parser = new KmlParserService();
    coverageService = new CoverageService(fakeRepo, parser);

    // Cargar KML real analizado de docs/coverage/cobertura.kml
    const kmlPath = join(process.cwd(), "docs", "coverage", "cobertura.kml");
    const kmlContent = readFileSync(kmlPath, "utf-8");
    await coverageService.importKml(kmlContent);
  });

  it("parsea correctamente las 48 zonas del archivo KML", () => {
    const zones = coverageService.getZones();
    expect(zones.length).toBe(48);

    const chillogallo = zones.find((z) => z.name === "CHILLOGALLO");
    expect(chillogallo).toBeDefined();
    expect(chillogallo?.city).toBe("Quito");
    expect(chillogallo?.coordinates.length).toBeGreaterThan(10);

    const controlSur = zones.find((z) => z.name === "CONTROL SUR");
    expect(controlSur).toBeDefined();
    expect(controlSur?.city).toBe("Cuenca");
  });

  describe("checkCoordinates (Point-in-Polygon)", () => {
    it("detecta cobertura en Chillogallo (Quito Sur)", () => {
      // Coordenadas conocidas dentro del polígono de Chillogallo
      const result = coverageService.checkCoordinates(-0.2781, -78.5581);
      expect(result.hasCoverage).toBe(true);
      expect(result.zoneName).toBe("CHILLOGALLO");
      expect(result.city).toBe("Quito");
      expect(result.matchType).toBe("exact_coordinates");
    });

    it("detecta cobertura en Control Sur (Cuenca)", () => {
      // Coordenadas conocidas dentro de Control Sur en Cuenca
      const result = coverageService.checkCoordinates(-2.9105, -79.0402);
      expect(result.hasCoverage).toBe(true);
      expect(result.zoneName).toBe("CONTROL SUR");
      expect(result.city).toBe("Cuenca");
    });

    it("detecta cobertura en Zona Pomasqui (Quito Norte)", () => {
      const result = coverageService.checkCoordinates(-0.0524, -78.4553);
      expect(result.hasCoverage).toBe(true);
      expect(result.zoneName).toBe("ZONA POMASQUI");
      expect(result.city).toBe("Quito");
    });

    it("rechaza punto fuera de cobertura (ej: Guayaquil u océano)", () => {
      // Guayaquil (~ -2.18, -79.88)
      const result = coverageService.checkCoordinates(-2.1894, -79.889);
      expect(result.hasCoverage).toBe(false);
      expect(result.matchType).toBe("none");
      expect(result.reason).toContain("fuera del área de cobertura");
    });
  });

  describe("checkLocation con URLs y formatos variados", () => {
    it("extrae coordenadas de link de Google Maps y valida cobertura", () => {
      const url = "https://maps.google.com/?q=-0.278117,-78.558104";
      const result = coverageService.checkLocation({ locationUrl: url });
      expect(result.hasCoverage).toBe(true);
      expect(result.zoneName).toBe("CHILLOGALLO");
    });

    it("extrae coordenadas numéricas incrustadas en texto", () => {
      const text = "Hola, mi casa queda en -0.2781, -78.5581 por favor díganme si tienen fibra";
      const result = coverageService.checkLocation({ text });
      expect(result.hasCoverage).toBe(true);
      expect(result.zoneName).toBe("CHILLOGALLO");
    });

    it("reconoce cobertura preliminar por mención de sector en texto plano", () => {
      const text = "Buenas tardes, quisiera saber si tienen servicio en el sector de Chillogallo";
      const result = coverageService.checkLocation({ text });
      expect(result.hasCoverage).toBe(true);
      expect(result.zoneName).toBe("CHILLOGALLO");
      expect(result.city).toBe("Quito");
      expect(result.matchType).toBe("text_sector_match");
    });

    it("indica falta de cobertura si el sector no figura en los polígonos", () => {
      const text = "Vivo en Ibarra en el centro";
      const result = coverageService.checkLocation({ text });
      expect(result.hasCoverage).toBe(false);
      expect(result.matchType).toBe("none");
    });
  });
});
