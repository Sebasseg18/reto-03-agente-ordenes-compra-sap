import OpenAI from "openai";
import type { ChatMessage, LlmAdapter, LlmResponse, ToolDefinition } from "./adapter.js";

export class OpenAiAdapter implements LlmAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey, timeout: Number(process.env.LLM_TIMEOUT_MS ?? 30000), maxRetries: 1 });
    this.model = model;
  }
  async enviar(mensajes: ChatMessage[], herramientas: ToolDefinition[]): Promise<LlmResponse> {
    const messages = mensajes.map(m => {
      if(m.role === "tool") return { role:"tool" as const, content:m.content, tool_call_id:m.tool_call_id ?? "" };
      if(m.role === "assistant") return { role:"assistant" as const, content:m.content, ...(m.name?{name:m.name}:{}), ...(m.tool_calls?{tool_calls:m.tool_calls}:{}) };
      return { role:m.role as "system"|"user", content:m.content };
    });
    const response = await this.client.chat.completions.create({
      model:this.model, messages,
      tools:herramientas.map(t=>({type:"function" as const,function:{name:t.name,description:t.description,parameters:t.parameters}})),
      tool_choice:"auto"
    });
    const choice=response.choices[0];
    return {content:choice?.message.content??null,toolCalls:(choice?.message.tool_calls??[]).flatMap(t=>t.type==="function"?[{id:t.id,name:t.function.name,arguments:t.function.arguments}]:[])};
  }
}
