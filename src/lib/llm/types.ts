// ─── Tool types ───────────────────────────────────────────────────────────────

export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface AgentTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ─── Multimodal content blocks ────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Base64-encoded image data. */
  data: string;
}

export interface ImageUrlContent {
  type: "image_url";
  url: string;
}

export type ContentBlock = TextContent | ImageContent | ImageUrlContent;

// ─── Provider options ─────────────────────────────────────────────────────────

export interface CompleteOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

// ─── Stateful chat session ────────────────────────────────────────────────────

/**
 * Represents an ongoing multi-turn conversation.
 * The session internally maintains full message history
 * (including tool call / tool result turns) in a provider-specific format.
 * Create via `LLMProvider.createChatSession()`.
 */
export interface ChatSession {
  /**
   * Send a user message, execute any tool calls the model makes,
   * and return the final text reply.
   */
  send(userMessage: string, tools?: AgentTool[]): Promise<string>;
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface LLMProvider {
  /**
   * Single-turn text or multimodal completion.
   */
  complete(
    systemPrompt: string,
    userMessage: string | ContentBlock[],
    options?: CompleteOptions
  ): Promise<string>;

  /**
   * Forces a JSON-schema-conforming tool call and returns
   * the typed parsed input object — guaranteed structured output.
   */
  completeStructured<T>(
    systemPrompt: string,
    userMessage: string | ContentBlock[],
    toolName: string,
    toolDescription: string,
    inputSchema: ToolSchema,
    options?: CompleteOptions
  ): Promise<T>;

  /**
   * Autonomous multi-turn agent loop.
   * Runs tool calls until stop_reason is "end_turn" or maxIterations is reached.
   */
  runAgent(
    systemPrompt: string,
    userMessage: string,
    tools: AgentTool[],
    maxIterations?: number,
    options?: CompleteOptions
  ): Promise<void>;

  /**
   * Creates a stateful chat session suitable for HTTP-server-style
   * multi-turn conversations (one session per user/connection).
   */
  createChatSession(systemPrompt: string, maxTurnIterations?: number, options?: CompleteOptions): ChatSession;
}
