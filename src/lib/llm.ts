import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in .env");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ─── Agent / Function Calling ────────────────────────────────────────────────

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface AgentTool {
  definition: Anthropic.Tool;
  handler: ToolHandler;
}

/**
 * Runs an agent loop with Function Calling (tool_use).
 * Continues until the model returns stop_reason="end_turn"
 * or the maxIterations limit is reached.
 */
export async function runAgent(
  systemPrompt: string,
  userMessage: string,
  tools: AgentTool[],
  maxIterations = 20,
  model = "claude-sonnet-4-20250514"
): Promise<void> {
  const client = getClient();
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i < maxIterations; i++) {
    console.log(`\n🔄 Agent iteration ${i + 1}/${maxIterations}`);

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: tools.map((t) => t.definition),
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
        console.warn(`⚠️ Unknown tool: ${block.name}`);
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


/**
 * Simple text completion.
 */
export async function complete(
  systemPrompt: string,
  userMessage: string,
  model = "claude-sonnet-4-20250514"
): Promise<string> {
  const client = getClient();

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const block = msg.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

/**
 * Structured output - returns parsed JSON matching the provided schema.
 * Uses tool_use to guarantee schema compliance.
 */
export async function completeStructured<T>(
  systemPrompt: string,
  userMessage: string,
  toolName: string,
  toolDescription: string,
  inputSchema: Anthropic.Tool["input_schema"],
  model = "claude-sonnet-4-20250514"
): Promise<T> {
  const client = getClient();

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    tools: [
      {
        name: toolName,
        description: toolDescription,
        input_schema: inputSchema,
      },
    ],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return a tool_use block");
  }

  return toolUse.input as T;
}
