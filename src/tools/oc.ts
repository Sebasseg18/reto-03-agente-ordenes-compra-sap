import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";
import type { OrdenCompra } from "../sap/adapter.js";
import { MockSapAdapter } from "../sap/mock.js";

const SolicitudSchema = z.object({
  solicitud_id: z.string(), solicitante: z.string(), proveedor_nombre: z.string(), proveedor_nit: z.string().optional(),
  descripcion: z.string(), centro_costo: z.string(), subarea: z.string(), cantidad: z.number(),
  valor_unitario: z.number(), valor_total: z.number(), moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(), condiciones_pago: z.string().optional(), fecha_solicitud: z.string()
});
const PaqueteSchema = z.object({
  correo: z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() }),
  solicitud: SolicitudSchema,
  cotizacion: z.object({ proveedor: z.string(), nit: z.string().nullable(), total: z.number(), moneda: z.string(), validez_hasta: z.string().nullable(), texto: z.string() }).nullable(),
  aprobacion: z.object({ de: z.string(), fecha: z.string(), aprobado: z.boolean(), texto: z.string() }).nullable(),
  factura: z.object({ numero: z.string(), fecha: z.string(), total: z.number() }).nullable()
});
const PayloadSchema = z.object({
  referencia: z.object({ solicitud_id: z.string(), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"), organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]), condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string() }),
  posiciones: z.array(z.object({ numero: z.number(), descripcion: z.string().max(40), cantidad: z.number(), unidad: z.enum(["UN", "H", "MES"]), precio_unitario: z.number(), centro_costo: z.string(), subarea: z.string(), indicador_iva: z.string() })),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }))
});
type Paquete = z.infer<typeof PaqueteSchema>;
type Derivados = { codigo_sap: string; proveedor_nombre: string; proveedor_nit: string; indicador_iva: string; condiciones_pago: string; aprobador_email: string; retroactiva: boolean; excepciones: Array<{codigo:string;detalle:string;confirmado_por:string|null}> };
type Ctx = { directory: string; sessionId: string; confirmedBy?: string };
const str = (v: unknown) => JSON.stringify(v);
const fail = (e: unknown) => str({ ok: false, error: e instanceof Error ? e.message : String(e) });
async function jsonFile<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
function root(ctx: Ctx, ...parts: string[]) { return path.join(ctx.directory, ...parts); }
async function logControl(ctx: Ctx, row: {solicitud_id:string;resultado:string;numero_oc:string;retroactiva:boolean;bloqueos:string[];confirmaciones:string[]}) {
  const dir = root(ctx, "out"); await mkdir(dir, {recursive:true});
  const file = root(ctx, "out", "control.csv");
  try { await readFile(file, "utf8"); } catch { await writeFile(file, "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"); }
  const esc = (v: string) => `"${v.replaceAll('"','""')}"`;
  await appendFile(file, [row.solicitud_id,row.resultado,row.numero_oc,String(row.retroactiva),esc(row.bloqueos.join("; ")),esc(row.confirmaciones.join("; ")),new Date().toISOString()].join(",")+"\n");
}
export const leer_paquete = {
  description: "Lee y normaliza el paquete de compra desde la carpeta de un caso fixture.",
  args: { caso: z.string().describe("Nombre del caso, por ejemplo sol-001") },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    try {
      if (!/^sol-\d{3}$/.test(args.caso)) return fail("Nombre de caso inválido; usa sol-001 a sol-006.");
      const dir = root(ctx, "fixtures", "reto-03", "solicitudes", args.caso);
      const readOptional = async (name: string) => { try { return await readFile(path.join(dir,name),"utf8"); } catch { return null; } };
      const correoRaw = await readOptional("correo.json"), solicitudRaw = await readOptional("solicitud.json"), cotRaw = await readOptional("cotizacion.txt"), aprobRaw = await readOptional("aprobacion.json"), facturaRaw = await readOptional("factura.txt");
      if (!correoRaw || !solicitudRaw || !aprobRaw) return fail(`Paquete incompleto: faltan ${[!correoRaw&&"correo.json",!solicitudRaw&&"solicitud.json",!aprobRaw&&"aprobacion.json"].filter(Boolean).join(", ")}.`);
      const correo = JSON.parse(correoRaw) as {id:string;de:string;asunto:string;fecha:string};
      const solicitud = SolicitudSchema.parse(JSON.parse(solicitudRaw));
      const aprob = JSON.parse(aprobRaw) as {de:string;para:string;fecha:string;asunto:string;cuerpo:string};
      let cotizacion: Paquete["cotizacion"] = null;
      if (cotRaw) {
        const totalMatch = cotRaw.match(/total\s*:\s*([0-9.]+)/i);
        const nitMatch = cotRaw.match(/nit\s*:\s*([0-9-]+)/i);
        const provMatch = cotRaw.match(/proveedor\s*:\s*(.+)/i);
        const currencyMatch = cotRaw.match(/moneda\s*:\s*(COP|USD)/i);
        cotizacion = { proveedor: provMatch?.[1]?.trim() ?? "", nit: nitMatch?.[1] ?? null, total: totalMatch ? Number(totalMatch[1]) : 0, moneda: currencyMatch?.[1] ?? solicitud.moneda, validez_hasta: null, texto: cotRaw };
      }
      let factura: Paquete["factura"] = null;
      if (facturaRaw) {
        const n = facturaRaw.match(/n[uú]mero\s*:\s*(.+)/i), f = facturaRaw.match(/fecha\s*:\s*(\d{4}-\d{2}-\d{2})/i), t = facturaRaw.match(/total\s*:\s*([0-9.]+)/i);
        if (n && f && t) factura = { numero:n[1].trim(), fecha:f[1], total:Number(t[1]) };
      }
      const paquete = PaqueteSchema.parse({ correo:{id:correo.id,de:correo.de,asunto:correo.asunto,fecha:correo.fecha}, solicitud, cotizacion, aprobacion:{de:aprob.de,fecha:aprob.fecha,aprobado:/aprobado/i.test(aprob.cuerpo),texto:`De: ${aprob.de}\nPara: ${aprob.para}\nFecha: ${aprob.fecha}\nAsunto: ${aprob.asunto}\n\n${aprob.cuerpo}`}, factura });
      return str({ok:true,data:paquete});
    } catch (e) { return fail(e); }
  }
};

