export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; name?: string; tool_call_id?: string; tool_calls?: Array<{id:string;type:"function";function:{name:string;arguments:string}}> };
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: string };
export type LlmResponse = { content: string | null; toolCalls: ToolCall[] };
export interface LlmAdapter { enviar(mensajes: ChatMessage[], herramientas: ToolDefinition[]): Promise<LlmResponse>; }
