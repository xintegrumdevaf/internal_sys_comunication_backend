import type { GeoBoundingBox, GeoCoordinate } from "../../domain/coverage-zone.entity";

/**
 * Calcula la caja delimitadora (Bounding Box) de un conjunto de coordenadas [lng, lat].
 */
export function calculateBBox(ring: GeoCoordinate[]): GeoBoundingBox {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const [lng, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Chequeo O(1) de caja delimitadora. Si el punto cae fuera del rectángulo,
 * se descarta inmediatamente sin necesidad de ejecutar el algoritmo perimetral.
 */
export function isPointInBBox(
  point: { lat: number; lng: number },
  bbox: GeoBoundingBox,
): boolean {
  return (
    point.lat >= bbox.minLat &&
    point.lat <= bbox.maxLat &&
    point.lng >= bbox.minLng &&
    point.lng <= bbox.maxLng
  );
}

/**
 * Algoritmo Ray-Casting (Teorema de la Curva de Jordan) para Point-in-Polygon (PIP).
 * Evalúa si un punto { lat, lng } se encuentra contenido dentro de un polígono perimetral.
 * 
 * @param point { lat, lng } punto a consultar
 * @param ring Array de coordenadas [longitud, latitud] que forman el contorno cerrado
 */
export function isPointInPolygon(
  point: { lat: number; lng: number },
  ring: GeoCoordinate[],
): boolean {
  const x = point.lng;
  const y = point.lat;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ptI = ring[i];
    const ptJ = ring[j];
    if (!ptI || !ptJ) continue;

    const [xi, yi] = ptI;
    const [xj, yj] = ptJ;

    // Verifica si el rayo horizontal que sale desde (x, y) cruza el segmento (i, j)
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}
