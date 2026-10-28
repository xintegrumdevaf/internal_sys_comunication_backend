import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverageCheckResult, CoverageZone } from "../../domain/coverage-zone.entity";
import type { CoverageRepositoryPort } from "../../domain/coverage.repository.port";
import { isPointInBBox, isPointInPolygon } from "./point-in-polygon";
import type { KmlParserService } from "./kml-parser.service";

export interface CheckLocationInput {
  lat?: number;
  lng?: number;
  text?: string;
  locationUrl?: string;
}

export class CoverageService {
  private activeZones: CoverageZone[] = [];
  private initialized = false;

  constructor(
    private readonly repository: CoverageRepositoryPort,
    private readonly parser: KmlParserService,
  ) {}

  /**
   * Inicializa la memoria cargando los polígonos desde la base de datos PostgreSQL.
   * Si la tabla está vacía y existe el archivo inicial en docs/coverage/cobertura.kml,
   * lo parsea y persiste como semilla inicial.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    let zones = await this.repository.findAllActive();

    if (zones.length === 0) {
      const fallbackKmlPath = join(process.cwd(), "docs", "coverage", "cobertura.kml");
      if (existsSync(fallbackKmlPath)) {
        try {
          const rawKml = readFileSync(fallbackKmlPath, "utf-8");
          const parsed = this.parser.parseKml(rawKml);
          if (parsed.length > 0) {
            await this.repository.replaceAll(parsed);
            zones = parsed;
          }
        } catch (error) {
          console.warn("[CoverageService] No se pudo cargar el KML inicial de semilla:", error);
        }
      }
    }

    this.activeZones = zones;
    this.initialized = true;
  }

  /**
   * Retorna la lista en memoria de zonas activas.
   */
  public getZones(): CoverageZone[] {
    return this.activeZones;
  }

  /**
   * Reemplaza las zonas en base de datos y recarga atómicamente la memoria.
   */
  public async importKml(kmlContent: string): Promise<{ importedCount: number; zones: CoverageZone[] }> {
    const zones = this.parser.parseKml(kmlContent);
    await this.repository.replaceAll(zones);
    this.activeZones = zones;
    this.initialized = true;
    return {
      importedCount: zones.length,
      zones,
    };
  }

  /**
   * Recarga forzada de la memoria desde la base de datos.
   */
  public async reload(): Promise<void> {
    this.activeZones = await this.repository.findAllActive();
    this.initialized = true;
  }

  /**
   * Consulta centralizada de cobertura soportando coordenadas exactas, URL de mapa o texto plano.
   */
  public checkLocation(input: CheckLocationInput): CoverageCheckResult {
    // 1. Coordenadas explícitas directas
    if (typeof input.lat === "number" && typeof input.lng === "number") {
      return this.checkCoordinates(input.lat, input.lng);
    }

    // 2. Extraer de URL de mapa o ubicación si se proporciona
    if (input.locationUrl) {
      const coords = this.extractCoordinatesFromUrl(input.locationUrl);
      if (coords) {
        return this.checkCoordinates(coords.lat, coords.lng);
      }
    }

    // 3. Extraer de texto si contiene coordenadas numéricas o link
    if (input.text && input.text.trim()) {
      const rawText = input.text.trim();

      // Chequeo de URL incrustada en el texto
      const urlMatch = rawText.match(/(https?:\/\/[^\s]+)/i);
      const matchedUrl = urlMatch?.[1];
      if (matchedUrl) {
        const coords = this.extractCoordinatesFromUrl(matchedUrl);
        if (coords) {
          return this.checkCoordinates(coords.lat, coords.lng);
        }
      }

      // Chequeo de coordenadas tipo "-0.2781, -78.5581"
      const coordMatch = rawText.match(/([-+]?\d{1,2}\.\d+)\s*,\s*([-+]?\d{1,3}\.\d+)/);
      if (coordMatch?.[1] && coordMatch[2]) {
        const lat = Number.parseFloat(coordMatch[1]);
        const lng = Number.parseFloat(coordMatch[2]);
        if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
          return this.checkCoordinates(lat, lng);
        }
      }

      // 4. Si es texto plano sin coordenadas, buscar coincidencia por nombre de sector/zona
      return this.checkText(rawText);
    }

    return {
      hasCoverage: false,
      reason: "No se proporcionaron coordenadas ni dirección válida para consultar cobertura",
    };
  }

  /**
   * Evaluación de coordenadas matemáticas contra los polígonos perimetrales.
   * Ejecuta en memoria en < 0.2ms.
   */
  public checkCoordinates(lat: number, lng: number): CoverageCheckResult {
    const point = { lat, lng };

    for (const zone of this.activeZones) {
      // 1. Descarte rápido O(1) con Bounding Box
      if (!isPointInBBox(point, zone.bbox)) {
        continue;
      }

      // 2. Cálculo exacto Point-in-Polygon (Ray casting)
      if (isPointInPolygon(point, zone.coordinates)) {
        return {
          hasCoverage: true,
          zoneName: zone.name,
          city: zone.city,
          folder: zone.folder,
          matchType: "exact_coordinates",
        };
      }
    }

    return {
      hasCoverage: false,
      matchType: "none",
      reason: `Las coordenadas (${lat.toFixed(5)}, ${lng.toFixed(5)}) se encuentran fuera del área de cobertura actual`,
    };
  }

  /**
   * Búsqueda heurística por nombre de sector/zona cuando el cliente escribe texto plano.
   */
  public checkText(rawText: string): CoverageCheckResult {
    const normalizedQuery = this.normalizeString(rawText);

    for (const zone of this.activeZones) {
      const cleanZoneName = this.normalizeString(
        zone.name.replace(/^(pol[ií]gono|zona)\s+/i, ""),
      );

      if (cleanZoneName.length >= 4 && normalizedQuery.includes(cleanZoneName)) {
        return {
          hasCoverage: true,
          zoneName: zone.name,
          city: zone.city,
          folder: zone.folder,
          matchType: "text_sector_match",
        };
      }
    }

    return {
      hasCoverage: false,
      matchType: "none",
      reason: `No se identificó cobertura directa para la dirección '${rawText}'. Se sugiere solicitar ubicación GPS exacta.`,
    };
  }

  private extractCoordinatesFromUrl(url: string): { lat: number; lng: number } | null {
    // Patrón 1: maps.google.com/?q=-0.28,-78.49 o @-0.28,-78.49
    const match = url.match(/[@=]([-+]?\d{1,2}\.\d+),([-+]?\d{1,3}\.\d+)/);
    if (match?.[1] && match[2]) {
      const lat = Number.parseFloat(match[1]);
      const lng = Number.parseFloat(match[2]);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        return { lat, lng };
      }
    }
    return null;
  }

  private normalizeString(str: string): string {
    return str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }
}
