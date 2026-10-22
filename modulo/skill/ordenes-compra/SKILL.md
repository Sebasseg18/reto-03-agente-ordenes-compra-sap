---
name: ordenes-compra
description: Conocimiento de controles, excepciones y flujo para preparar órdenes de compra.
---
# Flujo de órdenes de compra
Leer el paquete, validar proveedores/aprobadores/centros de costo/montos, derivar valores desde maestros, generar evidencia con SHA-256, construir payload trazable y crear solo después de resolver confirmaciones.

Bloqueos: proveedor inexistente/inactivo, aprobación ausente o no autorizada, monto sobre el tope, subárea inválida, IVA/condiciones no válidos, descuadre de cantidad × precio.
Confirmaciones: cotización ausente o con diferencia mayor al 2%, IVA derivado, factura anterior a solicitud y aprobación anterior a solicitud.
Nunca permitas que una confirmación elimine un bloqueo obligatorio.
