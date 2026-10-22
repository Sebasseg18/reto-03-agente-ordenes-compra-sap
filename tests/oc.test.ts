import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tools } from "../src/tools/oc.js";

const ctx={directory:process.cwd(),sessionId:"test-session"};
async function result(name:keyof typeof tools,args:Record<string,unknown>){
  return JSON.parse(await tools[name].execute(args as never,ctx)) as {ok:boolean;data?:unknown;error?:string};
}
test("lee un paquete normalizado",async()=>{
  const r=await result("leer_paquete",{caso:"sol-001"});
  assert.equal(r.ok,true);
  assert.equal((r.data as {solicitud:{solicitud_id:string}}).solicitud.solicitud_id,"SOL-001");
});
test("bloquea proveedor inexistente sol-002",async()=>{
  const p=await result("leer_paquete",{caso:"sol-002"}); assert.equal(p.ok,true);
  const v=await result("validar",{caso:"sol-002",paquete:p.data});
  assert.equal(v.ok,true); assert.equal((v.data as {apta:boolean}).apta,false);
  assert.match((v.data as {bloqueos:string[]}).bloqueos.join(" "),/RC1/);
});
test("bloquea aprobador no autorizado sol-003",async()=>{
  const p=await result("leer_paquete",{caso:"sol-003"});
  const v=await result("validar",{caso:"sol-003",paquete:p.data});
  assert.equal((v.data as {apta:boolean}).apta,false);
  assert.match((v.data as {bloqueos:string[]}).bloqueos.join(" "),/RC2/);
});
test("sol-004 requiere confirmación por diferencia de cotización",async()=>{
  const p=await result("leer_paquete",{caso:"sol-004"});
  const v=await result("validar",{caso:"sol-004",paquete:p.data});
  assert.equal((v.data as {apta:boolean}).apta,true);
  assert.ok((v.data as {confirmaciones:string[]}).confirmaciones.some(x=>x.includes("RC5")));
});
test("sol-005 se marca retroactiva y requiere confirmación",async()=>{
  const p=await result("leer_paquete",{caso:"sol-005"});
  const v=await result("validar",{caso:"sol-005",paquete:p.data});
  assert.equal((v.data as {derivados:{retroactiva:boolean}}).derivados.retroactiva,true);
  assert.ok((v.data as {confirmaciones:string[]}).confirmaciones.some(x=>x.includes("RC8")));
});
test("sol-006 deriva IVA y condiciones de pago",async()=>{
  const p=await result("leer_paquete",{caso:"sol-006"});
  const v=await result("validar",{caso:"sol-006",paquete:p.data});
  const d=(v.data as {derivados:{indicador_iva:string;condiciones_pago:string};confirmaciones:string[]});
  assert.equal(d.derivados.indicador_iva,"C0"); assert.equal(d.derivados.condiciones_pago,"Z030");
  assert.ok(d.confirmaciones.some(x=>x.includes("RC6")));
});