export const validar = {
  description: "Valida la solicitud contra los maestros y separa bloqueos de confirmaciones.",
  args: { caso: z.string().describe("Caso fixture, por ejemplo sol-001"), paquete: PaqueteSchema.describe("Paquete normalizado devuelto por oc_leer_paquete") },
  async execute(args: {caso:string;paquete:Paquete}, ctx:Ctx):Promise<string> {
    try {
      const p=args.paquete, s=p.solicitud;
      const [proveedores, centros, ivas, pagos] = await Promise.all([
        jsonFile<Array<{codigo_sap:string;nit:string;nombre:string;condiciones_pago_default:string;indicador_iva_default:string;activo:boolean}>>(root(ctx,"fixtures/reto-03/maestros/proveedores.json")),
        jsonFile<Array<{centro_costo:string;subareas:string[];aprobadores:Array<{email:string;tope:number}>}>>(root(ctx,"fixtures/reto-03/maestros/centros-costo.json")),
        jsonFile<Array<{codigo:string;descripcion:string;tasa:number}>>(root(ctx,"fixtures/reto-03/maestros/indicadores-iva.json")),
        jsonFile<Array<{codigo:string;descripcion:string;dias:number}>>(root(ctx,"fixtures/reto-03/maestros/condiciones-pago.json"))
      ]);
      const bloqueos:string[]=[], confirmaciones:string[]=[], derivados:Partial<Derivados>={};
      const norm=(x:string)=>x.trim().toLocaleLowerCase("es");
      const prov=proveedores.find(x=>s.proveedor_nit ? x.nit===s.proveedor_nit : norm(x.nombre)===norm(s.proveedor_nombre));
      if(!prov || !prov.activo) bloqueos.push(`RC1: proveedor ${s.proveedor_nombre} (${s.proveedor_nit??"sin NIT"}) inexistente o inactivo.`);
      const centro=centros.find(x=>x.centro_costo===s.centro_costo);
      const aprob=p.aprobacion;
      const aprobador=centro?.aprobadores.find(x=>norm(x.email)===norm(aprob?.de??""));
      if(!aprob || !aprob.aprobado || !aprobador) bloqueos.push("RC2: falta aprobación válida o el emisor no está autorizado para este centro de costo.");
      if(aprobador && s.valor_total>aprobador.tope) bloqueos.push(`RC3: el total ${s.valor_total} supera el tope ${aprobador.tope} del aprobador.`);
      if(!centro || !centro.subareas.includes(s.subarea)) bloqueos.push(`RC4: la subárea ${s.subarea} no pertenece al centro de costo ${s.centro_costo}.`);
      if(p.cotizacion) {
        const diff=Math.abs(p.cotizacion.total-s.valor_total)/Math.max(Math.abs(s.valor_total),1);
        if(diff>0.02) confirmaciones.push(`RC5: cotización ${p.cotizacion.total} COP y solicitud ${s.valor_total} ${s.moneda}; diferencia ${(diff*100).toFixed(2)}%.`);
      } else confirmaciones.push("RC5: no se encontró cotización; confirma continuar sin ella.");
      const iva=s.indicador_iva??prov?.indicador_iva_default;
      if(!s.indicador_iva) confirmaciones.push(`RC6: indicador IVA ausente; se propone ${iva??"sin valor"} desde el maestro del proveedor.`);
      if(!iva || !ivas.some(x=>x.codigo===iva)) bloqueos.push(`RC6: indicador IVA ${iva??"(vacío)"} no existe en el maestro.`);
      if(!s.condiciones_pago && prov) derivados.condiciones_pago=prov.condiciones_pago_default;
      const pago=s.condiciones_pago??prov?.condiciones_pago_default;
      if(!pago || !pagos.some(x=>x.codigo===pago)) bloqueos.push(`RC7: condiciones de pago ${pago??"(vacías)"} no existen en el maestro.`);
      if(p.factura && p.factura.fecha < s.fecha_solicitud) { derivados.retroactiva=true; confirmaciones.push(`RC8: factura ${p.factura.numero} del ${p.factura.fecha} es anterior a la solicitud ${s.fecha_solicitud}.`); }
      if(aprob && aprob.fecha < s.fecha_solicitud) confirmaciones.push(`RC9: la aprobación (${aprob.fecha}) es anterior a la solicitud (${s.fecha_solicitud}).`);
      if(Math.abs(s.cantidad*s.valor_unitario-s.valor_total)>1) bloqueos.push(`RC10: cantidad × precio (${s.cantidad*s.valor_unitario}) no coincide con el total ${s.valor_total} (tolerancia ±1).`);
      if(!prov) bloqueos.push("No se puede construir una OC sin un proveedor identificado en el maestro.");
      if(aprobador) derivados.aprobador_email=aprobador.email;
      if(prov) { derivados.codigo_sap=prov.codigo_sap; derivados.proveedor_nombre=prov.nombre; derivados.proveedor_nit=prov.nit; derivados.indicador_iva=iva??""; }
      derivados.retroactiva=derivados.retroactiva??false;
      derivados.excepciones=[...confirmaciones.map((detalle,i)=>({codigo:`RC${[5,6,8,9][i]??"EX"}`,detalle,confirmado_por:null}))];
      const result={apta:bloqueos.length===0,bloqueos,confirmaciones,derivados};
      const caseOut=root(ctx,"out",args.caso); await mkdir(caseOut,{recursive:true});
      await writeFile(path.join(caseOut,"validacion.json"),JSON.stringify(result,null,2),"utf8");
      await logControl(ctx,{solicitud_id:s.solicitud_id,resultado:bloqueos.length?"bloqueada":confirmaciones.length?"pendiente_confirmacion":"validada",numero_oc:"",retroactiva:!!derivados.retroactiva,bloqueos,confirmaciones});
      return str({ok:true,data:result});
    } catch(e) { return fail(e); }
  }
};

