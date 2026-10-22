import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OrdenCompra, SapAdapter } from "./adapter.js";

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra };
export class MockSapAdapter implements SapAdapter {
  private readonly file: string;
  constructor(directory: string) { this.file = path.join(directory, "sap", "ordenes.jsonl"); }

  private async registros(): Promise<Registro[]> {
    try {
      const raw = await readFile(this.file, "utf8");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Registro);
    } catch { return []; }
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const base = path.resolve("fixtures/reto-03/maestros/proveedores.json");
    try {
      const rows = JSON.parse(await readFile(base, "utf8")) as Array<{ nit: string; codigo_sap: string; activo: boolean }>;
      const found = rows.find((row) => row.nit === nit);
      return found ? { codigo_sap: found.codigo_sap, activo: found.activo } : null;
    } catch { return null; }
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const found = (await this.registros()).find((row) => row.orden.referencia.solicitud_id === solicitud_id);
    return found ? { numero_oc: found.numero_oc } : null;
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const existing = await this.buscarOrdenPorReferencia(orden.referencia.solicitud_id);
    if (existing) return { ...existing, fecha: (await this.registros()).find(r => r.numero_oc === existing.numero_oc)?.fecha ?? new Date().toISOString() };
    const rows = await this.registros();
    const max = rows.reduce((n, row) => Math.max(n, Number(row.numero_oc)), 4500000000);
    const result = { numero_oc: String(max + 1), fecha: new Date().toISOString() };
    await appendFile(this.file, JSON.stringify({ ...result, orden }) + "\n", "utf8");
    return result;
  }
}
