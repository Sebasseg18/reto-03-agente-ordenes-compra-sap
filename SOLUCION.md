# SOLUCION — Reto técnico 03: Agente de órdenes de compra SAP

## 1. Problema en una frase
Automatizar la preparación de órdenes de compra para el equipo administrativo, reduciendo digitación manual y aplicando controles consistentes antes de registrar una orden.

## 2. Arquitectura
```text
Web chat (web/index.html)
        | HTTP POST /api/chat
        v
Express (src/server.ts) -----> OpenAI adapter (src/llm/openai.ts)
        |                               |
        | llamadas validadas            | tool calls
        v                               v
src/tools/oc.ts <-----------------------+
  | lectura solo de fixtures/
  | reglas de negocio + Zod
  +--> out/<caso>/ (evidencia, payload, trazabilidad)
  +--> out/control.csv y out/log.jsonl
  +--> src/sap/mock.ts -> out/sap/ordenes.jsonl
```
El comportamiento conversacional está en `agent/prompt.md`; el conocimiento del proceso está en `src/knowledge/ordenes-compra.md`; la ejecución determinista vive en `src/tools/oc.ts`. La API no depende de una base de datos.

## 3. Ciclo del agente
El backend envía el prompt, el historial reciente y las definiciones de herramientas al adaptador OpenAI. Las llamadas se validan con Zod antes de ejecutar. El bucle tiene límite configurable (`MAX_TOOL_ITERATIONS`). Cada llamada se muestra en el chat y se escribe en `out/log.jsonl`. La API devuelve `needsConfirmation` cuando hay excepciones confirmables. Una confirmación posterior explícita permite reanudar el caso pendiente. Las reglas de bloqueo se ejecutan en código, no solo en el prompt.

## 4. Elección del modelo y costo
Se eligió OpenAI API con `gpt-4o-mini` por su soporte de llamadas a herramientas y costo relativo bajo para tareas administrativas estructuradas. El modelo se configura por `OPENAI_MODEL`; la clave se lee de `OPENAI_API_KEY` en backend. El costo exacto depende de tokens de entrada/salida, modelo y número de iteraciones; se debe estimar con la tarifa vigente de OpenAI y medir tokens en un piloto. No se afirma un precio fijo sin medición.

## 5. Matriz de controles

| Regla | Implementación | Resultado esperado |
|---|---|---|
| RC1 | Buscar proveedor por NIT o nombre normalizado; exigir activo | `sol-002` bloqueada |
| RC2 | Aprobación presente, contiene “Aprobado” y emisor autorizado | `sol-003` bloqueada |
| RC3 | Comparar total con tope del aprobador | Bloqueo si excede |
| RC4 | Subárea debe pertenecer al centro | Bloqueo si no pertenece |
| RC5 | Diferencia relativa de cotización >2% o ausente | Confirmación |
| RC6 | Derivar IVA del proveedor y pedir confirmación si faltaba | `sol-006` pide confirmación |
| RC7 | Derivar condiciones de pago del proveedor | Se informa en derivados |
| RC8 | Factura anterior a solicitud | `sol-005` retroactiva + confirmación |
| RC9 | Aprobación anterior a solicitud | Confirmación |
| RC10 | Cantidad × precio vs total con tolerancia ±1 | Bloqueo si no coincide |

La parte más delicada es mantener la separación entre bloqueo y confirmación: aceptar una excepción nunca debe habilitar un proveedor inexistente ni una aprobación sin autoridad.

## 6. Diseño del adaptador SAP real
La primera opción sería SAP OData `API_PURCHASEORDER_PROCESS_SRV` si la versión y configuración de SAP lo soportan, porque ofrece un contrato HTTP explícito y desacopla el backend del protocolo SAP de bajo nivel. Antes de implementarlo se validan versión, entidades, campos obligatorios, estrategias de autenticación, permisos y ambiente sandbox con el equipo SAP. Si OData no está disponible, evaluaría RFC/BAPI `BAPI_PO_CREATE1` a través de middleware administrado, o SAP Integration Suite.

Mapeo conceptual:
- `referencia.solicitud_id` → referencia externa / campo de cabecera permitido por configuración.
- `sociedad` y `organizacion_compras` → campos de cabecera de compras.
- `proveedor.codigo_sap`, moneda y condiciones de pago → cabecera.
- `posiciones[]` → ítems con descripción, cantidad, precio, centro de costo y asignación contable.
- `indicador_iva` → código fiscal configurado en SAP.
- `aprobador` y `evidencia_sha256` → campos de referencia o anexo/documento vinculado, según extensiones disponibles.
- `excepciones` → registro de auditoría del middleware; no sustituye la aprobación corporativa.

Las credenciales residirían en un gestor de secretos o configuración segura del entorno/middleware, con identidad técnica de privilegio mínimo, TLS, rotación y auditoría. Nunca estarían en el prompt, el navegador ni los fixtures.