export const generar_evidencia = {
  description: "Guarda la aprobación normalizada en texto y PDF con hash SHA-256.",
  args: { caso:z.string().describe("Caso fixture, por ejemplo sol-001") },
  async execute(args:{caso:string},ctx:Ctx):Promise<string> {
    try {
      const dir=root(ctx,"fixtures","reto-03","solicitudes",args.caso), raw=await readFile(path.join(dir,"aprobacion.json"),"utf8");
      const a=JSON.parse(raw) as {de:string;para:string;fecha:string;asunto:string;cuerpo:string};
      const content=`De: ${a.de}\nPara: ${a.para}\nFecha: ${a.fecha}\nAsunto: ${a.asunto}\n\n${a.cuerpo}\n`;
      const hash=createHash("sha256").update(content).digest("hex");
      const out=root(ctx,"out",args.caso); await mkdir(out,{recursive:true});
      await writeFile(path.join(out,"aprobacion.txt"),`${content}\nSHA-256: ${hash}\n`,"utf8");
      const pdf=await PDFDocument.create(), page=pdf.addPage([595,842]), font=await pdf.embedFont(StandardFonts.Helvetica);
      const lines=content.split("\n"); let y=800;
      for(const line of lines){ page.drawText(line.slice(0,110),{x:45,y,size:10,font}); y-=16; if(y<45) break; }
      await writeFile(path.join(out,"aprobacion.pdf"),await pdf.save());
      return str({ok:true,data:{ruta:`out/${args.caso}/aprobacion.txt`,ruta_pdf:`out/${args.caso}/aprobacion.pdf`,sha256:hash}});
    } catch(e){return fail(e);}
  }
};

