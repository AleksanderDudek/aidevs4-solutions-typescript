import OpenAI from "openai";
import type {
  AgentTool,
  ChatSession,
  CompleteOptions,
  ContentBlock,
  LLMProvider,
  ToolSchema,
} from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toOpenAITool(tool: AgentTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.definition.name,
      description: tool.definition.description,
      parameters: tool.definition.inputSchema as unknown as Record<string, unknown>,
    },
  };
}

function toOpenAIContent(
  content: string | ContentBlock[]
): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  if (typeof content === "string") return content;
  return content.map((block): OpenAI.Chat.Completions.ChatCompletionContentPart => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
      };
    }
    if (block.type === "image_url") {
      return { type: "image_url", image_url: { url: block.url } };
    }
    throw new Error(`Unsupported content block type: ${(block as ContentBlock).type}`);
  });
}

// ─── Chat session ─────────────────────────────────────────────────────────────

class OpenAIChatSession implements ChatSession {
  private readonly history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  constructor(
    private readonly client: OpenAI,
    private readonly systemPrompt: string,
    private readonly model: string,
    private readonly maxTokens: number,
    private readonly maxTurnIterations: number
  ) {}

  async send(userMessage: string, tools: AgentTool[] = []): Promise<string> {
    this.history.push({ role: "user", content: userMessage });
    const openaiTools = tools.map(toOpenAITool);
    let lastText = "";

    for (let i = 0; i < this.maxTurnIterations; i++) {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        ...(this.systemPrompt ? [{ role: "system" as const, content: this.systemPrompt }] : []),
        ...this.history,
      ];

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        messages,
      });

      const choice = response.choices[0];
      if (!choice?.message) break;

      this.history.push(choice.message);

      if (choice.message.content) lastText = choice.message.content;

      const toolCalls = choice.message.tool_calls ?? [];
      if (toolCalls.length === 0 || choice.finish_reason === "stop") break;

      const toolResults: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;
        const tool = tools.find((t) => t.definition.name === tc.function.name);
        let result: unknown;
        if (!tool) {
          result = { error: `Unknown tool: "${tc.function.name}"` };
        } else {
          console.log(`  🔧 ${tc.function.name}(${tc.function.arguments})`);
          try {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            result = await tool.handler(args);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
          console.log(`     ↩ ${JSON.stringify(result).slice(0, 300)}`);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }

      this.history.push(...toolResults);
    }

    return lastText;
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("Missing OPENAI_API_KEY in .env");
    this.client = new OpenAI({ apiKey: key });
  }

  async complete(
    systemPrompt: string,
    userMessage: string | ContentBlock[],
    options: CompleteOptions = {}
  ): Promise<string> {
    const { model = "gpt-4o", maxTokens = 4096, temperature } = options;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      { role: "user", content: toOpenAIContent(userMessage) },
    ];

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      messages,
    });

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error("OpenAI returned no text in response");
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
    const { model = "gpt-4o", maxTokens = 4096 } = options;

    const tool: OpenAI.Chat.Completions.ChatCompletionTool = {
      type: "function",
      function: {
        name: toolName,
        description: toolDescription,
        parameters: inputSchema as unknown as Record<string, unknown>,
      },
    };

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      { role: "user", content: toOpenAIContent(userMessage) },
    ];

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: "function", function: { name: toolName } },
      messages,
    });

    const tc = response.choices[0]?.message?.tool_calls?.find((c) => c.type === "function");
    if (!tc || tc.type !== "function") throw new Error("OpenAI did not return a tool call for structured output");
    return JSON.parse(tc.function.arguments) as T;
  }

  async runAgent(
    systemPrompt: string,
    userMessage: string,
    tools: AgentTool[],
    maxIterations = 20,
    options: CompleteOptions = {}
  ): Promise<void> {
    const { model = "gpt-4o", maxTokens = 4096 } = options;
    const openaiTools = tools.map(toOpenAITool);

    const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "user", content: userMessage },
    ];

    for (let i = 0; i < maxIterations; i++) {
      console.log(`\n🔄 Agent iteration ${i + 1}/${maxIterations}`);

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...history,
      ];

      const response = await this.client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        tools: openaiTools,
        messages,
      });

      const choice = response.choices[0];
      if (!choice?.message) break;

      history.push(choice.message);

      if (choice.message.content?.trim()) console.log(`💬 ${choice.message.content.trim()}`);

      const toolCalls = choice.message.tool_calls ?? [];
      if (toolCalls.length === 0 || choice.finish_reason === "stop") {
        console.log("✅ Agent completed");
        break;
      }

      const toolResults: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;
        const tool = tools.find((t) => t.definition.name === tc.function.name);
        let result: unknown;
        if (!tool) {
          console.warn(`⚠️ Unknown tool: ${tc.function.name}`);
          result = { error: `Unknown tool: "${tc.function.name}"` };
        } else {
          console.log(`🔧 ${tc.function.name}(${tc.function.arguments})`);
          try {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            result = await tool.handler(args);
            console.log(`   ↩`, result);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`   ❌ Tool error: ${msg}`);
            result = { error: msg };
          }
        }
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }

      history.push(...toolResults);
    }
  }

  createChatSession(
    systemPrompt: string,
    maxTurnIterations = 6,
    options: CompleteOptions = {}
  ): ChatSession {
    const model = options.model ?? "gpt-4o";
    const maxTokens = options.maxTokens ?? 1024;
    return new OpenAIChatSession(this.client, systemPrompt, model, maxTokens, maxTurnIterations);
  }
}
