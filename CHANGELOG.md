# Changelog

All notable changes to this project will be documented in this file.

## [0.2.15] - 2026-11-12

### Added & Improved
- **Módulo Telegram Ops & Centinela Ejecutivo (`src/core/modules/telegram`)**: Implementación completa de supervisión operativa por Telegram Bot API con arquitectura hexagonal:
  - **Gateway HTTP resiliente (`TelegramGatewayHttp`)**: Resolución dinámica de `botToken` mediante `getToken` (leyendo cambios guardados sin reiniciar el proceso e ignorando tokens enmascarados `•`/`*`), autodetección de grupos recientes (`getRecentChats`), manejo automático de migración de grupo a supergrupo (`migrate_to_chat_id` con auto-persistencia en `defaultChatId`) y fallback automático a texto plano cuando Telegram rechaza formato HTML (`400 Bad Request` por entidades).
  - **Centinela Reactivo (`TelegramAlertWatcherService`, `CheckSystemAlertsUseCase`, `AlertCooldownCacheService`)**: Evaluación periódica de brechas SLA (`SLA`), caídas masivas por sector/OLT (`INFRASTRUCTURE`) y saturación de colas (`QUEUE`) con reglas configurables (`alertRules`), simulación por categoría (`/api/admin/settings/telegram/test-alert`) y deduplicación por cooldown.
  - **Pulso Operativo Programado (`TelegramDigestSchedulerService`, `SendTelegramDigestUseCase`)**: Programación horaria por zona horaria (`timeZone`, default `America/Guayaquil`) con sondeo cada 15 segundos, verificación inicial al segundo 1 tras arranque, ventana de tolerancia de 3 minutos (`graceMinutes: 3`) y lock distribuido en Redis (`telegram:digest-slot:*`) para evitar pérdidas ante reinicios o duplicados entre réplicas.
  - **Webhook Bidireccional & Copilot IA (`POST /api/v1/telegram/webhook`, `HandleTelegramWebhookUseCase`, `TelegramAiCopilotAdapter`, `AnswerTelegramCopilotQuestionUseCase`)**: Soporte de comandos (`/resumen`, `/sla`, `/agentes`) y botones interactivos. Clasificación semántica con IA cubriendo métricas comerciales/ventas, facturación, soporte técnico, FCR y desglose por departamentos; grounding determinístico en PostgreSQL (conteo global de atención humana activa y asesores disponibles reales) y sanitización/balanceo de HTML con `sanitizeTelegramHtml`.
  - **Snapshot Ejecutivo Web (`GET /analitica`, `/analitica/snapshot`) y Redirecciones SPA**: Panel HTML oscuro responsivo en tiempo real (con soporte `?format=json`) y redirecciones HTTP `302` desde `/cases/:caseId`, `/bandeja` y `/configuracion` hacia `frontendUrl`.
  - **Endpoints de Administración (`/api/admin/settings/telegram/*`)**: Gestión completa de credenciales, detección de chat, pruebas de conexión/temas/alertas, disparo manual de pulso y registro de webhook.
- **Calidad, CI/CD, Documentación y Seguridad**:
  - Extracción de estilos y renderizado HTML del snapshot en `telegram-snapshot.styles.ts` y `telegram-snapshot.renderer.ts` (cumpliendo regla `max-lines <= 400` y escape HTML con `escapeTelegramHtml`), y helpers dedicados en `telegram-formatting.helper.ts`.
  - Validación de `pnpm run lint` y `pnpm run build:prod` incorporada al pipeline `.github/workflows/deploy.yml`, sincronización de `docs/FOLDER_STRUCTURE.md`, limpieza de warnings ESLint no destructivos y eliminación del archivo residual `Untitled` del seguimiento de Git.

### Fixed
- **Alertas de Infraestructura OLT (`AnalyticsRepositoryPg.getInfrastructureAlerts`)**: Exclusión de registros con sector nulo o vacío para evitar falsas detecciones de corte masivo en reportes y snapshots.
- **Saturación de pool PostgreSQL y N+1 en bandeja (`list-conversations.use-case.ts`, `case.repository.pg.ts`, `pool.ts`)**: Carga en lote de casos activos y estado de automatización mediante `ANY($1::uuid[])` (`listByConversationIds`, `getAutomationStatesByCaseIds`) e índices `Map` para agentes y departamentos (eliminando consultas secuenciales N+1 por conversación) y ampliación de pool a `PG_POOL_MAX || 20` con `idleTimeoutMillis: 30000`.
- **Control de memoria en caché multimedia y limpieza SSE (`conversations.router.ts`, `realtime.router.ts`)**: Límite de memoria en `mediaMemoryCache` (máximo 64 entradas, 32 MB totales y 4 MB por archivo con expulsión FIFO) y limpieza idempotente de suscriptores SSE ante cierre de `req`/`res` o fallo de escritura.
- **Fallback automático a General para casos no clasificados (`general-department.helper.ts`, `department-routing.service.ts`, `department-resolver.service.ts`, `escalation.service.ts`, migración `0049_route_unclassified_to_general.sql`)**: Cualquier caso o escalación sin coincidencia de intención/flujo (`MAX_CLARIFY_ATTEMPTS_EXCEEDED`, `REQUEST_HUMAN` sin área, `UNSUPPORTED`, `EXTERNAL_SERVICE_ERROR`) cae automáticamente al departamento `general` como `GENERAL_INQUIRY` habilitando su cola y auto-asignación de agentes para evitar casos estancados en "Sin clasificar" con alarmas de SLA, más saneamiento SQL idempotente para registros existentes.
- **Visibilidad del motivo real de escalación (`list-conversations.use-case.ts`, `search-conversations.use-case.ts`, `conversations.router.ts`, `escalation.service.ts`)**: Exposición de `disabledReason` dentro de `activeCase` y preservación del motivo original (`AI_ERROR`, `MAX_CLARIFY_ATTEMPTS_EXCEEDED`, `EXTERNAL_SERVICE_ERROR`, `TIMEOUT`, `REQUEST_HUMAN`) cuando el caso se auto-asigna a un asesor humano.
- **Interpretación semántica y anti-bucle natural post-cierre para emojis, stickers y cortesías (`process-buffered-messages.use-case.ts`, `parse-whatsapp-webhook.ts`, `parse-zernio-webhook.ts`, `interpret-message.prompt.ts`, `compose-reply.prompt.ts`, `compose-customer-reply.use-case.ts`)**: Soporte completo de mensajes tipo `sticker` sin confundirlos con comprobantes ni cadenas vacías; eliminación de listas fijas de emojis y plantillas mecánicas repetitivas para que la IA interprete el propósito real del mensaje y redacte una única despedida cálida y natural contextualizada (`CLOSING_ACKNOWLEDGMENT`); silencio absoluto ante reacciones, stickers o agradecimientos repetidos cuando ya se envió el cierre previo.
- **Detección robusta de comprobantes de pago y circuit breaker anti-bucle (`process-buffered-messages.use-case.ts`)**: Reconocimiento resiliente de comprobantes cuando el cliente adjunta una imagen o documento y la intención o texto refiere al pago (incluso si el OCR falla o si el cliente hace referencia a un comprobante enviado en el historial reciente), extracción directa de cédula desde el texto del lote actual, y circuit breaker que escala a un asesor humano de cartera ante respuestas sin comprobante en lugar de repetir la plantilla en bucle infinito.
- **Resolución dinámica de métodos de pago vía RAG y promesas de pago (`billing-balance.workflow.ts`, `interpret-message.prompt.ts`, `intent-catalog.ts`)**: Eliminación definitiva de plantillas estáticas con números de cuenta bancaria quemados; integración directa con RAG para consulta documental actualizada y escalamiento seguro a Facturación (`UNANSWERED_PAYMENT_METHODS`) si no hay respuesta documental; nuevo intent `billing.payment_agreement` para solicitudes de prórroga/espera (ej. "ayúdeme para cancelar hasta el 15") derivando a agentes de cartera sin exigir fotos de comprobante; y conmutación dinámica de propósito (`resolvePurpose`) para no bloquear consultas de cuentas bancarias en flujos de consulta de saldo.
- **Limpieza de contador no leído y eventos en tiempo real al seleccionar conversaciones (`mark-conversation-as-read.use-case.ts`, `conversations.router.ts`, `conversation.repository.pg.ts`)**: Ejecución automática de `markAsRead` al abrir el detalle de mensajes en la bandeja, emisión del evento SSE `MESSAGE_STATUS_UPDATED` para sincronización visual instantánea en la barra lateral sin recargar página, y exclusión de mensajes de auditoría del sistema (`author = 'system'`) de los snippets de búsqueda.

## [0.2.14] - 2026-11-11