export const construir_payload = {
  description: "Construye y valida el payload de la orden de compra y guarda trazabilidad.",
  args: { caso:z.string().describe("Caso fixture"), paquete:PaqueteSchema.describe("Paquete normalizado"), derivados:z.record(z.unknown()).describe("Derivados devueltos por oc_validar") },
  async execute(args:{caso:string;paquete:Paquete;derivados:Record<string,unknown>},ctx:Ctx):Promise<string>{
    try {
      const s=args.paquete.solicitud, d=args.derivados as unknown as Derivados;
      if(!d.codigo_sap || !d.aprobador_email || !d.indicador_iva || !d.condiciones_pago) return fail("Faltan derivados necesarios; valida el paquete y resuelve los bloqueos.");
      const evidencePath=root(ctx,"out",args.caso,"aprobacion.txt");
      let evidence:string; try { evidence=await readFile(evidencePath,"utf8"); } catch { return fail("Genera primero la evidencia con oc_generar_evidencia."); }
      const hash=evidence.match(/SHA-256: ([a-f0-9]+)/)?.[1]??createHash("sha256").update(evidence).digest("hex");
      const payload:OrdenCompra={
        referencia:{solicitud_id:s.solicitud_id,correo_id:args.paquete.correo.id,cotizacion_ref:args.paquete.cotizacion?`cotizacion-${args.caso}`:null},
        sociedad:"1000",organizacion_compras:"1000",
        proveedor:{codigo_sap:d.codigo_sap,nit:d.proveedor_nit,nombre:d.proveedor_nombre},
        moneda:s.moneda,condiciones_pago:s.condiciones_pago??d.condiciones_pago,
        aprobador:{email:d.aprobador_email,fecha_aprobacion:args.paquete.aprobacion?.fecha??"",evidencia_sha256:hash},
        posiciones:[{numero:10,descripcion:s.descripcion.slice(0,40),cantidad:s.cantidad,unidad:"UN",precio_unitario:s.valor_unitario,centro_costo:s.centro_costo,subarea:s.subarea,indicador_iva:s.indicador_iva??d.indicador_iva}],
        excepciones:(d.excepciones??[]).map(e=>({...e,confirmado_por:ctx.confirmedBy??null}))
      };
      const valid=PayloadSchema.safeParse(payload); if(!valid.success) return fail(`Payload inválido: ${valid.error.message}`);
      const trace:Record<string,{valor:unknown;fuente:string}>={
        "referencia.solicitud_id":{valor:s.solicitud_id,fuente:"solicitud.solicitud_id"},
        "referencia.correo_id":{valor:args.paquete.correo.id,fuente:"correo.id"},
        "proveedor.codigo_sap":{valor:d.codigo_sap,fuente:"maestro.proveedores"},
        "proveedor.nit":{valor:d.proveedor_nit,fuente:"maestro.proveedores"},
        "proveedor.nombre":{valor:d.proveedor_nombre,fuente:"maestro.proveedores"},
        "condiciones_pago":{valor:payload.condiciones_pago,fuente:s.condiciones_pago?"solicitud.condiciones_pago":"derivado.maestro.proveedores"},
        "indicador_iva":{valor:payload.posiciones[0]?.indicador_iva,fuente:s.indicador_iva?"solicitud.indicador_iva":"derivado.maestro.proveedores"},
        "centro_costo":{valor:s.centro_costo,fuente:"solicitud.centro_costo"},
        "subarea":{valor:s.subarea,fuente:"solicitud.subarea"},
        "valor_total":{valor:s.valor_total,fuente:"solicitud.valor_total"}
      };
      const out=root(ctx,"out",args.caso); await mkdir(out,{recursive:true});
      await writeFile(path.join(out,"trazabilidad.json"),JSON.stringify(trace,null,2));
      await writeFile(path.join(out,"payload.json"),JSON.stringify(payload,null,2));
      return str({ok:true,data:{payload, ruta_trazabilidad:`out/${args.caso}/trazabilidad.json`}});
    }catch(e){return fail(e);}
  }
};

