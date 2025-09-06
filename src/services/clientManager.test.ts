/**
 * Unit tests for the ClientManager class
 *
 * These tests validate the core functionality of the ClientManager in isolation,
 * including server connection management, tool aggregation, and error handling.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientManager } from "./clientManager.js";
import type { McpServerConfig } from "../types/index.js";

// Mock the MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js");
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Mock json-schema-to-zod
vi.mock("json-schema-to-zod", () => ({
  jsonSchemaToZod: vi.fn(schema => {
    // Return a string that when eval'd will produce a zod schema
    return "z.object({})";
  }),
}));

const MockedClient = Client as unknown as vi.MockedClass<typeof Client>;
const MockedTransport = StreamableHTTPClientTransport as unknown as vi.MockedClass<typeof StreamableHTTPClientTransport>;

describe("ClientManager", () => {
  let clientManager: ClientManager;
  let mockClient: {
    connect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    onerror: null | ((error: Error) => void);
  };
  let mockTransport: {
    close: ReturnType<typeof vi.fn>;
  };

  const mockServerConfig: McpServerConfig = {
    name: "test-server",
    url: "http://localhost:3000/mcp",
    description: "Test server",
    enabled: true,
  };

  const mockTools = [
    {
      name: "test-tool-1",
      description: "Test tool 1",
      inputSchema: {
        type: "object",
        properties: { param1: { type: "string" } },
      },
    },
    {
      name: "test-tool-2",
      description: "Test tool 2",
      inputSchema: {
        type: "object",
        properties: { param2: { type: "number" } },
      },
    },
  ];

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create mock client
    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: mockTools }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Mock result" }] }),
      onerror: null,
    };

    // Create mock transport
    mockTransport = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Mock constructors
    MockedClient.mockImplementation(() => mockClient);
    MockedTransport.mockImplementation(() => mockTransport);

    // Create client manager instance
    clientManager = new ClientManager(":");

    // Suppress console.error for cleaner test output
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("should create ClientManager with default separator", () => {
    const manager = new ClientManager();
    expect(manager).toBeDefined();
  });

  test("should create ClientManager with custom separator", () => {
    const manager = new ClientManager("|");
    expect(manager).toBeDefined();
  });

  test("should connect to a single server successfully", async () => {
    await clientManager.connectToServers([mockServerConfig]);

    expect(MockedClient).toHaveBeenCalledWith({
      name: "mcp-router-client",
      version: "1.0.0",
    });
    expect(mockClient.connect).toHaveBeenCalledWith(mockTransport);
    expect(mockClient.listTools).toHaveBeenCalled();
  });

  test("should skip disabled servers", async () => {
    const disabledConfig = { ...mockServerConfig, enabled: false };

    await clientManager.connectToServers([disabledConfig]);

    expect(MockedClient).not.toHaveBeenCalled();
    expect(mockClient.connect).not.toHaveBeenCalled();
  });

  test("should handle connection failures gracefully", async () => {
    mockClient.connect.mockRejectedValue(new Error("Connection failed"));

    await clientManager.connectToServers([mockServerConfig]);

    // Should not throw, but should track the error
    const statuses = clientManager.getServerStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].connected).toBe(false);
    expect(statuses[0].lastError).toBe("Connection failed");
  });

  test("should aggregate tools with server prefixes", async () => {
    await clientManager.connectToServers([mockServerConfig]);

    // Verify that listTools was called
    expect(mockClient.listTools).toHaveBeenCalled();

    const allTools = clientManager.getAllTools();
    expect(allTools).toHaveLength(2);

    expect(allTools[0].name).toBe("test-server:test-tool-1");
    expect(allTools[0].description).toContain("Test tool 1");

    expect(allTools[1].name).toBe("test-server:test-tool-2");
    expect(allTools[1].description).toContain("Test tool 2");
  });

  test("should use custom separator for tool names", async () => {
    const customManager = new ClientManager("|");
    await customManager.connectToServers([mockServerConfig]);

    const allTools = customManager.getAllTools();
    expect(allTools[0].name).toBe("test-server|test-tool-1");
  });

  test("should call tools on the correct server", async () => {
    await clientManager.connectToServers([mockServerConfig]);

    const result = await clientManager.callTool("test-server:test-tool-1", { param1: "value" });

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "test-tool-1",
      arguments: { param1: "value" },
    });
    expect(result).toEqual({ content: [{ type: "text", text: "Mock result" }] });
  });

  test("should throw error for unknown tool", async () => {
    await clientManager.connectToServers([mockServerConfig]);

    await expect(clientManager.callTool("unknown:tool", {}))
      .rejects.toThrow("Tool not found: unknown:tool");
  });

  test("should throw error when calling tool on disconnected server", async () => {
    // Connect first
    await clientManager.connectToServers([mockServerConfig]);

    // Simulate disconnection
    const statuses = clientManager.getServerStatuses();
    // Access private property for testing
    const connection = (clientManager as unknown as { connections: Map<string, { status: { connected: boolean } }> }).connections.get("test-server");
    connection.status.connected = false;

    await expect(clientManager.callTool("test-server:test-tool-1", {}))
      .rejects.toThrow("Server test-server is not connected");
  });

  test("should get server statuses", async () => {
    await clientManager.connectToServers([mockServerConfig]);

    const statuses = clientManager.getServerStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].name).toBe("test-server");
    expect(statuses[0].url).toBe("http://localhost:3000/mcp");
    expect(statuses[0].connected).toBe(true);
    expect(statuses[0].toolsCount).toBe(2);
  });

  test("should get router stats", async () => {
    await clientManager.connectToServers([mockServerConfig]);

    const stats = clientManager.getStats();
    expect(stats.totalServers).toBe(1);
    expect(stats.connectedServers).toBe(1);
    expect(stats.totalTools).toBe(2);
    expect(stats.toolRoutes).toBe(2);
  });

  test("should handle multiple servers", async () => {
    const server2Config: McpServerConfig = {
      name: "test-server-2",
      url: "http://localhost:3001/mcp",
      description: "Test server 2",
      enabled: true,
    };

    const mockTools2 = [
      {
        name: "tool-a",
        description: "Tool A",
        inputSchema: { type: "object" },
      },
    ];

    // Mock second client
    const mockClient2 = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: mockTools2 }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Result from server 2" }] }),
      onerror: null,
    };

    MockedClient.mockImplementationOnce(() => mockClient)
      .mockImplementationOnce(() => mockClient2);

    await clientManager.connectToServers([mockServerConfig, server2Config]);

    const allTools = clientManager.getAllTools();
    expect(allTools).toHaveLength(3); // 2 from server1 + 1 from server2

    const stats = clientManager.getStats();
    expect(stats.totalServers).toBe(2);
    expect(stats.connectedServers).toBe(2);
    expect(stats.totalTools).toBe(3);

    // Test calling tools from different servers
    const result1 = await clientManager.callTool("test-server:test-tool-1", {});
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "test-tool-1",
      arguments: {},
    });

    const result2 = await clientManager.callTool("test-server-2:tool-a", {});
    expect(mockClient2.callTool).toHaveBeenCalledWith({
      name: "tool-a",
      arguments: {},
    });
  });

  test("should handle reconnect to server", async () => {
    await clientManager.connectToServers([mockServerConfig]);

    // Mock new client for reconnection
    const newMockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: mockTools }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Reconnected result" }] }),
      onerror: null,
    };

    MockedClient.mockImplementationOnce(() => newMockClient);

    await clientManager.reconnectToServer("test-server");

    expect(mockTransport.close).toHaveBeenCalled();
    expect(newMockClient.connect).toHaveBeenCalled();

    // Old routes should be cleared and new ones created
    const result = await clientManager.callTool("test-server:test-tool-1", {});
    expect(newMockClient.callTool).toHaveBeenCalled();
  });

  test("should throw error when reconnecting to unknown server", async () => {
    await expect(clientManager.reconnectToServer("unknown-server"))
      .rejects.toThrow("Server unknown-server not found");
  });

  test("should handle tool loading failures gracefully", async () => {
    mockClient.listTools.mockRejectedValue(new Error("Failed to list tools"));

    await clientManager.connectToServers([mockServerConfig]);

    const allTools = clientManager.getAllTools();
    expect(allTools).toHaveLength(0);

    const statuses = clientManager.getServerStatuses();
    expect(statuses[0].connected).toBe(true); // Still connected
    expect(statuses[0].lastError).toBe("Failed to list tools");
    expect(statuses[0].toolsCount).toBe(0);
  });

  test("should disconnect all servers", async () => {
    const server2Config: McpServerConfig = {
      name: "test-server-2",
      url: "http://localhost:3001/mcp",
      enabled: true,
    };

    const mockTransport2 = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    MockedTransport.mockImplementationOnce(() => mockTransport)
      .mockImplementationOnce(() => mockTransport2);

    await clientManager.connectToServers([mockServerConfig, server2Config]);

    await clientManager.disconnectAll();

    expect(mockTransport.close).toHaveBeenCalled();
    expect(mockTransport2.close).toHaveBeenCalled();

    const stats = clientManager.getStats();
    expect(stats.totalServers).toBe(0);
    expect(stats.connectedServers).toBe(0);
    expect(stats.totalTools).toBe(0);
  });

  test("should handle disconnection errors gracefully", async () => {
    mockTransport.close.mockRejectedValue(new Error("Disconnection failed"));

    await clientManager.connectToServers([mockServerConfig]);

    // Should not throw
    await expect(clientManager.disconnectAll()).resolves.toBeUndefined();
  });

  test("should only return tools from connected servers", async () => {
    const server2Config: McpServerConfig = {
      name: "disconnected-server",
      url: "http://localhost:3001/mcp",
      enabled: true,
    };

    // Mock first server connects, second fails
    const failingClient = {
      connect: vi.fn().mockRejectedValue(new Error("Connection failed")),
    };

    MockedClient.mockImplementationOnce(() => mockClient)
      .mockImplementationOnce(() => failingClient);

    await clientManager.connectToServers([mockServerConfig, server2Config]);

    const allTools = clientManager.getAllTools();
    expect(allTools).toHaveLength(2); // Only tools from connected server

    const stats = clientManager.getStats();
    expect(stats.totalServers).toBe(2);
    expect(stats.connectedServers).toBe(1);
    expect(stats.totalTools).toBe(2);
  });
});