- **Eliminación de Falsos Positivos de Envío por Fallback Silencioso a Meta Cloud API (`container.ts`, `zernio-sender.http.ts`, `dynamic-whatsapp-sender.ts`)**:
  - *Contexto y Problema*:
    Cuando la API de Zernio rechazaba un mensaje (por ejemplo, por límite de tasa `429 Too Many Requests`), el sistema informaba internamente `"Zernio API rechazó el envío (ej. TEMPLATE_REQUIRED); entregando directamente vía Meta Cloud API..."`, devolviendo un estado HTTP `201 Created` (`"respuesta de agente enviada por whatsapp"`). En la interfaz de usuario el mensaje figuraba como exitosamente enviado al cliente con doble check. Sin embargo, en el entorno de producción la funcionalidad de Meta Cloud API se encuentra bloqueada / no enlazada a la línea real, por lo que el cliente final jamás recibía el mensaje de WhatsApp, generando un falso positivo operativo crítico.
  - *Causa Raíz*:
    1. En el composition root (`container.ts`), la instancia de `metaSender` se inyectaba incondicionalmente como `fallbackSender` dentro del constructor de `ZernioSenderHttp`.
    2. Ante cualquier fallo de Zernio (incluso saturación temporal `429 Rate Limit`), `ZernioSenderHttp` desviaba el tráfico de forma encubierta a la API Graph de Meta (`https://graph.facebook.com/v20.0/...`).
    3. Al existir credenciales de prueba en el entorno, Meta Cloud API respondía con un identificador de mensaje (`wamid`), haciendo creer al backend que el mensaje había salido con éxito.
  - *Resolución y Justificación*:
    1. En `container.ts`, se deshabilitó la inyección de `fallbackSender` en `ZernioSenderHttp` (`fallbackSender = undefined`), estableciendo a Zernio como la única fuente autoritativa de despacho configurada.
    2. En `zernio-sender.http.ts`, se protegió la ruta de Rate Limit: ante una respuesta `429`, el sistema aborta de inmediato y lanza un `EXTERNAL_SERVICE_ERROR` estructurado con la indicación de reintento, sin intentar ningún desvío a otros canales.
    3. En `dynamic-whatsapp-sender.ts`, se eliminó el fallback residual hacia Meta en el método `sendMedia`.
    4. Con esto, si Zernio no puede despachar un mensaje, el sistema propaga el fallo de inmediato al operador en el chat para que esté al tanto y reintente cuando expire la ventana de Rate Limit, erradicando los falsos positivos.

- **Traducción y Clarificación de Errores de Meta/WhatsApp Cloud API al Español (`meta-delivery-error.ts`, `zernio-webhook.router.ts`, `get-campaign.use-case.ts`, `process-campaign-batch.use-case.ts`)**:
  - *Contexto y Problema*:
    Al exportar los destinatarios fallidos en el modal de campañas o visualizarlos en pantalla, los mensajes de error aparecían en inglés crudo devuelto por la API de Meta (ej. `"In order to maintain a healthy ecosystem engagement, the message failed to be delivered. (Meta Error 131049)"`). Los operadores y administradores no comprendían con claridad la razón por la cual WhatsApp no entregó los mensajes ni qué acción tomar.
  - *Causa Raíz*:
    Los webhooks y respuestas de entrega de Zernio/Meta almacenaban directamente las cadenas en inglés provistas por los servidores de Cloud API sin traducción ni normalización orientada al negocio.
  - *Resolución y Justificación*:
    1. Se creó el módulo `meta-delivery-error.ts` que mapea y traduce los códigos oficiales de Meta Cloud API (`131049`, `131047`, `131026`, `131051`, `131056`, `132000`, `130429`, etc.) a descripciones amigables en español.
    2. En el caso del error `131049`, se explica con exactitud el motivo comercial: *"Límite de protección de Meta: Meta bloqueó la entrega para evitar saturar al destinatario con mensajes de marketing/campaña (Error Meta 131049)"*.
    3. `GetCampaignUseCase` aplica automáticamente la traducción sobre los destinatarios al consultar la campaña, garantizando que tanto los registros históricos como los nuevos muestren la causa en español.
    4. En el frontend, se incorporó la descarga directa en formato Microsoft Excel nativo (`.xlsx`) y CSV con columnas separadas (`Teléfono`, `Nombre`, `Motivo del Fallo`, `Fecha de Envío`) y textos en español.

- **Optimización de Desempeño en Consulta de Campañas y Eliminación del Cuello de Botella HTTP contra Zernio (`get-campaign.use-case.ts`, `container.ts`)**:
  - *Contexto y Problema*:
    Al acceder a la vista o métricas de una campaña desde el panel de administración (`GET /api/campaigns/:id`), las peticiones HTTP tardaban entre 68 y 73 segundos (`durationMs: 70300`), provocando bloqueos y timeouts en el frontend. Simultáneamente, la API de Zernio quedaba saturada con errores `429 Too Many Requests (currentCount: 61, limit: 60)`, impidiendo que los asesores humanos y el bot de IA pudieran despachar mensajes normales de WhatsApp en las conversaciones activas.
  - *Causa Raíz*:
    En `GetCampaignUseCase`, la consulta ejecutaba un bucle síncrono `for (const r of recipients)` invocando `checkMessageStatus(r.phone, r.externalId)` vía peticiones HTTP secuenciales a Zernio por cada destinatario con estado `SENT`. En campañas de 50 a 100 contactos, esto disparaba decenas de llamadas consecutivas en una sola solicitud web, consumiendo de forma instantánea la cuota por minuto de Zernio (límite: 60 peticiones/min) y reteniendo el hilo de ejecución durante más de un minuto.
  - *Resolución y Justificación*:
    1. Se eliminó la verificación síncrona por polling HTTP en `GetCampaignUseCase`.
    2. La arquitectura del sistema delega el seguimiento de entrega de mensajes a los Webhooks asíncronos (`message.delivered`, `message.failed` procesados en `zernio-webhook.router.ts`), los cuales ya persisten los cambios directamente en la base de datos sin llamadas de salida activas.
    3. Gracias a este cambio, el tiempo de respuesta del endpoint `GET /api/campaigns/:id` pasó de 70.000 ms a menos de 10 ms, eliminando por completo los bloqueos por Rate Limit 429 para toda la empresa.

- **Cálculo Preciso del Avance de Campaña ante Destinatarios Fallidos (`list-campaigns.use-case.ts`, `get-campaign.use-case.ts`)**:
  - *Contexto y Problema*:
    En campañas donde varios contactos fallaban (por ejemplo, debido a políticas de Meta como el error `131049 - Marketing Frequency Capping`), la tabla general de campañas mostraba un avance inconsistente de `1 / 4 (25%)` a pesar de que el estado de la campaña figuraba como `TERMINADO` y la totalidad de los 4 contactos habían sido procesados.
  - *Causa Raíz*:
    El cálculo de progreso en `ListCampaignsUseCase` y `GetCampaignUseCase` utilizaba la fórmula `(sentCount / totalRecipients) * 100`. Al completarse 1 envío exitoso y 3 fallidos, `sentCount` tenía valor 1, reflejando erróneamente un 25% de progreso en una campaña ya finalizada.
  - *Resolución y Justificación*:
    Se modificó la fórmula para basarse en el total de destinatarios procesados: `progress = Math.min(100, Math.round(((sentCount + failedCount) / totalRecipients) * 100))`. De este modo, la tabla y los modales muestran correctamente `4 / 4 (100%) TERMINADO`, mientras que el desglose interno detalla los enviados y fallidos con su causa exacta.

- **Enrutamiento de Campañas a la Bandeja de "Cerrados" y Prevención de Inundación de la Bandeja de "Abiertos" (`process-campaign-batch.use-case.ts`, `container.ts`, `campaign-use-cases.test.ts`)**:
  - *Contexto y Problema*:
    Tras despachar una campaña masiva, todas las conversaciones creadas se volcaban automáticamente a la "Bandeja de abiertos" de los asesores, llenando la bandeja operativa con chats donde el cliente aún no había respondido nada.
  - *Causa Raíz*:
    `ProcessCampaignBatchUseCase` enviaba el mensaje a través de WhatsApp pero no administraba la entidad `conversation` en la base de datos local. Al recibir Zernio el mensaje saliente, el webhook devolvía un eco que invocaba `findOrCreateByWaPhone`, creando la conversación con el valor por defecto de PostgreSQL (`status = 'open'`) y omitiendo la configuración de comportamiento de la campaña (`chatRouting.initialStatus = 'CLOSED'`).
  - *Resolución y Justificación*:
    1. Se inyectaron `conversationRepo` y `messageRepo` en `ProcessCampaignBatchUseCase`.
    2. Al enviar cada mensaje del lote, el caso de uso registra de inmediato la conversación y persiste el mensaje saliente con su `externalId`.
    3. Se aplica el estado definido en `chatRouting.initialStatus`: si la campaña está configurada como cerrada (`initialStatus: "CLOSED"`), la conversación se establece inmediatamente en `status: "closed"`, manteniéndola en la bandeja de Cerrados.
    4. Al registrarse previamente el mensaje con su `externalId`, el webhook de eco saliente de Zernio es reconocido como mensaje local existente (`findRecentOutbound`), evitando que se reabra indebidamente.
    5. Si el cliente contesta en WhatsApp con una consulta real, `ReceiveInboundMessageUseCase` detecta el mensaje entrante, lo reabre automáticamente a `status: "open"` y la IA (Gemini) toma el caso con el historial del mensaje de la campaña para clasificarlo y atenderlo. Si el cliente responde únicamente una cortesía ("gracias", "ok"), permanece en `closed`.

## [0.2.13] - 2026-11-09

- **Drenado Reactivo de Cola Departamental al Pasar Casos a "En Espera" (`ScheduleCaseUseCase`, `container.ts`, `schedule-and-close-reasons.test.ts`)**:
  - *Contexto y Problema*:
    Cuando un asesor agendaba o pasaba un caso a estado "En espera" (`ScheduleCaseUseCase`), el caso cambiaba a `WAITING_USER` y la conversación pasaba a `pending`. A nivel de cálculo de concurrencia (`countActiveCasesByAgent`), el sistema mide únicamente casos en `status = 'HUMAN_ACTIVE'`, por lo que en base de datos el asesor liberaba de inmediato 1 cupo disponible. Sin embargo, `ScheduleCaseUseCase` no invocaba a `DrainDepartmentQueueService`, provocando que la cola de espera del departamento no se drenara de forma reactiva y el siguiente cliente permaneciera encolado hasta que ocurriera otro evento externo (cierre de otro caso, cambio manual de disponibilidad o reconexión SSE).
  - *Resolución*:
    1. Se inyectó `drainQueue?: DrainDepartmentQueueService` en `ScheduleCaseUseCase`.
    2. Tras persistir la transición a `WAITING_USER` y registrar la auditoría, se invoca reactivamente `drainQueue.drainQueueForDepartment(case.departmentId)` (o `drainQueueForAgent(agentUserId)` como alternativa si el caso no tiene área asignada).
    3. Se cableó la instancia `drainDepartmentQueue` en `container.ts` y se añadieron pruebas unitarias en `test/cases/use-cases/schedule-and-close-reasons.test.ts`.

