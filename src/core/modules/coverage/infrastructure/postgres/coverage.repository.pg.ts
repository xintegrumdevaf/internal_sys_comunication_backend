import type { Pool } from "pg";
import type { CoverageZone, GeoBoundingBox, GeoCoordinate } from "../../domain/coverage-zone.entity";
import type { CoverageRepositoryPort } from "../../domain/coverage.repository.port";

interface CoverageZoneRow {
  id: string;
  name: string;
  folder: string | null;
  city: string;
  coordinates: GeoCoordinate[];
  bbox: GeoBoundingBox;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export class CoverageRepositoryPg implements CoverageRepositoryPort {
  constructor(private readonly pool: Pool) {}

  public async replaceAll(zones: CoverageZone[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Desactivar o limpiar zonas previas
      await client.query("DELETE FROM coverage_zone");

      if (zones.length > 0) {
        for (const zone of zones) {
          await client.query(
            `INSERT INTO coverage_zone (name, folder, city, coordinates, bbox, active, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())`,
            [
              zone.name,
              zone.folder ?? null,
              zone.city,
              JSON.stringify(zone.coordinates),
              JSON.stringify(zone.bbox),
              zone.active,
            ],
          );
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async findAllActive(): Promise<CoverageZone[]> {
    const { rows } = await this.pool.query<CoverageZoneRow>(
      `SELECT id, name, folder, city, coordinates, bbox, active, created_at, updated_at
       FROM coverage_zone
       WHERE active = true
       ORDER BY city ASC, name ASC`,
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      folder: r.folder ?? undefined,
      city: r.city,
      coordinates: typeof r.coordinates === "string" ? JSON.parse(r.coordinates) : r.coordinates,
      bbox: typeof r.bbox === "string" ? JSON.parse(r.bbox) : r.bbox,
      active: r.active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public async count(): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      "SELECT count(*) as total FROM coverage_zone WHERE active = true",
    );
    return Number.parseInt(rows[0]?.total ?? "0", 10);
  }
}
