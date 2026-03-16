import { GoogleGenAI, FunctionCallingConfigMode, type Content, type Tool as GeminiTool } from "@google/genai";
import type {
  AgentTool,
  ChatSession,
  CompleteOptions,
  ContentBlock,
  LLMProvider,
  ToolSchema,
} from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toGeminiTool(tool: AgentTool): GeminiTool {
  return {
    functionDeclarations: [
      {
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: tool.definition.inputSchema as unknown as Record<string, unknown>,
      },
    ],
  };
}

function toGeminiParts(content: string | ContentBlock[]): Content["parts"] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "image") {
      return {
        inlineData: { mimeType: block.mediaType, data: block.data },
      };
    }
    if (block.type === "image_url") {
      // Gemini supports file URIs and GCS URLs via fileData; plain https URLs
      // are not directly supported — fall back to a text description.
      return { text: `[image: ${block.url}]` };
    }
    throw new Error(`Unsupported content block type: ${(block as ContentBlock).type}`);
  });
}

// ─── Chat session ─────────────────────────────────────────────────────────────

class GeminiChatSession implements ChatSession {
  private readonly history: Content[] = [];

  constructor(
    private readonly client: GoogleGenAI,
    private readonly systemPrompt: string,
    private readonly model: string,
    private readonly maxTokens: number,
    private readonly maxTurnIterations: number
  ) {}

  async send(userMessage: string, tools: AgentTool[] = []): Promise<string> {
    const geminiTools = tools.map(toGeminiTool);

    this.history.push({ role: "user", parts: [{ text: userMessage }] });

    let lastText = "";

    for (let i = 0; i < this.maxTurnIterations; i++) {
      const response = await this.client.models.generateContent({
        model: this.model,
        config: {
          systemInstruction: this.systemPrompt || undefined,
          maxOutputTokens: this.maxTokens,
          tools: geminiTools.length > 0 ? geminiTools : undefined,
        },
        contents: this.history,
      });

      const candidate = response.candidates?.[0];
      if (!candidate?.content) break;

      this.history.push(candidate.content);

      // Collect text parts
      for (const part of candidate.content.parts ?? []) {
        if (part.text) lastText = part.text;
      }

      // Check for function calls
      const fnCalls = (candidate.content.parts ?? []).filter((p) => p.functionCall);
      if (fnCalls.length === 0) break;

      // Execute function calls and collect results
      const resultParts: Content["parts"] = [];
      for (const part of fnCalls) {
        const fc = part.functionCall!;
        const tool = tools.find((t) => t.definition.name === fc.name);
        let result: unknown;
        if (!tool) {
          result = { error: `Unknown tool: "${fc.name}"` };
        } else {
          console.log(`  🔧 ${fc.name}(${JSON.stringify(fc.args)})`);
          try {
            result = await tool.handler(fc.args as Record<string, unknown>);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
          console.log(`     ↩ ${JSON.stringify(result).slice(0, 300)}`);
        }
        resultParts.push({
          functionResponse: { name: fc.name!, response: result as Record<string, unknown> },
        });
      }

      this.history.push({ role: "user", parts: resultParts });
    }

    return lastText;
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
  private readonly client: GoogleGenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY in .env");
    this.client = new GoogleGenAI({ apiKey: key });
  }

  async complete(
    systemPrompt: string,
    userMessage: string | ContentBlock[],
    options: CompleteOptions = {}
  ): Promise<string> {
    const { model = "gemini-2.0-flash", maxTokens = 4096 } = options;

    const response = await this.client.models.generateContent({
      model,
      config: {
        systemInstruction: systemPrompt || undefined,
        maxOutputTokens: maxTokens,
      },
      contents: [{ role: "user", parts: toGeminiParts(userMessage) }],
    });

    const text = response.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("") ?? "";

    if (!text) throw new Error("Gemini returned no text in response");
    return text;
  }

  async completeStructured<T>(
    systemPrompt: string,
    userMessage: string | ContentBlock[],
    toolName: string,
    toolDescription: string,
    inputSchema: ToolSchema,
    options: CompleteOptions = {}
  ): Promise<T> {
    const { model = "gemini-2.0-flash", maxTokens = 4096 } = options;

    const tool: GeminiTool = {
      functionDeclarations: [
        {
          name: toolName,
          description: toolDescription,
          parameters: inputSchema as unknown as Record<string, unknown>,
        },
      ],
    };

    const response = await this.client.models.generateContent({
      model,
      config: {
        systemInstruction: systemPrompt || undefined,
        maxOutputTokens: maxTokens,
        tools: [tool],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
      },
      contents: [{ role: "user", parts: toGeminiParts(userMessage) }],
    });

    const fnCall = response.candidates?.[0]?.content?.parts
      ?.find((p) => p.functionCall);
    if (!fnCall?.functionCall) {
      throw new Error("Gemini did not return a function call for structured output");
    }
    return fnCall.functionCall.args as T;
  }

  async runAgent(
    systemPrompt: string,
    userMessage: string,
    tools: AgentTool[],
    maxIterations = 20,
    options: CompleteOptions = {}
  ): Promise<void> {
    const { model = "gemini-2.0-flash", maxTokens = 4096 } = options;
    const geminiTools = tools.map(toGeminiTool);

    const history: Content[] = [{ role: "user", parts: [{ text: userMessage }] }];

    for (let i = 0; i < maxIterations; i++) {
      console.log(`\n🔄 Agent iteration ${i + 1}/${maxIterations}`);

      const response = await this.client.models.generateContent({
        model,
        config: {
          systemInstruction: systemPrompt || undefined,
          maxOutputTokens: maxTokens,
          tools: geminiTools,
        },
        contents: history,
      });

      const candidate = response.candidates?.[0];
      if (!candidate?.content) break;

      history.push(candidate.content);

      for (const part of candidate.content.parts ?? []) {
        if (part.text?.trim()) console.log(`💬 ${part.text.trim()}`);
      }

      const fnCalls = (candidate.content.parts ?? []).filter((p) => p.functionCall);
      if (fnCalls.length === 0) {
        console.log("✅ Agent completed (no function calls)");
        break;
      }

      const resultParts: Content["parts"] = [];
      for (const part of fnCalls) {
        const fc = part.functionCall!;
        const tool = tools.find((t) => t.definition.name === fc.name);

        let result: unknown;
        if (!tool) {
          console.warn(`⚠️ Unknown tool: ${fc.name}`);
          result = { error: `Unknown tool: "${fc.name}"` };
        } else {
          console.log(`🔧 ${fc.name}(${JSON.stringify(fc.args)})`);
          try {
            result = await tool.handler(fc.args as Record<string, unknown>);
            console.log(`   ↩`, result);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`   ❌ Tool error: ${msg}`);
            result = { error: msg };
          }
        }

        resultParts.push({
          functionResponse: { name: fc.name!, response: result as Record<string, unknown> },
        });
      }

      history.push({ role: "user", parts: resultParts });
    }
  }

  createChatSession(
    systemPrompt: string,
    maxTurnIterations = 6,
    options: CompleteOptions = {}
  ): ChatSession {
    const model = options.model ?? "gemini-2.0-flash";
    const maxTokens = options.maxTokens ?? 1024;
    return new GeminiChatSession(this.client, systemPrompt, model, maxTokens, maxTurnIterations);
  }
}
