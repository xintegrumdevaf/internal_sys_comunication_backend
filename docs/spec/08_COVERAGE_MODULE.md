# 08_COVERAGE_MODULE — Cobertura Geográfica y Factibilidad en Ventas

Módulo de verificación determinista de cobertura de red de fibra óptica basado en polígonos perimetrales KML/KMZ para la atención omnicanal de ventas.

---

## 1. Motivo del Negocio y Problemática

En un ISP (Proveedor de Servicios de Internet), el embudo comercial que ingresa por WhatsApp presenta un cuello de botella crítico:
1. **Riesgo de alucinación del LLM**: Un modelo de lenguaje generativo no posee conciencia espacial exacta ni sabe si una calle o poste específico cuenta con cajas de distribución óptica (NAP) disponibles. Si la IA "adivina" o "promete" cobertura a un cliente, se generan órdenes de venta fallidas, visitas técnicas desperdiciadas y frustración en el prospecto.
2. **Carga innecesaria a asesores humanos de ventas**: Derivar a un asesor de ventas a un prospecto que vive en una ciudad o sector sin red de fibra satura la bandeja operativa con leads inviables.
3. **Variabilidad en cómo el cliente envía su ubicación**: Los usuarios de WhatsApp no siempre envían su dirección en el mismo formato; pueden enviar:
   - El **pin de ubicación GPS nativo** de WhatsApp.
   - Un enlace de **Google Maps** o coordenadas numéricas (`-0.2781, -78.5581`).
   - Una **dirección textual** ("Vivo en Chillogallo, frente al parque").

### Regla de Oro Arquitectónica
Siguiendo los no-negociables de [`docs/spec/00_OVERVIEW.md`](./00_OVERVIEW.md) y [`AGENTS.md`](../../AGENTS.md):
> **La IA NUNCA decide la factibilidad de cobertura ni transiciones de negocio.**  
> La IA únicamente interpreta el lenguaje para extraer la ubicación/dirección/coordenadas. La decisión de si hay cobertura es **100% matemática, determinista y auditable**, ejecutada por el backend mediante algoritmos de geometría computacional (*Point-in-Polygon*).

---

## 2. Decisiones de Arquitectura y Trade-offs

### 2.1. Algoritmo Espacial: Ray-Casting puro en TypeScript vs PostGIS pesado
* **Decisión**: Implementar el algoritmo **Ray-Casting (Teorema de la Curva de Jordan)** con pre-filtrado por **Bounding Box O(1)** en TypeScript nativo ([`point-in-polygon.ts`](../../src/core/modules/coverage/application/services/point-in-polygon.ts)).
* **Trade-off evaluado**:
  - *PostGIS*: Requeriría cambiar la imagen Docker base (`pgvector/pgvector:pg16` por una con GEOS/GDAL/PROJ compilados), aumentando el peso de la imagen en ~500MB y agregando complejidad de dependencias C en desarrollo local.
  - *Ray-Casting en TypeScript*: Para un catálogo de decenas o cientos de polígonos perimetrales (la red de XGO cuenta con 48 polígonos), el cálculo espacial toma **menos de 0.2 milisegundos** por consulta en memoria. Cero dependencias nativas externas, portabilidad total y rendimiento ultrasónico.

### 2.2. Almacenamiento y Caché en Memoria vs Lectura en Caliente de Disco
* **Decisión**: Persistir los polígonos en PostgreSQL (tabla `coverage_zone`) y mantener una **caché en memoria viva** en [`CoverageService`](../../src/core/modules/coverage/application/services/coverage.service.ts).
* **Trade-off evaluado**:
  - *Lectura de disco en cada mensaje*: Descomprimir o parsear un archivo XML/KML en cada webhook entrante añade latencia de I/O bloqueante (50-200ms) y consumo inútil de CPU.
  - *Caché en memoria*: La consulta ocurre en microsegundos. Al levantarse el servidor, [`CoverageService.init()`](../../src/core/modules/coverage/application/services/coverage.service.ts) carga las zonas activas. Cuando se sube una nueva versión, se reemplazan atómicamente en PostgreSQL y se recarga la memoria instantáneamente (*hot-reload*).