- **Corrección de Enrutamiento Departamental, Fallback Ciego a Facturación y Clasificación de Soporte/Ubicación (`department-resolver.service.ts`, `department-routing.service.ts`, `interpret-message.prompt.ts`, `intent-catalog.ts`, `resolve-reply-template.ts`, `process-buffered-messages.use-case.ts`)**:
  - *Contexto y Problema*:
    1. **Contaminación de Facturación**: Casos con saludos, consultas generales o intenciones no clasificadas aparecían asignados al departamento de Facturación, a pesar de que los clientes no mencionaban facturas, deudas ni pagos.
    2. **Desvío Erróneo a Ventas**: Clientes que enviaban una ubicación GPS aislada eran clasificados automáticamente como `sales.new_contract`, derivándose a Ventas. Cuando el cliente luego pedía soporte técnico (ej. *"Me pueden ayudar cambiando la clave x favor"*), el caso ya estaba atrapado en Ventas con el bot silenciado.
  - *Causas Raíz*:
    1. En `DepartmentResolverService` (línea 57) y `DepartmentRoutingService` (línea 162), cuando un tipo de flujo o intención no coincidía con ningún slug de departamento, existía un fallback ciego: `return activeDepts[0]!.id;`. En la base de datos, el primer departamento activo era Facturación (`billing`), provocando que cualquier caso sin departamento asignado se volcara indebidamente a Facturación.
    2. En `interpret-message.prompt.ts`, no existía regla para mensajes que contenían únicamente una ubicación GPS sin caso activo de ventas o traslado, llevando a que la IA asumiera contratación nueva (`sales.new_contract`) y activara la verificación de cobertura KML.
    3. No existía mención explícita de solicitudes técnicas de router (cambio de clave Wi-Fi, contraseña, SSID, configuración) en el catálogo ni en el prompt de interpretación, por lo que solicitudes como *"cambiando la clave x favor"* no tenían una ruta clara a `support.internet`.
  - *Resolución*:
    1. **Eliminación del Fallback Ciego**: En `department-resolver.service.ts` y `department-routing.service.ts`, se eliminó `return activeDepts[0]!.id;`. Si no hay coincidencia válida de departamento, se retorna `null` para que el caso quede en el pool general de triage (`department_id: null`) y sea supervisado por administradores/managers en lugar de saturar Facturación.
    2. **Ubicaciones GPS Aisladas Clarificadas**: Si un cliente envía una ubicación GPS o coordenadas numéricas sin caso previo ni texto, el sistema no asume Ventas ni traslado; clasifica como `UNCLEAR` y solicita aclaración amigable: *"Recibimos tu ubicación 📍. ¿Podrías indicarnos en qué te podemos colaborar hoy? (Por ejemplo: consultar cobertura para contratar un servicio nuevo, solicitar soporte técnico o realizar el traslado de tu domicilio)"*.
    3. **Ruta Explícita de Soporte de Router y Clave Wi-Fi**: Se incorporó en `intent-catalog.ts` y en `interpret-message.prompt.ts` que solicitudes de cambio de clave Wi-Fi, reseteo o configuración de router pertenecen indefectiblemente a `support.internet` (Soporte Técnico).



- **Aislamiento Departamental y Mitigación de Alertas Sonoras Indiscriminadas en Tiempo Real (`realtime-broadcaster.ts`, `receive-inbound-message.use-case.ts`, frontend `use-realtime.tsx`, `notifications.state.ts`, `realtime-event.ts`, `AppShell.tsx`)**:
  - *Contexto y Problema*:
    1. Asesores con rol `agent` escuchaban notificaciones sonoras (`playNotificationSound`) y recibían alertas de escritorio en el navegador para mensajes entrantes de toda la empresa de forma indiscriminada, como si tuvieran rol de supervisión global (`admin` o `manager`).
    2. Mensajes rutinarios intercambiados entre clientes y el bot de IA producían un sonido constante en las terminales de todos los asesores, generando fatiga acústica (*alarm fatigue*).
    3. Los recordatorios de casos agendados (`CASE_SCHEDULED_REMINDER`) también se transmitían a todos los agentes sin filtrar por asesor asignado ni por departamento.
  - *Causa Raíz*:
    1. En `realtime-broadcaster.ts`, `shouldDeliver` utilizaba visibilidad compartida sin filtros para `MESSAGE_RECEIVED` y `CASE_SCHEDULED_REMINDER`, enviando cada evento a todos los suscriptores conectados.
    2. El evento `MESSAGE_RECEIVED` carecía de metadatos de caso (`departmentId`, `assignedAgentId`, `isHumanActive`).
    3. En el frontend, `use-realtime.tsx` ejecutaba `playNotificationSound()` incondicionalmente ante cualquier `MESSAGE_RECEIVED` si el chat no estaba activo en pantalla, sin verificar si el mensaje pertenecía a un flujo de bot o a otro asesor.
  - *Resolución*:
    1. **Enriquecimiento del Evento en Backend**: Se incluyeron `departmentId`, `assignedAgentId` e `isHumanActive` en el payload de `MESSAGE_RECEIVED` generado en `receive-inbound-message.use-case.ts` (inyectando `caseRepo` en `container.ts`).
    2. **Filtrado Estricto en Broadcaster**: En `realtime-broadcaster.ts`, para roles `agent`:
       - `MESSAGE_RECEIVED` solo se entrega si el caso está asignado al agente (`assignedAgentId === sub.userId`) o pertenece a su departamento (`sub.departmentIds.has(departmentId)`).
       - `CASE_SCHEDULED_REMINDER` solo se entrega al agente asignado o a miembros del departamento correspondiente.
       - Roles `admin` y `manager` retienen visibilidad completa de supervisión.
    3. **Filtrado Inteligente de Alertas en Frontend**: En `use-realtime.tsx`, `playNotificationSound()` y `sendDesktopNotification()` se reservan estrictamente para eventos humanos accionables:
       - Silencio absoluto para mensajes rutinarios de bot (`!isHumanActive`).
       - Silencio si el caso está asignado a otro asesor específico.
       - Sonido y alerta únicamente si el caso está asignado al usuario actual, o si es un caso humano en espera en la cola de su área, o para supervisores (`manager`/`admin`).
       - En `notifications.state.ts`, se ajustó `isMine` para asociar recordatorios únicamente al agente responsable.


- **Análisis Contextual Continuo y Manejo Humano de Mensajes Post-Cierre sin Plantillas Genéricas (`process-buffered-messages.use-case.ts`, `general-inquiry.workflow.ts`, `interpret-message.prompt.ts`, `ai-provider.port.ts`, `interpretation.port.ts`, `ai-interpretation.adapter.ts`, `general-inquiry.context.ts`)**:
  - *Contexto y Problema*:
    1. Si un cliente escribía minutos u horas después de haberse cerrado un caso para agradecer o confirmar que su servicio se restableció (ej: *"muchas gracias, ya me sirvió el internet"*, *"ya quedó bien amigo"*, *"ya valió el internet gracias"*, *"Dios le pague"*), el sistema abría un caso nuevo huérfano en `GENERAL_INQUIRY` o enviaba la plantilla genérica de aclaración (`CLARIFY`), confundiendo al cliente y reabriendo casos cerrados.
    2. Si el cliente escribía con dudas de seguimiento sobre el caso que se acababa de cerrar (ej: *"¿y qué hago si vuelve a fallar la luz roja?"*, *"¿en cuánto tiempo se refleja mi pago?"*), o si enviaba un saludo como *"Hola buenas tardes"*, el bot lo trataba como un cliente nuevo desconocido, enviándole la plantilla genérica de bienvenida comercial (*"Puedes consultarnos sobre nuestros planes de internet, ubicación de oficinas..."*).
  - *Resolución*:
    1. **Inyección de `previousCompletedCase` e Historial Ampliado (`limit: 20`)**: Al interpretar mensajes de conversaciones sin caso activo, se alimenta a la IA con el contexto estructurado del caso resuelto recientemente (tipo de workflow, diagnóstico previo, notas de resolución y minutos transcurridos) junto con los últimos 10 mensajes reales de la conversación.
    2. **Agradecimientos y Confirmación de Servicio sin Reaperturas Innecesarias ni Código Quemado**:
       - *Comprensión 100% Semántica*: Se eliminaron expresiones regulares o diccionarios estáticos de palabras en código. La IA (a través del prompt enriquecido en `interpret-message.prompt.ts`) analiza semánticamente el propósito y contexto del mensaje, identificando modismos locales ecuatorianos (*"ya valió el internet"*, *"ya quedó bien amigo"*, *"Dios le pague"*, *"ya prendió verde"*) y confirmaciones de satisfacción.
       - *Redacción Dinámica con `composeReply`*: En lugar de cadenas estáticas fijas, el use-case invoca `composeReply.execute(...)` con el texto real del cliente y la pista de plantilla, generando una respuesta natural, empática y personalizada que reconoce el éxito de la atención previa sin abrir casos nuevos ni alterar el estado resuelto.
    3. **Saludo de Cliente Recurrente vs. Desconocido**: En `general-inquiry.workflow.ts`, si el cliente saluda en una conversación con antecedentes recientes, se saluda reconociendo su retorno (*"Qué gusto saludarte de nuevo. Cuéntanos, ¿en qué te podemos colaborar hoy o tienes alguna consulta sobre tu servicio?"*), eliminando permanentemente el menú comercial genérico a clientes con atención previa.
    4. **Detección Contextual de Consultas de Seguimiento**: En `interpret-message.prompt.ts`, las preguntas posteriores al cierre se contextualizan con el caso previo, evitando falsos positivos de saludos y asignando la intención correcta de soporte o facturación.

