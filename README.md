# Reto técnico 03 — Agente de órdenes de compra SAP

Aplicación de demostración con interfaz web, backend TypeScript/Express, agente OpenAI tool-calling, herramientas Zod, fixtures ficticios y adaptador SAP simulado.

## Requisitos
- Node.js 20 o superior (recomendado Node 22 LTS)
- npm
- Clave de OpenAI API para el modo conversacional con IA. La demo y las pruebas de herramientas no necesitan clave.

## Inicio en Windows / VS Code
1. Descomprime el proyecto y abre la carpeta en VS Code.
2. Abre Terminal → New Terminal.
3. Instala dependencias:
   ```powershell
   npm install
   ```
4. Copia la plantilla de entorno:
   ```powershell
   Copy-Item .env.example .env
   ```
5. Edita `.env` y configura `OPENAI_API_KEY=tu_clave`. No compartas ni subas este archivo a Git.
6. Arranca:
   ```powershell
   npm run dev
   ```
7. Abre http://localhost:3000.

Si no tienes una clave, puedes ejecutar `npm run demo` y `npm test`; la interfaz responderá que la IA requiere configuración.

## Comandos
- `npm run dev`: servidor de desarrollo.
- `npm start`: inicia el servidor.
- `npm run demo`: ejecuta las herramientas sin modelo y limpia `out/` al inicio.
- `npm test`: pruebas automatizadas.
- `npm run typecheck`: verificación TypeScript.

## API
- `GET /api/health`: estado del backend y proveedor (nunca muestra claves).
- `POST /api/chat`: JSON `{ "sessionId": "opcional", "message": "Procesa sol-001" }`.
- `GET /api/sessions/:id`: historial de la sesión.

## Casos
- `sol-001`: compra normal.
- `sol-002`: proveedor inexistente (bloqueo).
- `sol-003`: aprobador no autorizado (bloqueo).
- `sol-004`: diferencia de cotización (confirmación).
- `sol-005`: factura anterior a la solicitud (retroactiva).
- `sol-006`: IVA y condiciones de pago derivados.

Todos los datos son ficticios y creados para este reto. El adaptador SAP escribe en `out/sap/ordenes.jsonl`; no hay conexión real a SAP.

## Despliegue
Recomendado: Render como Web Service con runtime Node. Sube el repositorio a GitHub y crea un Web Service desde él.
- Build command: `npm install && npm run typecheck`
- Start command: `npm start`
- Environment variables: `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-4o-mini`, `MAX_TOOL_ITERATIONS=25`, `MAX_SESSION_MESSAGES=60`.
- No configures `OPENAI_API_KEY` en el frontend ni la incluyas en logs.
- La escritura en el sistema de archivos del despliegue puede ser efímera; para una demo está bien. Para producción se requiere almacenamiento persistente.
- Después del despliegue, comprueba `https://TU-SERVICIO.onrender.com/api/health` y abre la URL raíz.

No se ha desplegado automáticamente este proyecto ni se ha generado una URL pública desde este entorno. El enlace se obtiene al crear el servicio en Render u otro host.

## Seguridad y límites
La clave de OpenAI solo se lee en el servidor. La app es un prototipo de evaluación, no está preparada para datos reales: no tiene autenticación, almacenamiento duradero, controles de gasto por usuario ni integración SAP real.
