# Conocimiento del proceso de órdenes de compra

## Flujo
1. Leer correo, solicitud normalizada, cotización, aprobación y factura opcional.
2. Validar los datos contra los maestros locales.
3. Separar bloqueos (detienen el flujo) de confirmaciones (requieren consentimiento explícito).
4. Derivar condiciones de pago e indicador IVA desde el maestro del proveedor cuando falten.
5. Construir payload con trazabilidad por campo.
6. Guardar evidencia de aprobación y hash SHA-256.
7. Crear la OC en el SAP simulado, registrar auditoría e idempotencia.

## Reglas
- RC1 proveedor existente y activo, preferentemente por NIT.
- RC2 aprobación presente, contiene “Aprobado” y el emisor figura como aprobador del centro.
- RC3 total no supera el tope del aprobador.
- RC4 subárea pertenece al centro de costo.
- RC5 diferencia relativa entre cotización y solicitud <= 2%; de lo contrario confirmación. Cotización ausente también requiere confirmación.
- RC6 IVA ausente: derivar del proveedor y pedir confirmación.
- RC7 condiciones de pago ausentes: derivar del proveedor e informar.
- RC8 factura anterior a la solicitud: marcar retroactiva y pedir confirmación.
- RC9 aprobación anterior a la solicitud: pedir confirmación.
- RC10 cantidad × precio unitario debe igualar el total con tolerancia de una unidad monetaria.

## Seguridad
El modelo propone llamadas; el backend valida argumentos con Zod y ejecuta herramientas locales. No se permite que el modelo cree datos maestros ni cambie los valores calculados. Los bloqueos se aplican en código, no solo en el prompt.