- **Cierre y Cancelación Robusta de Casos en Estado `NEW` (`complete-case.use-case.ts`, `cancel-case.use-case.ts`, `case.entity.ts`, `process-buffered-messages.use-case.ts`, frontend `case.ts`)**:
  - *Contexto y Problema*: Al intentar cerrar o completar un caso que acababa de crearse o reabrirse (por ejemplo, minutos u horas después de un caso anterior resuelto), los agentes recibían el error de negocio `No se puede completar un caso en estado NEW`.
  - *Causas Raíz*:
    1. En `CompleteCaseUseCase`, la lista `COMPLETABLE: CaseStatus[]` permitía únicamente `["ACTIVE", "WAITING_USER", "HUMAN_ACTIVE", "ESCALATED", "PAUSED"]`, omitiendo `NEW`. Por ende, cualquier caso recién instanciado o en espera inicial era imposible de cerrar por los agentes.
    2. En `CancelCaseUseCase`, la lista `CANCELLABLE_STATUSES` tampoco admitía `NEW`.
    3. En `case.entity.ts`, `ACTIVATABLE_CASE_STATUSES` no incluía `NEW`, impidiendo liberar adecuadamente `active_case_id` en la conversación al cancelar un caso en estado nuevo.
    4. En `process-buffered-messages.use-case.ts`, en la rama de `billing.record_payment` sin comprobante visual (`!canAutoRecord && !visualReceipt`), el bot solicitaba la foto del comprobante al cliente pero dejaba el caso en `status: "NEW"`, quedando varado en ese estado como `active_case_id`.
  - *Resolución*:
    1. Se añadió `NEW` a `COMPLETABLE` en `complete-case.use-case.ts` y a `CANCELLABLE_STATUSES` en `cancel-case.use-case.ts` (y en el frontend `case.ts`).
    2. Se actualizó `ACTIVATABLE_CASE_STATUSES` en `case.entity.ts` para reconocer `NEW`.
    3. En `process-buffered-messages.use-case.ts`, cuando se solicita la foto del comprobante al cliente, el caso transiciona limpiamente a `status: "WAITING_USER"` con `currentState: "WAITING_USER_RECEIPT"` y registra el evento `WAITING_USER`.
    4. Se agregaron tests unitarios en `complete-case-authorization.test.ts`, `cancel-case.use-case.test.ts` y `process-buffered-messages.use-case.test.ts` verificando la finalización, cancelación y transición correcta.

- **Jerarquía de Confianza Activa y Filtrado de Contratos Inactivos (`contract-status-filter.helper.ts`, `support-internet.workflow.ts`, `billing-balance.workflow.ts`, `home-relocation.workflow.ts`, `resolve-reply-template.ts`, `find-cliend-contract.json`)**:
  - *Contexto y Problema*: Al consultar contratos históricos por cédula en el ISP/Google Sheets (`VALIDATE_CLIENT`), el sistema recibía contratos en estados `ANULADO`, `RETIRADO`, `RECHAZADO` o `INACTIVO`. Al detectar más de un contrato, el motor obligaba a desambiguar (`WAITING_USER_DISAMBIGUATE`) presentando contratos dados de baja en los botones interactivos de WhatsApp. Esto generaba confusión y alarma en clientes que creían que se les seguía cobrando por servicios cancelados años atrás, además de forzar pasos de desambiguación innecesarios a clientes que en realidad solo contaban con un único servicio activo.
  - *Resolución*:
    1. **Módulo Especializado de Filtrado y Clasificación (`contract-status-filter.helper.ts`)**:
       - Discriminación de estados estrictamente activos (`ACTIVO`, `ACTIVE`), suspendidos por mora (`CORTADO`, `SUSPENDIDO`) e inactivos (`ANULADO`, `RETIRADO`, `RECHAZADO`, `INACTIVO`, `CANCELADO`, `BAJA`).
       - *Nivel 1 de Confianza*: Si el cliente tiene contratos estrictamente activos, se descartan automáticamente todos los anulados/retirados. Si solo queda un contrato activo, se selecciona de inmediato omitiendo la desambiguación. Si quedan varios activos, se desambigua únicamente entre los activos.
       - *Nivel 2 de Confianza*: Si no hay activos pero sí servicios cortados/suspendidos, se priorizan para permitir la consulta de deudas y reconexión.
       - *Nivel 3 (Inactividad Total)*: Si todos los contratos figuran como anulados o retirados, se marca `allContractsInactive: true` y se escala con mensaje pedagógico: *"Identificamos tu número de cédula, pero tus contratos anteriores figuran como retirados o anulados y actualmente no registras un servicio de internet activo..."*.
    2. **Propagación en Workflows (`support-internet.workflow.ts`, `billing-balance.workflow.ts`, `home-relocation.workflow.ts`, `sync-case-data.use-case.ts`, `sync-customer-isp.use-case.ts`)**:
       - Integración del helper para seleccionar siempre el contrato activo prioritario y registrar su estado real en Postgres sin forzar valores `"active"` ficticios.
    3. **Ajuste en Integración de n8n (`find-cliend-contract.json`)**:
       - Filtrado y priorización activa en el nodo de formato antes de emitir los contratos hacia la API.

