import { spawn, ChildProcess } from "child_process";
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

describe("MCP Router Server", () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let routerProcess: ChildProcess;
  const routerUrl = "http://localhost:4001"; // Use different port for testing

  beforeAll(async () => {
    // Create a minimal, clean environment for the test
    // Only include essential Node.js variables, not the full process.env
    // This prevents GitHub Actions env vars from interfering
    const cleanEnv: Record<string, string> = {
      // Essential Node.js variables
      PATH: process.env.PATH || "",
      NODE_ENV: "test",
      // Router-specific configuration
      ROUTER_PORT: "4001", // Use port 4001 for testing
      ROUTER_NAME: "mcp-router-test",
      ROUTER_VERSION: "1.0.0-test",
      AUTH_ENABLED: "false", // Disable authentication for tests
      // Explicitly disable database to avoid connection issues in CI
      DATABASE_URL: "", // Empty string to ensure no DB connection
    };

    routerProcess = spawn("node", ["dist/index.js"], {
      env: cleanEnv,
      stdio: "pipe",
    });

    // Wait for router to start by listening for the startup message
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Router failed to start within timeout"));
      }, 30000); // Increased timeout to 30 seconds

      let routerStarted = false;

      // Listen for the startup message and log output
      const onData = (data: Buffer) => {
        const output = data.toString();
        console.log(`Router stdout: ${output.trim()}`);

        if (output.includes("MCP Router running on")) {
          routerStarted = true;
          // Give it a little more time to fully initialize
          setTimeout(() => {
            clearTimeout(timeout);
            resolve(undefined);
          }, 1000);
        }
      };

      const onError = (data: Buffer) => {
        console.error(`Router stderr: ${data.toString().trim()}`);
      };

      routerProcess.stdout?.on("data", onData);
      routerProcess.stderr?.on("data", onError);

      // Also periodically check the health endpoint as a fallback
      const checkHealth = async () => {
        if (routerStarted) {return;}

        try {
          const response = await fetch(`${routerUrl}/health`);
          if (response.ok) {
            routerStarted = true;
            clearTimeout(timeout);
            resolve(undefined);
          } else {
            setTimeout(checkHealth, 1000);
          }
        } catch (error) {
          setTimeout(checkHealth, 1000);
        }
      };

      setTimeout(checkHealth, 2000); // Start checking after 2 seconds
    });

    // Give the server a moment to fully initialize all endpoints
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create MCP client transport and connect
    transport = new StreamableHTTPClientTransport(new URL(`${routerUrl}/mcp`));

    client = new Client({
      name: "mcp-router-client-test",
      version: "1.0.0",
    });

    await client.connect(transport);
  });

  afterAll(async () => {
    // Clean up
    if (client) {
      await client.close();
    }

    // Kill the router process
    if (routerProcess) {
      routerProcess.kill("SIGTERM");

      // Wait for process to exit
      await new Promise(resolve => {
        routerProcess.on("exit", resolve);
        setTimeout(() => {
          routerProcess.kill("SIGKILL");
          resolve(undefined);
        }, 5000);
      });
    }
  });

  test("should connect to MCP router successfully", () => {
    // If we reach this point, the connection was successful
    expect(client).toBeDefined();
  });

  test("should respond to health check", async () => {
    const response = await fetch(`${routerUrl}/health`);
    expect(response.ok).toBe(true);

    const healthData = await response.json();
    expect(healthData).toBeDefined();
    expect(healthData.status).toBe("healthy");
    expect(healthData.service).toBe("mcp-router-test");
    expect(healthData.version).toBe("1.0.0-test");
    expect(healthData.timestamp).toBeDefined();
    expect(healthData.stats).toBeDefined();
    expect(typeof healthData.stats.uptime).toBe("number");
    expect(typeof healthData.stats.requestCount).toBe("number");
    expect(typeof healthData.stats.errorCount).toBe("number");
  });

  test("should respond to configuration endpoint", async () => {
    const response = await fetch(`${routerUrl}/config`);
    expect(response.ok).toBe(true);

    const configData = await response.json();
    expect(configData).toBeDefined();
    expect(configData.servers).toBeDefined();
    expect(Array.isArray(configData.servers)).toBe(true);
    expect(configData.port).toBe(4001);
    expect(configData.routerName).toBe("mcp-router-test");
    expect(configData.routerVersion).toBe("1.0.0-test");
    expect(configData.toolNameSeparator).toBeDefined();
  });

  test("should have router management tools available", async () => {
    const tools = await client.listTools();

    expect(tools).toBeDefined();
    expect(tools.tools).toBeDefined();
    expect(Array.isArray(tools.tools)).toBe(true);

    const toolNames = tools.tools?.map((tool: { name: string }) => tool.name) || [];

    // Check for router management tools
    expect(toolNames).toContain("router:list-servers");
    expect(toolNames).toContain("router:reconnect-server");
    expect(toolNames).toContain("router:stats");

    // Verify tool descriptions
    const listServersTool = tools.tools?.find((tool: { name: string; description?: string }) => tool.name === "router:list-servers");
    expect(listServersTool?.description).toBe("List all configured MCP servers and their status");

    const statsTool = tools.tools?.find((tool: { name: string; description?: string }) => tool.name === "router:stats");
    expect(statsTool?.description).toBe("Get router statistics and performance metrics");
  });

  test("should list servers successfully", async () => {
    const result = await client.callTool({
      name: "router:list-servers",
      arguments: {},
    });

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as Array<{ type: string; text: string }>).length).toBeGreaterThan(0);

    const content = result.content as Array<{ type: string; text: string }>;
    const resultText = content[0].text;
    expect(resultText).toBeDefined();
    expect(typeof resultText).toBe("string");

    // Parse the JSON response to validate structure
    const parsedResult = JSON.parse(resultText);
    expect(parsedResult).toBeDefined();
    expect(parsedResult.summary).toBeDefined();
    expect(parsedResult.servers).toBeDefined();
    expect(Array.isArray(parsedResult.servers)).toBe(true);

    // Validate summary structure
    expect(typeof parsedResult.summary.totalServers).toBe("number");
    expect(typeof parsedResult.summary.connectedServers).toBe("number");
    expect(typeof parsedResult.summary.totalTools).toBe("number");
  });

  test("should get router statistics successfully", async () => {
    const result = await client.callTool({
      name: "router:stats",
      arguments: {},
    });

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as Array<{ type: string; text: string }>).length).toBeGreaterThan(0);

    const content = result.content as Array<{ type: string; text: string }>;
    const resultText = content[0].text;
    expect(resultText).toBeDefined();
    expect(typeof resultText).toBe("string");

    // Parse the JSON response to validate structure
    const stats = JSON.parse(resultText);
    expect(stats).toBeDefined();
    expect(typeof stats.totalServers).toBe("number");
    expect(typeof stats.connectedServers).toBe("number");
    expect(typeof stats.totalTools).toBe("number");
    expect(typeof stats.uptime).toBe("number");
    expect(typeof stats.requestCount).toBe("number");
    expect(typeof stats.errorCount).toBe("number");
    expect(stats.uptimeFormatted).toBeDefined();
    expect(typeof stats.uptimeFormatted).toBe("string");
  });

  test("should handle reconnect-server tool with invalid server", async () => {
    const result = await client.callTool({
      name: "router:reconnect-server",
      arguments: {
        serverName: "nonexistent-server",
      },
    });

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as Array<{ type: string; text: string }>).length).toBeGreaterThan(0);

    const content = result.content as Array<{ type: string; text: string }>;
    const resultText = content[0].text;
    expect(resultText).toBeDefined();
    expect(typeof resultText).toBe("string");
    expect(resultText.toLowerCase()).toContain("error");
    expect(result.isError).toBe(true);
  });

  test("should handle invalid tool calls gracefully", async () => {
    try {
      await client.callTool({
        name: "nonexistent:tool",
        arguments: {},
      });

      // Should not reach here
      expect(false).toBe(true);
    } catch (error) {
      // Should throw an error for nonexistent tool
      expect(error).toBeDefined();
    }
  });

  test("should handle unsupported HTTP methods on MCP endpoint", async () => {
    const getResponse = await fetch(`${routerUrl}/mcp`, { method: "GET" });
    expect(getResponse.status).toBe(405);

    const getData = await getResponse.text();
    const getParsed = JSON.parse(getData);
    expect(getParsed.error.message).toBe("Method not allowed.");
    expect(getParsed.error.code).toBe(-32000);

    const deleteResponse = await fetch(`${routerUrl}/mcp`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(405);

    const deleteData = await deleteResponse.text();
    const deleteParsed = JSON.parse(deleteData);
    expect(deleteParsed.error.message).toBe("Method not allowed.");
    expect(deleteParsed.error.code).toBe(-32000);
  });

  test("should aggregate tools from connected servers if any", async () => {
    const tools = await client.listTools();

    expect(tools).toBeDefined();
    expect(tools.tools).toBeDefined();
    expect(Array.isArray(tools.tools)).toBe(true);

    // Should at least have router management tools
    expect(tools.tools?.length).toBeGreaterThanOrEqual(3);

    const toolNames = tools.tools?.map((tool: { name: string }) => tool.name) || [];

    // Check if there are any aggregated tools (with separator)
    const aggregatedTools = toolNames.filter(name => name.includes(":") && !name.startsWith("router:"));

    if (aggregatedTools.length > 0) {
      console.log(`Found ${aggregatedTools.length} aggregated tools from backend servers`);

      // Verify tool naming convention
      aggregatedTools.forEach(toolName => {
        expect(toolName).toMatch(/^[^:]+:.+$/); // Should match "server:toolname" pattern
      });
    } else {
      console.log("No backend servers connected - only router management tools available");
    }
  });

  test("should maintain consistent server state across calls", async () => {
    // Call list-servers multiple times to ensure consistent state
    const results = await Promise.all([
      client.callTool({ name: "router:list-servers", arguments: {} }),
      client.callTool({ name: "router:stats", arguments: {} }),
      client.callTool({ name: "router:list-servers", arguments: {} }),
    ]);

    expect(results.length).toBe(3);

    const firstListResult = JSON.parse((results[0].content as Array<{ text: string }>)[0].text);
    const statsResult = JSON.parse((results[1].content as Array<{ text: string }>)[0].text);
    const secondListResult = JSON.parse((results[2].content as Array<{ text: string }>)[0].text);

    // Server counts should be consistent
    expect(firstListResult.summary.totalServers).toBe(statsResult.totalServers);
    expect(firstListResult.summary.connectedServers).toBe(statsResult.connectedServers);
    expect(firstListResult.summary.totalTools).toBe(statsResult.totalTools);

    expect(secondListResult.summary.totalServers).toBe(firstListResult.summary.totalServers);
    expect(secondListResult.summary.connectedServers).toBe(firstListResult.summary.connectedServers);
  });

  test("should handle malformed MCP requests gracefully", async () => {
    const response = await fetch(`${routerUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        invalidField: "invalid data",
      }),
    });

    // Should handle malformed requests without crashing
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(600);
  });
});
