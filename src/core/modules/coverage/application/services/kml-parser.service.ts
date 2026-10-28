import type { CoverageZone, GeoCoordinate } from "../../domain/coverage-zone.entity";
import { calculateBBox } from "./point-in-polygon";

export class KmlParserService {
  /**
   * Parsea un archivo KML en texto y extrae las zonas de cobertura perimetrales.
   */
  public parseKml(kmlContent: string): CoverageZone[] {
    if (!kmlContent || typeof kmlContent !== "string") {
      throw new Error("El contenido KML es requerido y debe ser una cadena de texto");
    }

    const zones: CoverageZone[] = [];

    // Extraer carpetas o placemarks
    const folderRegex = /<Folder>([\s\S]*?)<\/Folder>/gi;
    let folderMatch: RegExpExecArray | null;

    let parsedInsideFolders = false;

    while ((folderMatch = folderRegex.exec(kmlContent)) !== null) {
      parsedInsideFolders = true;
      const folderXml = folderMatch[1] ?? "";
      const folderNameMatch = folderXml.match(/<name>(.*?)<\/name>/i);
      const folderName = folderNameMatch?.[1] ? folderNameMatch[1].trim() : undefined;

      const placemarks = this.extractPlacemarks(folderXml, folderName);
      zones.push(...placemarks);
    }

    // Si no había etiquetas <Folder>, parsear directamente a nivel de Document
    if (!parsedInsideFolders || zones.length === 0) {
      const placemarks = this.extractPlacemarks(kmlContent);
      zones.push(...placemarks);
    }

    if (zones.length === 0) {
      throw new Error("No se encontraron zonas o polígonos válidos en el archivo KML provisto");
    }

    return zones;
  }

  private extractPlacemarks(xmlSnippet: string, folderName?: string): CoverageZone[] {
    const placemarkRegex = /<Placemark[\s\S]*?>([\s\S]*?)<\/Placemark>/gi;
    const result: CoverageZone[] = [];
    let match: RegExpExecArray | null;

    while ((match = placemarkRegex.exec(xmlSnippet)) !== null) {
      const pXml = match[1] ?? "";

      // Nombre del Placemark
      const nameMatch = pXml.match(/<name>(.*?)<\/name>/i);
      const name = nameMatch?.[1] ? nameMatch[1].trim() : "Zona sin nombre";

      // Coordenadas del polígono
      const coordMatch = pXml.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
      if (!coordMatch?.[1]) {
        continue;
      }

      const rawCoordinatesText = coordMatch[1].trim();
      const coordinateStrings = rawCoordinatesText.split(/\s+/);

      const coordinates: GeoCoordinate[] = [];
      for (const coordStr of coordinateStrings) {
        if (!coordStr) continue;
        const parts = coordStr.split(",");
        const p0 = parts[0];
        const p1 = parts[1];
        if (p0 !== undefined && p1 !== undefined) {
          const lng = Number.parseFloat(p0);
          const lat = Number.parseFloat(p1);
          if (!Number.isNaN(lng) && !Number.isNaN(lat)) {
            coordinates.push([lng, lat]);
          }
        }
      }

      // Requiere al menos 3 vértices para formar un polígono
      if (coordinates.length < 3) {
        continue;
      }

      // Asegurar que el polígono esté cerrado (primer vértice == último vértice)
      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];
      if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
        coordinates.push([first[0], first[1]]);
      }

      const bbox = calculateBBox(coordinates);
      const city = this.inferCity(name, folderName, bbox);

      result.push({
        name,
        folder: folderName,
        city,
        coordinates,
        bbox,
        active: true,
      });
    }

    return result;
  }

  /**
   * Deduce la ciudad basándose en coordenadas geográficas de Ecuador
   * o en el nombre de la parroquia / sector.
   */
  private inferCity(name: string, folder: string | undefined, bbox: ReturnType<typeof calculateBBox>): string {
    const combined = `${name} ${folder ?? ""}`.toLowerCase();

    if (/cuenca|sinincay|totoracocha|ricaurte|canaribamba|monay|bellavista|machangara|san sebastian/i.test(combined)) {
      return "Cuenca";
    }

    if (/quito|chillogallo|san roque|pomasqui|calacali|pifo|moran|bicentenario|gatazo|rumicucho|caspigasi/i.test(combined)) {
      return "Quito";
    }

    // Deducción por coordenadas en Ecuador:
    // Cuenca se ubica aproximadamente en latitud -2.85 a -2.95
    // Quito se ubica aproximadamente en latitud -0.35 a 0.05
    const centerLat = (bbox.minLat + bbox.maxLat) / 2;
    if (centerLat < -1.5) {
      return "Cuenca";
    }
    if (centerLat > -0.6) {
      return "Quito";
    }

    return "General";
  }
}