- **Desambiguación Interactiva Robusta de Multi-Contratos con Coincidencia de Caracteres y Call-to-Action Explícito (`contract-disambiguation.helper.ts`, `resolve-reply-template.ts`, `support-internet.workflow.ts`, `advance-case.use-case.ts`, `interpret-message.prompt.ts`)**:
  - *Contexto y Problema*:
    1. Cuando un cliente cuenta con más de un contrato asociado a su cédula, el sistema presentaba la lista interactiva (`WAITING_USER_DISAMBIGUATE`), pero la desambiguación solo aceptaba números ordinales ("1", "2") o códigos de contrato exactos.
    2. Si el cliente respondía con texto libre describiendo el lugar o sector (ej: *"el de Pomasqui"*, *"el que está en Pomasquí"*, *"el de Carcelén"*, *"la de mi casa"*, *"el de la oficina"*), o cometía erratas menores (*"pomasqi"*, *"carceln"*, *"manuel cordoba"*, *"casita"*), las comparaciones rígidas tipo base de datos fallaban y producían confusiones.
    3. Los mensajes de botones o lista no indicaban de forma totalmente explícita al usuario la instrucción de presionar el botón de su contrato o seleccionarlo de la lista.
    4. Si el cliente escribía su número de contrato (ej: `10542`), `advance-case` interpretaba erróneamente el número como una opción ordinal (`selectedOption: 10542 > length`), fallando la coincidencia, o el matcher de cédula lo confundía con un reingreso de cédula de 9 a 13 dígitos.
  - *Resolución*:
    1. **Instrucción Explícita en Botones y Listas (`resolve-reply-template.ts`)**:
       - Para 2 contratos: *"Por favor presiona el botón del contrato que presenta el inconveniente a continuación (o responde con el número 1, 2... o selecciónalo indicando el sector o dirección):"*.
       - Para > 2 contratos: *"Por favor presiona 'Ver opciones' y selecciona el contrato de la lista a continuación (o responde con el número 1, 2... o selecciónalo indicando el sector o dirección):"*.
    2. **Motor de Coincidencia de Caracteres (`contract-disambiguation.helper.ts`)**:
       - Se implementó análisis de similitud morfológica y fonética combinando **distancia de Levenshtein** y **coeficiente de Dice sobre bigramas de caracteres**.
       - Tolerancia anti-rigidez ante erratas fonéticas, transposiciones de letras y variaciones de diminutivos (*"pomasqi"*, *"carceln"*, *"manuel cordoba"*, *"casita"*, *"oficna"*).
       - Ponderación de coincidencia que exige un margen de ventaja claro del ganador sobre el segundo puesto para evitar selecciones dudosas o forzadas.
    3. **Pre-resolución en [`advance-case.use-case.ts`](file:///d:/Proyectos/Node/internal_sys_comunication_backend/src/core/modules/cases/application/use-cases/advance-case.use-case.ts)**:
       - Resuelve el contrato antes de evaluar campos faltantes del `WaitingStep`, inyectando `selectedOption` y `contractId` para evitar quemar intentos del cliente.
    4. **Ampliación de contrato en [`support-internet.workflow.ts`](file:///d:/Proyectos/Node/internal_sys_comunication_backend/src/core/modules/cases/application/engine/definitions/support-internet.workflow.ts)**:
       - Se sumaron `contractId`, `sector`, `location` y `answer` a `requireAny`, y `disambiguateContract` delega al helper modular.

- **Reintentos Automáticos con Backoff Exponencial en Campañas Masivas (`process-campaign-batch.use-case.ts`, `campaign.repository.pg.ts`, `0048_campaign_recipient_retry_backoff.sql`)**:
  - *Contexto y Problema*: Al procesar lotes de destinatarios en campañas masivas, cualquier error temporal en el proveedor de WhatsApp (Meta API error 429 por saturación de QPS, caídas 5xx, timeouts o microcortes de red) marcaba de inmediato al destinatario como `FAILED` e incrementaba el contador de fallidos de la campaña. Los clientes con fallos transitorios quedaban permanentemente sin recibir la notificación.
  - *Resolución*:
    1. Se introdujo discriminación de errores transitorios (`isTransientCampaignError`) vs permanentes/fatales (número inválido, plantilla inexistente).
    2. Política de reintentos con backoff exponencial y jitter (`calculateCampaignBackoffMs`) de hasta 3 intentos (`MAX_RECIPIENT_RETRIES = 3`).
    3. Los destinatarios con fallos transitorios se mantienen en estado `PENDING` con fecha futura `next_retry_at` y mensaje de reintento.
    4. La consulta de lotes pendientes `findPendingBatch` filtra por `(next_retry_at IS NULL OR next_retry_at <= NOW())`, permitiendo que el worker reintente los mensajes en el momento exacto sin bloquear el resto del lote.
    5. Si se agotan los 3 reintentos o el error es fatal, el destinatario pasa a `FAILED` y se incrementa el contador de fallidos.

- **Desacople Total de Plantillas Salientes Manuales (`conversations.router.ts`)**:
  - *Contexto y Causa Raíz*: Al enviar una plantilla desde la UI mediante `POST /api/conversations/:id/template` a un chat sin caso activo, el endpoint forzaba la creación de un caso en estado `HUMAN_ACTIVE` asignado al agente que despachó la plantilla (`setAssignedAgent(agent.id)`) e insertaba el mensaje con `agentId: agent.id`. Cuando el cliente respondía horas después (por ejemplo pidiendo su saldo), `ProcessBufferedMessagesUseCase` detectaba que la conversación tenía un caso `HUMAN_ACTIVE` asignado y silenciaba la IA de forma fulminante (`return;`), dejando al cliente en espera sin respuesta por horas mientras la UI indicaba erróneamente que la IA estaba activa.
  - *Resolución*: Se eliminó la creación forzada de casos `HUMAN_ACTIVE` en el envío de plantillas. Las plantillas salientes se registran con `agentId: null` y `caption: template:<name>`, identificándolas como notificaciones salientes desacopladas de atención humana exclusiva. Cuando el cliente responde, la IA retoma inmediatamente el control del caso.

- **Desacople de Campañas/Plantillas, Desbloqueo Inmediato de IA y Reutilización de Identidad (`process-buffered-messages.use-case.ts`, `interpret-message.prompt.ts`, `general-inquiry.workflow.ts`, `conversation-identity.service.ts`, `billing-balance.workflow.ts`, `support-internet.workflow.ts`, `home-relocation.workflow.ts`)**:
  - *Contexto y Problema*:
    1. Al enviarse una campaña masiva o plantilla de cobro, los mensajes salientes automáticos tenían `author: "agent"` sin `agentId`. La condición de guardia `agentStartedRecently` asumía erróneamente que un humano había intervenido y silenciaba la IA por 24 horas completas para todos los destinatarios que respondían.
    2. Cuando un agente humano cerraba o resolvía un caso (como Aracely Novillo), si el cliente enviaba un comprobante u otra consulta horas más tarde, el bot seguía silenciado por la ventana de 24 horas y el comprobante quedaba sin atención ni asignación.
    3. En cada nuevo flujo o consulta (Facturación, Soporte, Traslado), el sistema volvía a solicitar el número de cédula al cliente a pesar de que ya existía en la base de datos o en casos previos de la conversación.
    4. Cuando el cliente respondía con cortesía, conformidad o cierre post-atención (ej: *"Ok"*, *"Gracias"*), el NLU asociaba el mensaje al último tema tocado y reiniciaba la consulta de saldo (`billing.balance`), repitiendo mecánicamente *"Revisé tu cuenta..."*.
  - *Resolución*:
    1. **Desacople estricto de campañas**: `humanIntervenedRecently` solo se activa cuando el mensaje fue enviado por un asesor humano real (`Boolean(lastPrior.agentId)`) y pertenece a un caso activo no terminal. Las plantillas y campañas automáticas permiten a la IA atender inmediatamente la respuesta del cliente.
    2. **Retoma inmediata de la IA**: Si el caso anterior ya está resuelto (`COMPLETED` o `RESOLVED`), la IA asume de inmediato los nuevos mensajes entrantes (incluyendo la clasificación de comprobantes de pago hacia cartera).
    3. **Persistencia y Reutilización de Cédula en Cascada**:
       - Nuevo método `tryGetCustomerIdentity(conversationId)` en `ConversationIdentityPort` y `ConversationIdentityService` para recuperar la cédula asociada al cliente o su teléfono.
       - En `process-buffered-messages.use-case.ts`, `BILLING_BALANCE`, `SUPPORT_INTERNET` y `HOME_RELOCATION`, si la cédula ya es conocida, se reutiliza automáticamente sin volver a pedirla al usuario.
    4. **Razonamiento Semántico en NLU (Sin regex rígidos)**:
       - Se eliminaron las listas de términos quemados en código.
       - En `interpret-message.prompt.ts`, se instruyó al LLM a discriminar pragmáticamente si el nuevo mensaje expresa conformidad o cierre post-atención. En tal caso, emite `isClosing: true`, `isThankYou: true`, y `GENERAL_INQUIRY` responde amablemente preguntando si requiere asistencia adicional o despidiéndose, concluyendo el caso limpiamente sin bucles.
- **Enriquecimiento de Previsualizaciones Multimedia en Conversaciones (`list-conversations.use-case.ts`, `search-conversations.use-case.ts`)**:
  - Se incluyeron los metadatos `type`, `caption` y `filename` en el DTO `lastMessagePreview` para renderizar etiquetas humanas amigables estilo WhatsApp (📷 Foto, 🎵 Audio, 🎥 Video, etc.).

- **Contexto de cliente en eventos SSE de escalamiento y asignación (`realtime-broadcaster.ts`, `escalation.service.ts`, `assign-case.use-case.ts`, `claim-case.use-case.ts`)**:
  - Se incluyeron los campos `customerName` y `customerPhone` en los eventos `CASE_ESCALATED` y `HUMAN_ASSIGNED` para que las notificaciones a los asesores muestren nombre y teléfono legible en lugar de truncar UUIDs internos.

## [0.2.11] - 2026-11-06

- **Optimización de Big O y Alta Eficiencia en Consultas de Calidad (`quality-review.repository.pg.ts`, `0047_quality_performance_indexes.sql`)**:
  - *Contexto y Problema*:
    - La carga inicial y cambio de filtros en Supervisión de Calidad (`/calidad`) demoraba entre 7 y 10 segundos para rangos mensuales (30 días).
    - Los endpoints `GET /api/quality/agents` y `GET /api/quality/reviews` saturaban la CPU de PostgreSQL con escaneos secuenciales y altos consumos de memoria de ordenamiento.
  - *Causa Raíz*:
    1. **Producto cartesiano ($O(C^2)$) en `getAgentStats`**: Se ejecutaba un `LEFT JOIN` simultáneo entre `completed_cases cc` y `first_reply fr` a nivel de `assigned_agent_id` sin pre-agrupar. Para un asesor con 100 casos en el mes, PostgreSQL generaba $100 \times 100 = 10.000$ tuplas intermedias en memoria antes del `GROUP BY`.
    2. **Escaneos secuenciales sobre la tabla `message` ($O(C \cdot M)$)**: Las subconsultas de `closed_with_agent` y `first_reply` utilizaban la condición `WHERE (m.case_id = c.id OR (m.conversation_id = c.conversation_id AND m.agent_id = c.assigned_agent_id))` sin índice en `message.case_id`. PostgreSQL se veía forzado a escanear la tabla `message` repetidamente para cada caso cerrado.
    3. **Join prematuro en `listReviews`**: Se ejecutaban `LEFT JOIN conversation`, `LEFT JOIN customer` y un `LEFT JOIN LATERAL` sobre `quality_finding` para todas las filas candidatas antes de descartar duplicados con `DISTINCT ON (qr.case_id, qr.agent_id)`.
  - *Resolución*:
    1. **Migración `0047_quality_performance_indexes.sql`**:
       - `idx_case_assigned_status_updated`: Índice compuesto en `"case" (assigned_agent_id, status, updated_at)`.
       - `idx_message_case_author`: Índice condicional en `message (case_id, author) WHERE case_id IS NOT NULL` para búsquedas en tiempo $O(\log M)$.
       - `idx_message_conv_agent_author`: Índice en `message (conversation_id, agent_id, author)`.
       - `idx_quality_review_agent_created`: Índice en `quality_review (agent_id, created_at, status, cordiality_score)` para agregación de semáforo.
       - `idx_quality_review_distinct_case_agent`: Índice compuesto en `quality_review (case_id, agent_id, created_at DESC)` que permite a PostgreSQL resolver el `DISTINCT ON` directamente por índice sin volcar a `work_mem`.
       - `idx_quality_finding_review_severity`: Índice Index-Only Scan en `quality_finding (review_id, severity)`.
    2. **Reescritura de `getAgentStats`**:
       - Cada CTE (`completed_cases`, `closed_with_agent`, `review_status`, `first_reply`) pre-agrupa sus métricas para emitir estrictamente 1 fila por asesor (`agent_id`).
       - Se desacopló la condición `OR` en dos expresiones `EXISTS` cortocircuitadas y un `COALESCE` de subconsultas indexadas.
       - El `SELECT` principal une las CTEs 1 a 1 sobre `agent a` en complejidad $O(A)$ lineal según el número de asesores activos, eliminando por completo el producto cartesiano y el `GROUP BY` externo.
    3. **Reescritura de `listReviews`**:
       - Se aisló la deduplicación en la CTE `distinct_reviews` apoyada en el nuevo índice B-tree.
       - Los joins con `conversation`, `customer` y el conteo LATERAL de `quality_finding` se aplican únicamente sobre el subconjunto final deduplicado, ordenado de forma nativa por `dr.created_at DESC`.

## [0.2.10] - 2026-11-06

- **Fix PostgreSQL Relation Name for Escalation Queries (`escalation.repository.pg.ts`)**:
  - *Context & Problem*:
    - Navigating to the **Mesa de Triaje y Rescate SLA** in the frontend triggered an immediate red toast error: `"Error interno inesperado"`.
    - The desk showed 0 cases in queue, 0 min wait time, and empty SLA metrics despite pending escalated cases existing in the database.
    - Triggering **⚡ Auto-distribuir cola** (`POST /api/escalations/drain`) was also prone to fail when querying pending cases with row locks.
  - *Root Cause Analysis*:
    - In PostgreSQL, the cases table is named `"case"` (quoted because `CASE` is a reserved SQL keyword defined in `migrations/0001_init.sql`).
    - The recent client enrichment and queue locking queries in `EscalationRepositoryPg` (`findById`, `findByCaseId`, `list`, and `findNextPendingForDepartment`) introduced joins targeting `cases c ON c.id = e.case_id`.
    - Executing `GET /api/escalations` caused PostgreSQL to throw error `relation "cases" does not exist`, which was caught by `error-handler.middleware.ts` as an unhandled database error and returned as HTTP 500 (`{ error: { type: "EXTERNAL_SERVICE_ERROR", message: "Error interno inesperado" } }`).
  - *Resolution & Justification*:
    1. Corrected all 4 queries in `EscalationRepositoryPg`:
       - `findById`: `LEFT JOIN cases c` → `LEFT JOIN "case" c`.
       - `findByCaseId`: `LEFT JOIN cases c` → `LEFT JOIN "case" c`.
       - `list`: `LEFT JOIN cases c` → `LEFT JOIN "case" c`.
       - `findNextPendingForDepartment`: `JOIN cases c` → `JOIN "case" c`.
    2. Restores proper population of enriched metadata (`conversationId`, `customerName`, `customerPhone`) for every escalation item without breaking runtime table resolution in PostgreSQL.
    3. Validated end-to-end with the full test suite (513 tests passing) and TypeScript compilation.

## [0.2.9] - 2026-11-05

- **Automatic Queue Drain Dispatch Endpoint (`escalations.router.ts`, `container.ts`, `escalations-router.test.ts`)**:
  - *Context*: While `DrainDepartmentQueueService` existed for event-driven reactive draining upon connection or case closure, operational managers had no way to manually trigger an immediate re-balance or evacuation of pending queues from the UI.
  - *Resolution*:
    1. Implemented `POST /api/escalations/drain`, guarded by session authentication. Supports draining a specific department via `{ departmentId }` or iterating all active departments when omitted.
    2. Integrates with `DrainDepartmentQueueService` using atomic PostgreSQL `FOR UPDATE OF e SKIP LOCKED` and Least-Connections distribution to ensure safe, race-condition-free allocation without exceeding concurrency caps.
    3. Added test suite in `test/escalation/presentation/escalations-router.test.ts` verifying both targeted and global drain executions.

- **Enriched Escalation Entities with Client and Conversation Context (`escalation.entity.ts`, `escalation.repository.pg.ts`)**:
  - *Context*: The operational triage and SLA rescue desk needed customer name, contact phone, and direct deep links to conversations without requiring client-side N+1 roundtrips across multiple endpoints.
  - *Resolution*:
    1. Extended domain interface `Escalation` with optional `conversationId`, `customerName`, and `customerPhone`.
    2. Rewrote queries in `EscalationRepositoryPg` (`list`, `findById`, `findByCaseId`) to execute a unified query joining `cases c ON c.id = e.case_id`, `conversation conv ON conv.id = c.conversation_id`, and `customer cust ON conv.customer_id = cust.id OR (conv.customer_id IS NULL AND conv.wa_phone = cust.wa_phone)`.
    3. Automatically maps `COALESCE(cust.full_name, conv.wa_profile_name, conv.wa_phone)` as `customerName` and `conv.wa_phone` as `customerPhone`.

- **Queue Wait Times & Escalation Analytics Optimization (`analytics.repository.pg.ts`)**:
  - *Bug Fix*: Fixed average queue wait time calculation in `AnalyticsRepositoryPg`. Previously, active unassigned escalations skewed the average wait time calculation up to 378,946 seconds. The query was corrected to average wait times exclusively for escalations that reached a human agent or were resolved (`e.resolved_at IS NOT NULL OR e.assigned_agent_id IS NOT NULL`).
  - Added workflow type categorization (`c.workflow_type`) into `topEscalationReasons` to allow the root-cause chart to drill down into specific sub-reasons by area.

## [0.2.8] - 2026-11-05

- **Deep Historical Message Search via PostgreSQL Trigram GIN (`search-conversations.use-case.ts`, `conversation.repository.pg.ts`, `0046_message_search_index.sql`)**:
  - *Context*: Support and billing agents required the ability to search not only customer names, surnames, and phones, but also historical messages across past conversations (e.g. searching "quemó la fuente", "corte de fibra", or payment details from previous weeks), similar to WhatsApp Web.
  - *Architectural Design & Performance*:
    1. Created migration `0046_message_search_index.sql` enabling the PostgreSQL `pg_trgm` extension and adding `CREATE INDEX idx_message_body_trgm ON message USING gin (body gin_trgm_ops)`. This enables arbitrary substring search (`ILIKE %q%`) with sub-millisecond execution times over large message volumes without sequential table scans.
    2. Implemented `search(query, options)` in `ConversationRepositoryPg` using an optimized `LEFT JOIN LATERAL` against `message` matching `m.body ILIKE ('%' || $1 || '%') ORDER BY m.created_at DESC LIMIT 1`. This isolates the single most recent matching message per conversation, avoiding expensive `GROUP BY` operations.
    3. Created `SearchConversationsUseCase` and wired endpoint `GET /api/conversations/search?q=...&departmentId=...&limit=...`, returning unified conversation DTOs enriched with `matchedMessage` (message ID, snippet body, author, and timestamp).
    4. Added automated unit tests in `test/conversations/search-conversations.use-case.test.ts`.

## [0.2.7] - 2026-11-05

- **Visual Traceability for Case Closures (`complete-case.use-case.ts`, `list-conversations.use-case.ts`)**:
  - *Problem*: Previously, closing a case only updated internal database states and audit events, leaving no visual system message in the chat timeline. Team members opening past or resolved conversations could not see who resolved the case, when, or with what reason.
  - *Resolution*:
    1. `CompleteCaseUseCase` now persists closing metadata (`closedByAgentId`, `closedByAgentName`, `closedAt`, `closeReason`, `resolutionNote`) directly into `case.context`.
    2. Inserts an in-chat system message (`author: "system"`, `🔒 Caso completado por {actorName} • Motivo: {reasonLabel}{note}`) and broadcasts `MESSAGE_SENT` over SSE.
    3. `ListConversationsUseCase` resolves `lastAttendedBy` taking into account `closedByAgentId`/`closedByAgentName` so that resolved conversations correctly attribute the closing advisor.

- **Paced FIFO Dispatch with Concurrency Cap per Department (`drain-department-queue.service.ts`, `auto-assign-agent.service.ts`, `0045_department_max_concurrent_cases.sql`)**:
  - *Problem & Operational Risk*:
    - When escalated customer cases queued during off-hours or agent absence, no automated mechanism drained them when staff became available without requiring manual dispatch by a supervisor.
    - Conversely, a naive "all-at-once" dump upon agent connection would cause catastrophic agent overload (e.g., 20 simultaneous chats assigned to the first agent starting a shift), while waiting for quorum would create artificial customer starvation and SLA breaches.
  - *Architectural Decision & Solution*:
    - Implemented **Paced FIFO Dispatch with Concurrency Cap**:
      1. Added `max_concurrent_cases INTEGER NOT NULL DEFAULT 6` to the `department` table (migration `0045_department_max_concurrent_cases.sql`), configurable per department from the management panel.
      2. Enhanced `AutoAssignAgentService`: strictly excludes any agent whose active workload in `HUMAN_ACTIVE` meets or exceeds the department's concurrency cap.
      3. Created `DrainDepartmentQueueService`: an event-driven dispatcher that atomically locks and drains the oldest pending escalations using PostgreSQL `FOR UPDATE OF e SKIP LOCKED`, guaranteeing zero race conditions across concurrent processes.
      4. Wired reactive triggers:
         - **On Case Completion / Cancellation**: when an agent completes or cancels a case (`CompleteCaseUseCase`), a slot frees up and the next pending department case is drained immediately.
         - **On Agent Availability Toggle**: when an agent turns on `autoAssignEnabled` (`UpdateAgentAvailabilityUseCase`), pending cases drain up to their free capacity.
         - **On Realtime SSE Connection**: when an agent connects in the morning (`RealtimeRouter`), their available slots drain automatically without overwhelming them.
    - Added unit test suite in `test/escalation/services/drain-department-queue.service.test.ts` (100% passing).


- **Mitigation of False Payment Confirmations & Elimination of Rigid Canned Responses (`process-buffered-messages.use-case.ts`, `resolve-reply-template.ts`, `billing-balance.workflow.ts`, `interpret-message.prompt.ts`)**:
  - *Context & Damage*:
    1. *False Payment Confirmations*: When a client sent text stating their intent to pay (e.g. "quiero pagar", "para pagar", "ya pagué") without attaching any image or voucher, the assistant falsely responded: `¡Recibido, gracias! 🙌 Estamos verificando tu pago de $X y te confirmamos por aquí mismo en cuanto quede listo...` and escalated to Cartera as if a receipt had been delivered. This falsely led customers to believe their payment was verified and processed when no transaction details or proof existed.
    2. *Inappropriate Canned Greetings on Explicit Payment Requests*: When a client asked for payment accounts or deposit details (e.g. "Me podría mandar el número para de positarle gracias"), the system miscategorized the query as `general.inquiry` or fell back to `CLARIFY_TEMPLATE`, returning a canned first-contact greeting: `¡Hola! 👋 ¿En qué te puedo ayudar hoy? ¿Tienes algún inconveniente con tu internet, pagos, o prefieres hablar con un especialista?`. This ignored the customer's actual question and repeated an opening greeting mid-conversation.
  - *Root Cause*:
    1. In `process-buffered-messages.use-case.ts`, `interpretation.intent === "billing.record_payment"` unconditionally fired the receipt confirmation message and escalated to Cartera regardless of whether `visualReceipt` was `true` or `false`.
    2. Bank account numbers and payment deposit instructions were miscategorized under `general.inquiry` (General department) instead of Facturación (`billing`), and `CLARIFY_TEMPLATE` was a rigid canned opening greeting. Furthermore, `composeReply` never received the client's inbound text (`customerText`).
  - *Resolution*:
    1. Guarded receipt confirmation strictly behind `visualReceipt === true`. When a customer writes about paying without an image or receipt attached (`visualReceipt === false`), the assistant now asks specifically: *"Para poder verificar y registrar tu pago en el sistema, por favor envíanos una foto o captura del comprobante de transferencia o depósito bancario."*, keeping automation active.
    2. Introduced canonical intent `billing.payment_methods` mapped to the Billing department (`BILLING_BALANCE`). When triggered, `billing-balance.workflow.ts` delivers authorized bank accounts (Banco Pichincha, Banco Guayaquil, Produbanco) directly without requiring cédula validation, setting state to wait for the receipt.
    3. Added `customerText` to `ComposeReplyInput` and passed it from `ProcessBufferedMessagesUseCase` so `composeReply` generates context-aware, coherent responses tailored to the customer's specific query.
    4. Replaced generic opening canned greetings in `resolve-reply-template.ts` with contextual clarifying phrasing: *"No logré comprender del todo tu solicitud. ¿Podrías indicarme si necesitas ayuda con soporte técnico de internet, pagos y facturación, o prefieres comunicarte con un asesor?"*.
    5. Added migration `0044_prompt_interpret_payment_methods.sql` adding `billing.payment_methods` to `department_case_routing` and publishing Version 5 of `interpret_message`.
- **Multi-Contract Discovery Context Retention (`support-internet.workflow.ts`, `support-internet.context.ts`)**:
  - *Context*: During contract disambiguation, when a customer selected option 1 or clarified *"No es el 2"*, the advisor's panel lost visibility of the alternative contracts because `pendingContracts` was wiped from the case context.
  - *Resolution*: Added `availableContracts` to `SupportInternetContext` and retained all discovered customer contracts throughout the lifecycle of the case, allowing human advisors to switch between contracts in the panel.

## [0.2.5] - 2026-11-04

- **Quality Supervision Refinement: Burst Utterances, SLA Latency vs Politeness & Proactive Follow-ups (`analyze-agent-conversation.prompt.ts`)**:
  - *Context*: Supervisors identified critical false positives in quality assessments:
    1. Agents sending a question followed immediately by `?` or a typographical fix (e.g. `Buenas tardes, cómo continua con su servicio` + `?` seconds later) were severely penalized with `[Falta de respeto] «?»` for isolated punctuation.
    2. Response latency (e.g. agent replying 2–3 hours later) was penalizing polite, helpful messages (e.g. `Por favor me comenta cómo continua con su servicio`) as aggressive disrespect or abandonment, dropping the cordiality score to critical (<40).
    3. Proactive follow-ups by agents after customers went silent were falsely classified as "abandono/descuido".
  - *Changes*:
    - Enforced burst message cohesion: instructions mandate that consecutive messages sent in close succession (1–2 minutes) must be evaluated as a single cohesive utterance; isolated punctuation (`?`, `!`) or typo corrections are never treated as disrespect or impatience.
    - Strict separation between SLA latency and conversational politeness: response delays must only be reported under `efficiencyNotes` or as low/medium severity `inefficiency`, preserving cordiality scores for polite and professional phrasing.
    - Clarified customer silence vs agent abandonment: agent follow-ups when a client goes silent are recognized as proactive customer care, whereas neglect is reserved exclusively for unaddressed open inquiries left by customers.
    - Added unit test suite in `test/quality/analyze-agent-conversation-prompt.test.ts`.

## [0.2.4] - 2026-11-04

- **Multimodal Quality Analysis & Voice Note Transcription (`run-quality-analysis.use-case.ts`, `analyze-agent-conversation.prompt.ts`)**:
  - *Context*: Quality analysis previously evaluated only raw message bodies. When customers sent WhatsApp audio notes or receipts, the AI received empty or placeholder text (e.g. `[audio]`), falsely penalizing agents for abandonment or lack of responsiveness when responding to customer voice notes.
  - *Changes*:
    - Implemented `resolveMessageContent` in `RunQualityAnalysisUseCase` to dynamically execute `transcribeAudio` for audio voice notes, and `extractReceiptData` for images and PDF documents.
    - Updated `ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT` with explicit rules to evaluate agent replies within the full context of transcribed voice notes, documents, and vouchers.
    - Instructed the model to directly highlight infractions at the beginning of the summary before providing constructive pedagogical recommendations.
    - Sanitized chunk summaries in `buildFinalQualityReview` to eliminate duplicate "Eficiencia:" sections.

- **ESLint 10 & Clean Code Governance Implementation (`eslint.config.js`, `package.json`)**:
  - *Context*: The backend was missing automated static analysis enforcement for Clean Code practices, resulting in oversized modules, untyped `any` leaks, and dead code accumulation.
  - *Changes*:
    - Installed modern ESLint 10 with `@typescript-eslint` flat configuration.
    - Aligned TypeScript dependency to stable `^5.9.3` (`^5.8.3` semver) to resolve AST parser incompatibilities with `typescript-eslint`.
    - Added automated npm scripts: `pnpm run lint` and `pnpm run lint:fix`.
    - Configured rules:
      - `max-lines`: Warns on files exceeding 400 lines (ignoring comments/whitespace), establishing a target standard for ongoing modular refactoring.
      - `@typescript-eslint/no-explicit-any`: Enforces type safety by warning on explicit `any` usage.
      - `@typescript-eslint/consistent-type-imports`: Enforces explicit `type` imports for cleaner architecture and bundling.
      - `no-console`, `no-debugger`, `no-duplicate-imports`: Prohibits stray debugger statements, duplicate imports, and raw console logging in favor of structured Pino logging.
    - Fixed empty catch blocks in `meta-templates-gateway.http.ts` and `message-templates.router.ts` with explicit explanatory comments.
    - Cleaned up duplicate and unused type imports across case and escalation use cases.

## [0.2.3] - 2026-11-04

- **AI Automation Deactivation Upon Agent Assignment & Case Claim**:
  - *Damage*: When an AI assistant escalated a conversation to a human department or an agent took control, subsequent customer incoming messages could still trigger the AI bot to reply automatically, talking over the human agent or giving contradictory advice.
  - *Root Cause*: Arbitration (`CaseArbitrationService`) did not treat active cases with an assigned agent as strictly human-owned if status was not yet `HUMAN_ACTIVE`, and assignment / claim / transfer use cases did not automatically persist `automation_enabled = false` on the case or publish realtime deactivation events.
  - *Resolution*:
    - Reinforced `CaseArbitrationService` and `ProcessBufferedMessagesUseCase` to strictly return `REQUEST_HUMAN` for any non-terminal case with `assignedAgentId` set or with status `HUMAN_ACTIVE`/`ESCALATED`, preventing any automated bot messages while human staff are assigned.
    - Updated `AssignCaseUseCase`, `ClaimCaseUseCase`, and `TransferCaseUseCase` to automatically disable case automation (`setAutomationEnabled(false)`), append `AUTOMATION_DISABLED` audit events, sync `conversation.active_case_id`, and broadcast `AUTOMATION_DISABLED` and `HUMAN_ASSIGNED` realtime events.
    - Added unit test coverage in `test/cases/use-cases/process-buffered-messages.use-case.test.ts`.

## [0.2.2] - 2026-10-30

- **Contextual Intent-Driven Routing & Elimination of Rigid Regex Bypasses**:
  - *Damage*: A rigid keyword-based regex block (`isPaymentSubmission`) intercepted messages before AI interpretation. This created two serious failure modes:
    1. *Misrouting technical outages*: When a customer reported a service failure while mentioning a payment or attaching a voucher (e.g. *"No tengo internet, pero ya pagué en la mañana el servicio"*), the hardcoded regex hijacked the ticket and routed it to Cartera, ignoring that the user had an active internet outage needing technical support.
    2. *Brittleness to natural language*: When a customer reported a payment using terms not present in the hardcoded regex (or when OCR didn't extract fields), the regex evaluated to false and trapped the user in an automated balance inquiry asking for their cédula.
  - *Root Cause*: Rigid keyword checks attempted to replace AI natural language understanding with regular expressions, bypassing message history and full burst context.
  - *Resolution*:
    - Completely removed the pre-NLU regex bypass `isPaymentSubmission` from `ProcessBufferedMessagesUseCase`.
    - Enriched `prepareText` to always supply full media context (`[Adjunto imagen...]`, `[Adjunto documento...]`, audio transcripts, GPS coordinates) alongside message bursts and recent conversation history to `interpretMessage`.
    - Reinforced normative intent priority rules in `interpret-message.prompt.ts`:
      - Outages/technical issues take precedence (`support.internet`) even when payment proof is attached, recording payment entities in context for technicians.
      - Payment reports without technical failures (`billing.record_payment`) in any natural language phrasing escalate immediately to Cartera, acknowledge receipt, and silence the bot without asking for cédula.
    - Verified all test suites pass with 492 tests across 87 files.

- **WhatsApp Video & Media Ingestion, Classification & Multimodal Visual Analysis**:
  - *Damage*: Video messages received from WhatsApp (such as customer recordings of blinking router lights, damaged cables, or payment confirmations) were either dropped, misclassified as generic documents, or ignored by the AI reasoning engine, leaving the bot blind to the actual visual evidence provided by the customer.
  - *Root Cause*: Ingestion classification omitted video MIME types and extensions, and the reasoning pipeline (`prepareText`) lacked visual extraction for video and document media types.
  - *Resolution*:
    - Enhanced `parseZernioWebhookPayload` and `ZernioHistorySyncWorker` to accurately detect video attachments (`type === "video"` or MIME types `video/*` and extensions `.mp4`, `.mov`, `.webm`, `.3gp`, `.mkv`).
    - Integrated multimodal visual analysis in `GeminiAdapter.extractReceiptData` and `ProcessBufferedMessagesUseCase.prepareText` to process videos, images, and documents, automatically extracting visual scene descriptions (e.g. `[Adjunto video: router con luz roja LOS parpadeando]`) and receipt data.
    - Added unit test coverage in `test/cases/use-cases/process-buffered-messages.use-case.test.ts` and `test/conversations/parse-zernio-webhook.test.ts`.

- **Preservation of Line Breaks and Multiline Structure in Quick Replies**:
  - *Damage*: Quick replies containing instructions with multiple paragraphs, bullet points, and contract terms (e.g. equipment return requirements, payment instructions) had all line breaks collapsed into a continuous, illegible block of text.
  - *Root Cause*: Input and resolution use cases did not normalize Windows CRLF (`\r\n`) or literal backslash-escaped sequences (`\\n`), and AI tone refinement prompts lacked instructions to preserve paragraph and list structures.
  - *Resolution*:
    - Standardized line-break normalization (`\r\n` and `\\n` -> `\n`) in `CreateQuickReplyUseCase`, `UpdateQuickReplyUseCase`, and `ResolveQuickReplyUseCase`.
    - Added structural preservation directive to `buildRefineQuickReplyTonePrompt` ensuring AI-assisted tone improvements preserve bullet points, lists, and line breaks.
    - Added unit and router integration tests validating multiline preservation.

- **Persistent Local Media Storage & Streaming (LocalMediaStorageAdapter)**:
  - *Damage*: WhatsApp and Zernio temporary media URLs expire after hours or days, causing broken image/video links in past conversation histories and failing downstream vision/OCR processing.
  - *Root Cause*: Lack of local persistence for ingested media files; media endpoints acted only as a passthrough proxy.
  - *Resolution*:
    - Implemented LocalMediaStorageAdapter satisfying MediaStoragePort to persist media locally under MEDIA_STORAGE_PATH (storage/media) with Docker volume support.
    - Added dual-layer caching (in-memory LRU + disk persistence) in conversations.router.ts.
    - Implemented HTTP Range Requests (Accept-Ranges: bytes) enabling seeking and smooth streaming for WhatsApp audio and video in frontend clients.
    - Added automatic retry with zernioAccountId parameter when external Zernio requests return 400/404.

- **Direct Case Transfer to Agents & In-Chat Traceability**:
  - *Damage*: Case transfers were restricted to department IDs only without direct agent assignment, and agents could not see transfer or assignment history inside the conversation timeline.
  - *Root Cause*: TransferCaseUseCase did not accept "toAgentId", lacked auto-assignment dispatch, and did not emit system messages into the message repository.
  - *Resolution*:
    - Enhanced TransferCaseUseCase to accept "toAgentId" or "toDepartmentId" with auto-assignment fallback to eligible agents.
    - Registered visible system audit messages (author: "system") in the conversation history upon case transfers, manual assignments, and take-control actions for human agent visibility.
    - Broadcasted real-time WebSocket events (MESSAGE_SENT, HUMAN_ASSIGNED, HUMAN_UNASSIGNED).

- **Network Connection Testing & OLT Subnet Traversal**:
  - *Damage*: Testing connections to OLTs located behind MikroTik routers in private subnets failed when the MikroTik microservice was offline or when credentials were omitted.
  - *Root Cause*: Lack of parent router credential hydration and TCP socket fallback probing.
  - *Resolution*:
    - POST /api/admin/settings/network/test-connection now hydrates host, port, and credentials from local database topology.
    - Direct TCP socket fallback probe with latency measurement and parent router reachability checks for OLTs on private subnets.

## [0.2.1] - 2026-10-29

### Added
- **Network Topology Bulk Import (`POST /api/admin/settings/network/import`)**: Enables bulk JSON topology ingestion for MikroTik routers and internal OLTs directly from admin settings without requiring deployment scripts or CI secrets. Supports both `host`/`ip` and `username`/`user` notations with automatic deduplication.
- **Network Topology Backup Export (`GET /api/admin/settings/network/export`)**: Full network topology export with decrypted vault credentials for authorized administrators, allowing portability and cross-environment migration between development, test, and production.
- **Sample Topology Template**: Added `docs/network-topology-sample.json` documenting the expected payload structure for bulk network provisioning.

## [0.2.0] - 2026-10-28

### Added
- **Multi-Queue Availability for Agents (`activeDepartmentIds`)**: Added migration `0042_agent_active_department_ids.sql` providing `active_department_ids TEXT[]` column. Agents can now independently toggle availability per department (e.g. active in primary department, paused in substitute department).
- **Availability Management Endpoint**: `PUT /api/auth/me/availability` supporting `{ autoAssignEnabled: boolean, activeDepartmentIds: string[] }`.
- **Live Balance Synchronization**: Added `SyncCaseBalanceUseCase` and `POST /api/cases/:id/sync-balance` to trigger real-time balance queries via n8n (`CHECK_BALANCE`) without reopening or restarting cases.
- **Contract & Network Data Enrichment**: Enhanced `SyncCaseDataUseCase` to extract and persist `sectorNom`, `barrioNom`, and contract arrays from ERP/Excel data feeds.
- **Enriched OLT Diagnostic Telemetry**: Preserved `_history`, `failedStep`, and CLI execution traces in `TriggerCaseDiagnosticUseCase`, dispatching full diagnostic context to operational audit logs and WebSockets.

### Fixed
- **Image False Positives as Payment Vouchers**:
  - *Damage*: Non-receipt images (e.g. photos of broken routers, red ONT lights, offline TV screens) were falsely classified as payment vouchers, trapping customers in `BILLING_BALANCE` with an automated message *"Estamos verificando tu comprobante de pago..."* and halting technical support.
  - *Root Cause*: In `GeminiVisionAdapter` and `process-buffered-messages.use-case.ts`, an empty receipt entity extraction object defaulted to affirmative receipt handling instead of routing to standard NLU.
  - *Resolution*: Introduced explicit `isReceipt: boolean` flag in vision analysis. Non-receipt images are routed through standard NLU with image captions/context into their appropriate queues (e.g. `SUPPORT_INTERNET`).
- **Frozen Case Balance Snapshot**:
  - *Damage*: Case balance remained permanently frozen at intake value ($22.58 snapshot), preventing agents from observing on-demand accounting updates or client bank transfers.
  - *Root Cause*: Missing balance re-query use case and communication pipeline with accounting workflows.
  - *Resolution*: Implemented `SyncCaseBalanceUseCase` calling n8n `CHECK_BALANCE` and notifying frontend via `case:updated` WebSocket event.
- **Missing Sector & Neighborhood in Internet Support**:
  - *Damage*: Technicians only saw raw MikroTik router slugs rather than human-readable sector and neighborhood names.
  - *Root Cause*: n8n `find-cliend-contract.json` omitted `sector_nom` and `barrio_nom` mapping.
  - *Resolution*: Mapped `sectorNom` and `barrioNom` across n8n, domain entities, and database context.
- **Database Migration Collision**:
  - *Damage*: Concurrent migration file collisions on sequence `0041` during branch merges with `develop`.
  - *Resolution*: Renumbered agent department availability migration to `0042_agent_active_department_ids.sql`.

## [0.1.2] - 2026-10-16

### Added
- **AI Settings**: Endpoint `POST /api/admin/settings/ai/models` to discover and list compatible AI models live from Google Gemini and Ollama APIs.
- **Cost & Capability Tiers**: Classification of inference models into economy, balanced, and performance tiers with recommended indicators.
- **Embedding Models Discovery**: Automated retrieval and dimension alignment for embedding models (e.g. `text-embedding-004` at 768 dims).
- **Security & Secret Protection**: Strict payload-only credential transmission with masking and merging (`mergeSecret`), avoiding sensitive URL query parameters or credential leaks in logs/responses.
