import { ZodRawShape } from "zod";

export interface Tool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  description?: string;
  enabled?: boolean;
  timeout?: number;
  retryAttempts?: number;
  autoReconnect?: boolean; // Whether to automatically reconnect on ping failures
}

export type McpServerConfigInput = Omit<McpServerConfig, "id"> & { id?: string; };

export interface RouterConfig {
  servers: McpServerConfig[];
  port?: number;
  routerName?: string;
  routerVersion?: string;
  toolNameSeparator?: string; // Used to separate server name from tool name (e.g., "server:tool")
}

export type ToolHandlerResult = {
  content: Array<{
    type: string;
    text?: string;
    data?: unknown;
    [key: string]: unknown;
  }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ToolHandlerArgs = Record<string, unknown>;

export interface AggregatedTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  inputSchema: unknown; // Original JSON Schema for MCP registration
  handler: (args: ToolHandlerArgs, extra?: unknown) => Promise<ToolHandlerResult>;
}

export interface ServerStatus {
  name: string;
  url: string;
  connected: boolean;
  lastConnected?: Date;
  lastError?: string;
  toolsCount: number;
}

export interface RouterStats {
  totalServers: number;
  connectedServers: number;
  totalTools: number;
  uptime: number;
  requestCount: number;
  errorCount: number;
}
