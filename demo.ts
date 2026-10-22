import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tools } from "./src/tools/oc.js";

const root=process.cwd(), ctx={directory:root,sessionId:"demo-session"};
const out=path.join(root,"out");
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
const run=async(name:keyof typeof tools,args:Record<string,unknown>)=>{
  const raw=await tools[name].execute(args as never,ctx);
  const result=JSON.parse(raw) as {ok:boolean;data?:unknown;error?:string};
  console.log(`  ${String(name)}: ${result.ok?"OK":"ERROR"}${result.error?` — ${result.error}`:""}`);
  return result;
};
for(const caso of ["sol-001","sol-002","sol-003","sol-004","sol-005","sol-006"]){
  console.log(`\n=== ${caso} ===`);
  const loaded=await run("leer_paquete",{caso});
  if(!loaded.ok)continue;
  const paquete=loaded.data as never;
  const valid=await run("validar",{caso,paquete});
  if(!valid.ok)continue;
  const v=valid.data as {apta:boolean;bloqueos:string[];confirmaciones:string[];derivados:Record<string,unknown>};
  console.log("  apta:",v.apta,"bloqueos:",v.bloqueos,"confirmaciones:",v.confirmaciones,"retroactiva:",v.derivados.retroactiva);
  if(!v.apta)continue;
  const evidence=await run("generar_evidencia",{caso});
  if(!evidence.ok)continue;
  const payloadResult=await run("construir_payload",{caso,paquete,derivados:v.derivados});
  if(!payloadResult.ok)continue;
  const payload=(payloadResult.data as {payload:unknown}).payload;
  const requires=v.confirmaciones.length>0;
  const created=await run("crear",{caso,payload,confirmado:requires});
  if(caso==="sol-001"&&created.ok){
    console.log("  comprobando idempotencia: segunda creación");
    await run("crear",{caso,payload,confirmado:false});
  }
  if(caso==="sol-004")console.log("  demo: confirmación explícita simulada para comprobar la ruta de creación.");
}
console.log("\nDemo finalizada. Resultados en out/; se puede ejecutar sin OPENAI_API_KEY.");
