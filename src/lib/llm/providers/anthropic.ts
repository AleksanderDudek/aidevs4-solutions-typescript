import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentTool,
  ChatSession,
  CompleteOptions,
  ContentBlock,
  LLMProvider,
  ToolSchema,
} from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toAnthropicTool(tool: AgentTool): Anthropic.Tool {
  return {
    name: tool.definition.name,
    description: tool.definition.description,
    input_schema: tool.definition.inputSchema as Anthropic.Tool["input_schema"],
  };
}

function toAnthropicContent(
  content: string | ContentBlock[]
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((block): Anthropic.ContentBlockParam => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType,
          data: block.data,
        },
      };
    }
    if (block.type === "image_url") {
      return {
        type: "image",
        source: { type: "url", url: block.url },
      };
    }
    throw new Error(`Unsupported content block type: ${(block as ContentBlock).type}`);
  });
}

// ─── Chat session ─────────────────────────────────────────────────────────────

class AnthropicChatSession implements ChatSession {
  private readonly history: Anthropic.MessageParam[] = [];

  constructor(
    private readonly client: Anthropic,
    private readonly systemPrompt: string,
    private readonly model: string,
    private readonly maxTokens: number,
    private readonly maxTurnIterations: number
  ) {}

  async send(userMessage: string, tools: AgentTool[] = []): Promise<string> {
    this.history.push({ role: "user", content: userMessage });
    const anthropicTools = tools.map(toAnthropicTool);
    let lastText = "";

    for (let i = 0; i < this.maxTurnIterations; i++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: this.systemPrompt,
        tools: anthropicTools,
        messages: this.history,
      });

      this.history.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text") lastText = block.text;
      }

      if (response.stop_reason === "end_turn" || response.stop_reason !== "tool_use") break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const tool = tools.find((t) => t.definition.name === block.name);

        let result: unknown;
        if (!tool) {
          result = { error: `Unknown tool: "${block.name}"` };
        } else {
          console.log(`  🔧 ${block.name}(${JSON.stringify(block.input)})`);
          try {
            result = await tool.handler(block.input as Record<string, unknown>);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
          console.log(`     ↩ ${JSON.stringify(result).slice(0, 300)}`);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      this.history.push({ role: "user", content: toolResults });
    }

    return lastText;
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Missing ANTHROPIC_API_KEY in .env");
    this.client = new Anthropic({ apiKey: key });
  }

  async complete(
    systemPrompt: string,
    userMessage: string | ContentBlock[],
    options: CompleteOptions = {}
  ): Promise<string> {
    const { model = "claude-sonnet-4-20250514", maxTokens = 4096, temperature } = options;

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      messages: [{ role: "user", content: toAnthropicContent(userMessage) }],
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text block in response");
    return block.text;
  }

  async completeStructured<T>(
    systemPrompt: string,
    userMessage: string | ContentBlock[],
    toolName: string,
    toolDescription: string,
    inputSchema: ToolSchema,
    options: CompleteOptions = {}
  ): Promise<T> {
    const { model = "claude-sonnet-4-20250514", maxTokens = 4096 } = options;

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      tools: [
        {
          name: toolName,
          description: toolDescription,
          input_schema: inputSchema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: toolName },
      messages: [{ role: "user", content: toAnthropicContent(userMessage) }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Model did not return a tool_use block");
    }
    return toolUse.input as T;
  }

  async runAgent(
    systemPrompt: string,
    userMessage: string,
    tools: AgentTool[],
    maxIterations = 20,
    options: CompleteOptions = {}
  ): Promise<void> {
    const { model = "claude-sonnet-4-20250514", maxTokens = 4096 } = options;
    const anthropicTools = tools.map(toAnthropicTool);
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userMessage },
    ];

    for (let i = 0; i < maxIterations; i++) {
      console.log(`\n🔄 Agent iteration ${i + 1}/${maxIterations}`);

      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(`💬 ${block.text.trim()}`);
        }
      }

      if (response.stop_reason === "end_turn") {
        console.log("✅ Agent completed (end_turn)");
        break;
      }

      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) {
        console.log("✅ Agent completed (no tool calls)");
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        if (block.type !== "tool_use") continue;
        const tool = tools.find((t) => t.definition.name === block.name);

        if (!tool) {
          console.warn(`⚠️  Unknown tool: ${block.name}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: unknown tool "${block.name}"`,
            is_error: true,
          });
          continue;
        }

        console.log(`🔧 ${block.name}(${JSON.stringify(block.input)})`);
        try {
          const result = await tool.handler(block.input as Record<string, unknown>);
          console.log(`   ↩`, result);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`   ❌ Tool error: ${msg}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${msg}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  createChatSession(
    systemPrompt: string,
    maxTurnIterations = 6,
    options: CompleteOptions = {}
  ): ChatSession {
    const model = options.model ?? "claude-haiku-4-5";
    const maxTokens = options.maxTokens ?? 1024;
    return new AnthropicChatSession(
      this.client,
      systemPrompt,
      model,
      maxTokens,
      maxTurnIterations
    );
  }
}