Para idempotencia usaría una clave de negocio estable basada en `solicitud_id`, persistida en middleware y/o un campo de referencia consultable en SAP antes de crear. Tras timeout no se reintenta ciegamente: primero se consulta si SAP alcanzó a crear la OC. Los errores parciales se normalizan, se registra el identificador de correlación y se devuelve una tarea de conciliación humana. Plan B: generar payload validado y archivo de carga masiva o una pantalla de revisión/copia asistida.

## 7. Lectura del proceso para dirección
La orden retroactiva es un indicador de control del proceso, no solamente un error de digitación. Si la factura llega antes que la solicitud o la cotización, se pierde capacidad de demostrar que el gasto se evaluó y autorizó antes de comprometer recursos. Conviene medir semanalmente el porcentaje de órdenes retroactivas, su valor, áreas de origen, proveedor y motivo. No se recomienda que el agente oculte ni rechace silenciosamente esos casos: debe etiquetarlos, conservar la evidencia y pedir decisión según la política que defina Finanzas y Compras. La mejora estructural es mover la solicitud y cotización al inicio del proceso, usar un identificador común desde la solicitud hasta la factura y crear alertas cuando la factura antecede a la orden. Una política de excepción documentada debe definir quién autoriza regularizaciones, qué evidencia se requiere y cómo se reportan reincidencias.

## 8. Decisiones y trade-offs
1. **Fixtures JSON/texto en lugar de leer Excel/PDF reales.** Cumple P0 y mantiene el comportamiento reproducible; se descartó parsing binario porque el reto lo marca opcional.
2. **Archivos locales en lugar de base de datos.** Es sencillo de auditar y cumple el alcance; para producción hace falta almacenamiento transaccional persistente.
3. **OpenAI tool calling detrás de interfaz propia.** Facilita cambiar proveedor sin reescribir herramientas; el proveedor introduce costo, latencia y dependencia externa.
4. **Adaptador SAP simulado.** Permite demostrar flujo e idempotencia sin credenciales corporativas; no demuestra compatibilidad real con una instalación SAP.
5. **Confirmación por mensaje posterior.** Es clara para el usuario; una implementación de producción debe vincular la confirmación al resumen exacto aprobado y conservar quién/cuándo confirmó.

## 9. Supuestos
- Los maestros ficticios incluidos representan el esquema del PRD, no datos reales.
- Los valores monetarios se comparan como números en una sola moneda por solicitud.
- La cotización de texto utiliza líneas `Proveedor:`, `NIT:`, `Total:` y `Moneda:` para facilitar la lectura determinista.
- La unidad por defecto del fixture es `UN`; el esquema puede ampliarse con unidad normalizada.
- El SAP mock es un simulador local, no una integración real.

## 10. Cobertura

| Historia / requisito | Estado | Pendiente para producción |
|---|---|---|
| HU-1 leer paquete | Hecho para fixtures JSON/texto | Lectura de correo/Excel/PDF reales |
| HU-2 validar maestros | Hecho en lógica principal | Maestros consultados en tiempo real |
| HU-3 payload y trazabilidad | Hecho | Contrato validado contra SAP destino |
| HU-4 evidencia | Hecho: TXT, SHA-256 y PDF | Firma digital / repositorio documental corporativo |
| HU-5 crear OC | Hecho con SAP mock e idempotencia | Adaptador OData/RFC real y persistencia robusta |
| HU-6 errores | Parcial: errores legibles en herramientas/API | Catálogo de errores, métricas y pruebas de resiliencia |
| Chat y tool calls | Hecho en interfaz básica | Autenticación, streaming, accesibilidad avanzada |
| `demo.ts` sin modelo | Hecho | Revisar fixtures oficiales si son entregados |
| Link público | No incluido en el ZIP | Desplegar en Render u otro host |

## 11. Uso de IA
Se utilizó ChatGPT como asistente de desarrollo para estructurar el proyecto, proponer código inicial, fixtures ficticios, pruebas y documentación a partir del PRD. Antes de entregar, el candidato debe ejecutar las pruebas, revisar cada archivo, ajustar el código y poder explicar las decisiones. No se debe declarar que se usaron asistentes distintos si no fue así. Los valores ficticios se crearon para cubrir los seis escenarios de aceptación.

## 12. Riesgos y mitigaciones
- **Confirmación aplicada al caso equivocado:** guardar el caso pendiente y mostrar resumen; en producción, firmar la confirmación con un identificador de versión del payload.
- **Reintentos duplicados:** idempotencia por solicitud y consulta previa antes de reintentar.
- **Exposición de claves:** variables de entorno y gestor de secretos; no registrar headers ni secretos.
- **Datos de maestro desactualizados:** consultar sistemas fuente y guardar fecha/versión del maestro.
- **Prompt injection en correo:** tratar contenido de correo como datos no confiables y permitir acciones solo mediante herramientas y controles deterministas.
- **Costo o abuso de API:** autenticación, rate limits, límite de tokens y cuota por usuario.
- **Persistencia efímera en hosting:** base de datos/volumen persistente y copias de seguridad.
- **Fallo de integración SAP:** sandbox, trazabilidad, reconciliación y plan B de archivo de carga.
