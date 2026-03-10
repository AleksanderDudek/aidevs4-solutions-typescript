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