export const crear = {
  description: "Crea una orden en SAP simulado solo si no hay bloqueos y las excepciones están confirmadas.",
  args: { caso:z.string().describe("Caso fixture"), payload:PayloadSchema.describe("Payload validado"), confirmado:z.boolean().optional().describe("Debe ser true si el flujo requiere confirmación humana") },
  async execute(args:{caso:string;payload:OrdenCompra;confirmado?:boolean},ctx:Ctx):Promise<string>{
    try {
      const dir=root(ctx,"fixtures","reto-03","solicitudes",args.caso);
      const raw=await readFile(path.join(dir,"solicitud.json"),"utf8"), s=SolicitudSchema.parse(JSON.parse(raw));
      const validationFile=root(ctx,"out",args.caso,"validacion.json");
      let validation:{apta:boolean;bloqueos:string[];confirmaciones:string[];derivados:{retroactiva?:boolean}};
      try { validation=JSON.parse(await readFile(validationFile,"utf8")) as typeof validation; }
      catch { return fail("No hay validación guardada para este caso; ejecuta oc_validar primero."); }
      if(!validation.apta || validation.bloqueos.length) { await logControl(ctx,{solicitud_id:s.solicitud_id,resultado:"bloqueada",numero_oc:"",retroactiva:!!validation.derivados.retroactiva,bloqueos:validation.bloqueos,confirmaciones:validation.confirmaciones}); return fail(`OC bloqueada: ${validation.bloqueos.join(" | ")}`); }
      if(validation.confirmaciones.length && args.confirmado!==true) { await logControl(ctx,{solicitud_id:s.solicitud_id,resultado:"pendiente_confirmacion",numero_oc:"",retroactiva:!!validation.derivados.retroactiva,bloqueos:[],confirmaciones:validation.confirmaciones}); return fail("Se requiere confirmación humana explícita antes de crear."); }
      const sap=new MockSapAdapter(root(ctx,"out"));
      const existing=await sap.buscarOrdenPorReferencia(s.solicitud_id);
      const result=await sap.crearOrden(args.payload);
      await logControl(ctx,{solicitud_id:s.solicitud_id,resultado:existing?"idempotente":"creada",numero_oc:result.numero_oc,retroactiva:!!validation.derivados.retroactiva,bloqueos:[],confirmaciones:validation.confirmaciones});
      return str({ok:true,data:{...result,idempotente:!!existing,retroactiva:!!validation.derivados.retroactiva}});
    }catch(e){return fail(e);}
  }
};

export const tools = { leer_paquete, validar, generar_evidencia, construir_payload, crear };
