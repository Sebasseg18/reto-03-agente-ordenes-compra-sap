import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OpenAiAdapter } from "./llm/openai.js";
import type { ChatMessage, ToolDefinition } from "./llm/adapter.js";
import { tools } from "./tools/oc.js";

const app=express(); app.use(cors()); app.use(express.json({limit:"1mb"}));
app.use(express.static(path.resolve("web")));
const root=process.cwd(), out=path.join(root,"out");
type ToolEntry={description:string;args:Record<string,z.ZodTypeAny>;execute:(args:never,ctx:{directory:string;sessionId:string;confirmedBy?:string})=>Promise<string>};
const toolMap=tools as unknown as Record<string,ToolEntry>;
const sessions=new Map<string,{messages:ChatMessage[];pendingCase:string|null;pendingConfirm:boolean;lastPackage:unknown;lastValidation:unknown;lastPayload:unknown;toolCalls:Array<{name:string;arguments:unknown;result:unknown}>}>();
const schemaFor=(entry:ToolEntry)=>z.object(entry.args);
const definitions:ToolDefinition[]=Object.entries(toolMap).map(([exportName,entry])=>({name:`oc_${exportName}`,description:entry.description,parameters:{type:"object",properties:Object.fromEntries(Object.entries(entry.args).map(([key,val])=>[key,{type:"string",description:val.description??key}])),required:Object.keys(entry.args),additionalProperties:false}}));
// Use explicit JSON schemas for the complex arguments accepted by tools.
for(const d of definitions){
  if(d.name==="oc_validar") d.parameters={type:"object",properties:{caso:{type:"string"},paquete:{type:"object",description:"Paquete JSON devuelto por oc_leer_paquete"}},required:["caso","paquete"],additionalProperties:false};
  if(d.name==="oc_construir_payload") d.parameters={type:"object",properties:{caso:{type:"string"},paquete:{type:"object"},derivados:{type:"object"}},required:["caso","paquete","derivados"],additionalProperties:false};
  if(d.name==="oc_crear") d.parameters={type:"object",properties:{caso:{type:"string"},payload:{type:"object"},confirmado:{type:"boolean"}},required:["caso","payload"],additionalProperties:false};
}
const systemPrompt=await readFile(path.join(root,"agent/prompt.md"),"utf8");
async function writeLog(item:unknown){await mkdir(out,{recursive:true});await appendFile(path.join(out,"log.jsonl"),JSON.stringify({ts:new Date().toISOString(),...item as object})+"\n");}
function parseResult(raw:string):{ok:boolean;data?:unknown;error?:string}{try{return JSON.parse(raw) as {ok:boolean;data?:unknown;error?:string};}catch{return {ok:false,error:raw};}}
function caseFromMessage(message:string):string|null{return message.match(/\bsol-\d{3}\b/i)?.[0]?.toLowerCase()??null;}
function looksLikeConfirmation(message:string){return /^(s[ií]|confirmo|confirmar|de acuerdo|proceda|adelante|sí, confirmo)[\s.!]*$/i.test(message.trim());}
app.get("/api/health",(_req,res)=>res.json({ok:true,provider:process.env.OPENAI_API_KEY?"openai":"not_configured",model:process.env.OPENAI_MODEL??"gpt-4o-mini"}));
app.get("/api/sessions/:id", (req,res)=>{const s=sessions.get(req.params.id);if(!s)return res.status(404).json({error:"Sesión no encontrada"});res.json({messages:s.messages,toolCalls:s.toolCalls,needsConfirmation:s.pendingConfirm});});
app.post("/api/chat",async(req,res)=>{
  const body=z.object({sessionId:z.string().optional(),message:z.string().min(1).max(5000)}).safeParse(req.body);
  if(!body.success)return res.status(400).json({reply:"Solicitud inválida. Escribe un mensaje de hasta 5000 caracteres.",toolCalls:[],needsConfirmation:false});
  const sessionId=body.data.sessionId??randomUUID(), message=body.data.message;
  const session=sessions.get(sessionId)??{messages:[],pendingCase:null,pendingConfirm:false,lastPackage:null,lastValidation:null,lastPayload:null,toolCalls:[]};
  sessions.set(sessionId,session);session.messages.push({role:"user",content:message});
  if(looksLikeConfirmation(message)&&session.pendingConfirm&&session.pendingCase&&session.lastPackage&&session.lastValidation){
    const validation=session.lastValidation as {apta:boolean;bloqueos:string[];confirmaciones:string[];derivados:Record<string,unknown>};
    if(!validation.apta||validation.bloqueos.length){session.pendingConfirm=false;return res.json({sessionId,reply:"No puedo crear la OC porque existen bloqueos obligatorios. Corrige los datos indicados y vuelve a procesar el caso.",toolCalls:session.toolCalls.slice(-10),needsConfirmation:false});}
    try{
      const evidence=parseResult(await toolMap.generar_evidencia.execute({caso:session.pendingCase} as never,{directory:root,sessionId}));
      if(!evidence.ok)throw new Error(evidence.error);
      const built=parseResult(await toolMap.construir_payload.execute({caso:session.pendingCase,paquete:session.lastPackage,derivados:validation.derivados} as never,{directory:root,sessionId,confirmedBy:"analista en chat"}));
      if(!built.ok)throw new Error(built.error);
      const created=parseResult(await toolMap.crear.execute({caso:session.pendingCase,payload:(built.data as {payload:unknown}).payload,confirmado:true} as never,{directory:root,sessionId}));
      session.pendingConfirm=false;
      const reply=created.ok?`Orden creada correctamente. Resultado: ${JSON.stringify(created.data)}. Evidencia y trazabilidad guardadas en out/${session.pendingCase}/.`:`No se pudo crear la orden: ${created.error}`;
      session.messages.push({role:"assistant",content:reply});return res.json({sessionId,reply,toolCalls:session.toolCalls.slice(-10),needsConfirmation:false});
    }catch(e){return res.json({sessionId,reply:`No se pudo completar la creación: ${e instanceof Error?e.message:"error inesperado"}`,toolCalls:session.toolCalls.slice(-10),needsConfirmation:false});}
  }
  if(!process.env.OPENAI_API_KEY){
    const c=caseFromMessage(message);
    if(c){const raw=await toolMap.leer_paquete.execute({caso:c} as never,{directory:root,sessionId});const r=parseResult(raw);session.toolCalls.push({name:"oc_leer_paquete",arguments:{caso:c},result:r});if(r.ok){const p=(r.data as {solicitud:{solicitud_id:string}});return res.json({sessionId,reply:`El paquete ${c} se leyó correctamente (solicitud ${p.solicitud.solicitud_id}). Para continuar la validación conversacional configura OPENAI_API_KEY en .env. También puedes ejecutar npm run demo sin clave.`,toolCalls:session.toolCalls.slice(-10),needsConfirmation:false});}}
    return res.status(503).json({sessionId,reply:"El modo conversacional requiere OPENAI_API_KEY en el archivo .env. Las herramientas y la demo funcionan sin clave con npm run demo.",toolCalls:[],needsConfirmation:false});
  }
  try{
    const prompt=systemPrompt+"\n\nConocimiento del proceso:\n"+await readFile(path.join(root,"src/knowledge/ordenes-compra.md"),"utf8");
    const history:ChatMessage[]=[{role:"system",content:prompt},...session.messages.slice(-Number(process.env.MAX_SESSION_MESSAGES??60))];
    const llm=new OpenAiAdapter(process.env.OPENAI_API_KEY,process.env.OPENAI_MODEL??"gpt-4o-mini");
    let reply="", needsConfirmation=false;
    for(let i=0;i<Number(process.env.MAX_TOOL_ITERATIONS??25);i++){
      const response=await llm.enviar(history,definitions);
      if(!response.toolCalls.length){reply=response.content??"No pude generar una respuesta. Intenta de nuevo.";break;}
      history.push({role:"assistant",content:response.content??"",tool_calls:response.toolCalls.map(call=>({id:call.id,type:"function" as const,function:{name:call.name,arguments:call.arguments}}))});
      for(const call of response.toolCalls){
        const entry=toolMap[call.name.replace(/^oc_/,"")];
        if(!entry){history.push({role:"tool",tool_call_id:call.id,content:JSON.stringify({ok:false,error:"Herramienta desconocida"})});continue;}
        let args:unknown;
        try{args=JSON.parse(call.arguments);}catch{history.push({role:"tool",tool_call_id:call.id,content:JSON.stringify({ok:false,error:"Argumentos JSON inválidos"})});continue;}
        const checked=schemaFor(entry).safeParse(args);
        if(!checked.success){history.push({role:"tool",tool_call_id:call.id,content:JSON.stringify({ok:false,error:checked.error.message})});continue;}
        if(call.name==="oc_crear" && session.pendingConfirm){history.push({role:"tool",tool_call_id:call.id,content:JSON.stringify({ok:false,error:"Confirmación humana requerida en un mensaje posterior; no basta con un argumento del modelo"})});continue;}
        const result=parseResult(await entry.execute(args as never,{directory:root,sessionId}));
        session.toolCalls.push({name:call.name,arguments:args,result});await writeLog({sessionId,tool:call.name,arguments:args,result});
        if(call.name==="oc_leer_paquete"&&result.ok){session.pendingCase=(args as {caso:string}).caso;session.lastPackage=result.data;}
        if(call.name==="oc_validar"&&result.ok){
          session.lastValidation=result.data;
          const v=result.data as {apta:boolean;bloqueos:string[];confirmaciones:string[]};
          await writeFile(path.join(out,session.pendingCase??(args as {caso:string}).caso,"validacion.json"),JSON.stringify(result.data,null,2)).catch(()=>{});
          if(v.confirmaciones.length&&v.apta){session.pendingConfirm=true;needsConfirmation=true;}
        }
        if(call.name==="oc_construir_payload"&&result.ok)session.lastPayload=(result.data as {payload:unknown}).payload;
        history.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(result)});
      }
      if(needsConfirmation) {
        const v=session.lastValidation as {confirmaciones?:string[];bloqueos?:string[]}|null;
        const details=(v?.confirmaciones??[]).map((x,index)=>`${index+1}. ${x}`).join("\n");
        reply=`La solicitud ${session.pendingCase??"seleccionada"} pasó los controles obligatorios, pero tiene excepciones que requieren confirmación:\n${details}\n\n¿Confirmas que continúe con la creación? Responde “confirmo” para continuar. No se ha creado la OC.`;
        break;
      }
      if(i===Number(process.env.MAX_TOOL_ITERATIONS??25)-1)reply="Alcancé el límite de pasos para este turno. Revisa las herramientas ejecutadas y dime cómo deseas continuar.";
    }
    if(!reply)reply="No se obtuvo una respuesta final.";
    session.messages.push({role:"assistant",content:reply});
    await writeLog({sessionId,event:"assistant_reply",reply});
    res.json({sessionId,reply,toolCalls:session.toolCalls.slice(-10),needsConfirmation});
  }catch(e){const msg=e instanceof Error?e.message:"Error inesperado";res.json({sessionId,reply:`Ocurrió un error procesando el mensaje: ${msg}. La sesión sigue disponible; inténtalo de nuevo.`,toolCalls:session.toolCalls.slice(-10),needsConfirmation:false});}
});
const port=Number(process.env.PORT??3000);
app.listen(port,()=>console.log(`Agente SAP simulado disponible en http://localhost:${port}`));
