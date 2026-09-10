# Stack de Monitoreo con Prometheus & Grafana

> Para la guía detallada con diagramas, explicaciones de métricas y configuración de alertas, consulta: [docs/MONITORING.md](../../docs/MONITORING.md).

---

## 1. Puesta en marcha rápida

En el servidor o en local:

```bash
cd deploy/monitoring
docker compose -f docker-compose.monitoring.yml up -d
```

* **Prometheus:** `http://localhost:9090` (Revisar targets en `http://localhost:9090/targets`)
* **Grafana:** `http://localhost:3002` (Usuario: `admin`, Clave: `admin`)
* **Node Exporter:** `http://localhost:9100/metrics`

---

## 2. Configuración en Grafana

1. **Data Source:**
   * Ir a **Connections > Data Sources > Add data source > Prometheus**.
   * URL: `http://prometheus:9090`
   * Clic en **Save & test**.
2. **Importar Dashboards:**
   * Ir a **Dashboards > New > Import**.
   * **Dashboard 11159 (Node.js Application):** Event Loop lag, Heap/RSS memory, HTTP QPS, status codes.
   * **Dashboard 1860 (Linux Host):** CPU, RAM física, Disco y Tráfico de Red.