### 2.3. Carga Operativa vía Panel de Admin vs Scripts SSH / DevOps
* **Decisión**: Exponer endpoints protegidos para rol `admin` (`POST /api/admin/coverage/import-kml` y `POST /api/admin/coverage/reload`).
* **Motivo**:
  - Los archivos de red de fibra óptica son mantenidos por el equipo de **Planta Externa / GIS** cada varios meses conforme se abren nuevos sectores o cajas NAP.
  - Si la actualización requiriera intervención de un desarrollador o comandos SSH en consola, se genera una fricción operativa innecesaria. Con el endpoint, el supervisor o ingeniero de GIS sube el archivo directamente desde el panel administrativo.

---

## 3. Modelo de Datos (`coverage_zone`)

Migración: [`migrations/0036_coverage_zones.sql`](../../migrations/0036_coverage_zones.sql).

```sql
CREATE TABLE IF NOT EXISTS coverage_zone (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  folder      TEXT,
  city        TEXT NOT NULL,
  coordinates JSONB NOT NULL,
  bbox        JSONB NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coverage_zone_city ON coverage_zone (city);
CREATE INDEX IF NOT EXISTS idx_coverage_zone_active ON coverage_zone (active);
```

### Campos:
* `name`: Nombre de la zona o polígono (ej. `CHILLOGALLO`, `ZONA POMASQUI`, `CONTROL SUR`).
* `folder`: Agrupación del KML (ej. `PARROQUIAS`, `ZONIFICACION`, `LIMITES`).
* `city`: Ciudad deducida o configurada (`Quito`, `Cuenca`, etc.).
* `coordinates`: Array de vértices `[[lng, lat], [lng, lat], ...]`.
* `bbox`: Objeto `{ minLat, maxLat, minLng, maxLng }` para descarte rápido en O(1).

---

## 4. Ciclo de Vida en el Flujo de Ventas (`SALES`)

Ubicación: [`sales.workflow.ts`](../../src/core/modules/cases/application/engine/definitions/sales.workflow.ts).

```text
[Cliente expresa intención comercial: sales.packages]
                        │
                        ▼
            COLLECT_PREFERENCE
                        │
       ¿Cliente ya dio ubicación o GPS?
        ├── NO ────────────────────────────────────────────────────────┐
        │                                                              │
        ▼                                                              ▼
WAITING_USER_LOCATION                                          (Evalúa ubicación)
(Pregunta al cliente: "Para verificar cobertura,                       │
 por favor envíanos tu dirección o ubicación de WhatsApp 📎")           │
        │                                                              │
        ▼ (Cliente responde)                                           │
  waitingLocation ─────────────────────────────────────────────────────┘
                        │
                        ▼
           coverageService.checkLocation()
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
 [hasCoverage: true]             [hasCoverage: false]
        │                               │
        ▼                               ▼
  QUERY_PLANS                      NO_COVERAGE
 (Consulta planes con RAG)              │
        │                               ▼
        ▼                           COMPLETED
  RESPOND_OFFER                  (Informa amablemente
        │                         que no hay red aún
        ▼                         y guarda el lead)
    ESCALATED
(Asigna a Ventas
 para cierre humano)
```

---

## 5. Endpoints de la API

| Método | Endpoint | Acceso | Descripción |
|---|---|---|---|
| `GET` | `/api/coverage/zones` | Público / Sesión | Retorna listado de zonas activas, ciudades y centros perimetrales. |
| `POST` | `/api/coverage/check` | Público / Sesión | Consulta factibilidad enviando `{ lat, lng }`, `{ address }` o `{ locationUrl }`. |
| `POST` | `/api/admin/coverage/import-kml` | `role: admin` | Sube un archivo KML (`multipart/form-data`) o XML crudo y actualiza la red. |
| `POST` | `/api/admin/coverage/reload` | `role: admin` | Fuerza la recarga del índice espacial en memoria desde PostgreSQL. |
