import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CreditManager } from "./creditManager.js";
import { runWithContext } from "./requestContext.js";

// Mock fetch globally
global.fetch = vi.fn();

describe("CreditManager", () => {
  let creditManager: CreditManager;
  const mockAdminKey = "test_admin_key_123";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.USER_MANAGEMENT_API_KEY = mockAdminKey;
    process.env.TOOL_NAME_SEPARATOR = "-->";
    creditManager = new CreditManager();
  });

  afterEach(() => {
    delete process.env.USER_MANAGEMENT_API_KEY;
    delete process.env.TOOL_NAME_SEPARATOR;
  });

  describe("constructor", () => {
    it("should throw error if USER_MANAGEMENT_API_KEY is not set", () => {
      delete process.env.USER_MANAGEMENT_API_KEY;
      expect(() => new CreditManager()).toThrow("USER_MANAGEMENT_API_KEY environment variable is required");
    });

    it("should initialize with custom API URL", () => {
      process.env.USER_MANAGEMENT_API = "https://custom.api.com";
      const cm = new CreditManager();
      expect(cm).toBeDefined();
      delete process.env.USER_MANAGEMENT_API;
    });
  });

  describe("getQuote", () => {
    it("should return quote when server has quote tool", async () => {
      const mockCallTool = vi.fn().mockResolvedValue({
        content: [{
          text: JSON.stringify({
            success: true,
            estimated_cost: {
              model_id: "test-model",
              input_tokens: 100,
              output_tokens: 50,
            },
          }),
        }],
      });

      const result = await creditManager.getQuote(
        "test-server",
        "test-tool",
        { arg: "value" },
        mockCallTool,
        true, // hasQuoteTool
      );

      expect(mockCallTool).toHaveBeenCalledWith("test-server-->quote", {
        tool_name: "test-tool",
        tool_args: { arg: "value" },
      });
      expect(result).toEqual({
        success: true,
        estimated_cost: {
          model_id: "test-model",
          input_tokens: 100,
          output_tokens: 50,
        },
      });
    });

    it("should return null when server does not have quote tool", async () => {
      const mockCallTool = vi.fn().mockRejectedValue(new Error("Tool not found"));

      const result = await creditManager.getQuote(
        "test-server",
        "test-tool",
        { arg: "value" },
        mockCallTool,
        false, // hasQuoteTool
      );

      expect(result).toBeNull();
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it("should not call quote tool when hasQuoteTool is false", async () => {
      const mockCallTool = vi.fn();

      const result = await creditManager.getQuote(
        "test-server",
        "test-tool",
        { arg: "value" },
        mockCallTool,
        false, // hasQuoteTool = false
      );

      expect(result).toBeNull();
      expect(mockCallTool).not.toHaveBeenCalled(); // Should never call the tool
    });

    it("should return null when quote response is invalid", async () => {
      const mockCallTool = vi.fn().mockResolvedValue({
        content: [],
      });

      const result = await creditManager.getQuote(
        "test-server",
        "test-tool",
        { arg: "value" },
        mockCallTool,
        true, // hasQuoteTool
      );

      expect(result).toBeNull();
    });
  });

  describe("validateApiKey", () => {
    it("should return true for valid API key", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ valid: true }),
      });

      const result = await creditManager.validateApiKey("valid_key");

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://users.chrom.ar/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: "valid_key" }),
        },
      );
    });

    it("should return false for invalid API key", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
      });

      const result = await creditManager.validateApiKey("invalid_key");

      expect(result).toBe(false);
    });

    it("should return false when API call fails", async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("Network error"));

      const result = await creditManager.validateApiKey("any_key");

      expect(result).toBe(false);
    });
  });

  describe("checkCredits", () => {
    it("should return quota check result when successful", async () => {
      const mockResponse = {
        allowed: true,
        remainingDaily: 1000,
        remainingMonthly: 50000,
        userId: "user-123",
        service: "test-service",
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await creditManager.checkCredits(
        "test_key",
        "test-service",
        "test-model",
        100,
        50,
      );

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://users.chrom.ar/usage/quota",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${mockAdminKey}`,
          },
          body: JSON.stringify({
            apiKey: "test_key",
            service: "test-service",
            model: "test-model",
            inputTokens: 100,
            outputTokens: 50,
          }),
        },
      );
    });

    it("should throw error when credit check fails", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });

      await expect(
        creditManager.checkCredits("test_key", "test-service"),
      ).rejects.toThrow("Credit check failed: 403 - Forbidden");
    });
  });

  describe("trackUsage", () => {
    it("should successfully track usage", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracked: true }),
      });

      const result = await creditManager.trackUsage(
        "test_key",
        "test-service",
        "test-model",
        100,
        50,
        { toolName: "test-tool" },
      );

      expect(result).toEqual({
        success: true,
        tracked: true,
      });
    });

    it("should return error when tracking fails but not throw", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Server error",
      });

      const result = await creditManager.trackUsage(
        "test_key",
        "test-service",
        "test-model",
        100,
        50,
      );

      expect(result).toEqual({
        success: false,
        error: "Server error",
      });
    });

    it("should handle network errors gracefully", async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("Network failed"));

      const result = await creditManager.trackUsage(
        "test_key",
        "test-service",
        "test-model",
        100,
        50,
      );

      expect(result).toEqual({
        success: false,
        error: "Network failed",
      });
    });
  });

  describe("executeWithCreditCheck", () => {
    const mockCallTool = vi.fn();

    beforeEach(() => {
      mockCallTool.mockClear();
    });

    it("should bypass credit check for quote tool", async () => {
      mockCallTool.mockResolvedValue({ success: true });

      const result = await creditManager.executeWithCreditCheck(
        "test-server",
        "quote",
        { arg: "value" },
        mockCallTool,
        false, // hasQuoteTool - doesn't matter for quote tool itself
      );

      expect(result).toEqual({ success: true });
      expect(mockCallTool).toHaveBeenCalledWith("test-server-->quote", { arg: "value" });
    });

    it("should bypass credit check when no API key in context", async () => {
      mockCallTool.mockResolvedValue({ success: true });

      // No context means no API key
      const result = await creditManager.executeWithCreditCheck(
        "test-server",
        "test-tool",
        { arg: "value" },
        mockCallTool,
        false, // hasQuoteTool
      );

      expect(result).toEqual({ success: true });
      expect(mockCallTool).toHaveBeenCalledWith("test-server-->test-tool", { arg: "value" });
    });

    describe("with API key but no quote tool", () => {
      it("should validate API key and execute when valid", async () => {
        await runWithContext({
          apiKey: "test_api_key",
          userId: "user-123",
          userEmail: "test@example.com",
        }, async () => {
        // Mock getQuote to return null (no quote tool)
          mockCallTool.mockImplementation(toolName => {
            if (toolName.includes("-->quote")) {
              return Promise.reject(new Error("Tool not found"));
            }
            return Promise.resolve({ success: true, content: [{ text: "result" }] });
          });

          // Mock validateApiKey to return true
          (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ valid: true }),
          });

          const result = await creditManager.executeWithCreditCheck(
            "test-server",
            "test-tool",
            { arg: "value" },
            mockCallTool,
            false, // hasQuoteTool - server doesn't have quote tool
          );

          expect(result).toEqual({ success: true, content: [{ text: "result" }] });
        });
      });

      it("should throw error when API key is invalid", async () => {
        await runWithContext({
          apiKey: "test_api_key",
          userId: "user-123",
          userEmail: "test@example.com",
        }, async () => {
        // Mock getQuote to return null
          mockCallTool.mockImplementation(toolName => {
            if (toolName.includes("-->quote")) {
              return Promise.reject(new Error("Tool not found"));
            }
            return Promise.resolve({ success: true });
          });

          // Mock validateApiKey to return false
          (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: false,
          });

          await expect(
            creditManager.executeWithCreditCheck(
              "test-server",
              "test-tool",
              { arg: "value" },
              mockCallTool,
              false, // hasQuoteTool
            ),
          ).rejects.toThrow("Invalid API key");
        });
      });
    });

    describe("with API key and quote tool", () => {
      it("should check credits and execute when allowed", async () => {
        await runWithContext({
          apiKey: "test_api_key",
          userId: "user-123",
          userEmail: "test@example.com",
        }, async () => {
        // Mock getQuote to return a quote
          mockCallTool.mockImplementation(toolName => {
            if (toolName.includes("-->quote")) {
              return Promise.resolve({
                content: [{
                  text: JSON.stringify({
                    success: true,
                    estimated_cost: {
                      model_id: "test-model",
                      input_tokens: 100,
                      output_tokens: 50,
                    },
                  }),
                }],
              });
            }
            return Promise.resolve({
              content: [{
                text: JSON.stringify({ result: "success" }),
              }],
            });
          });

          // Mock checkCredits to allow
          (global.fetch as jest.Mock).mockImplementation((url: string) => {
            if (url.includes("/usage/quota")) {
              return Promise.resolve({
                ok: true,
                json: async () => ({
                  allowed: true,
                  remainingDaily: 1000,
                  remainingMonthly: 50000,
                  userId: "user-123",
                  service: "test-server",
                }),
              });
            }
            if (url.includes("/usage/track")) {
              return Promise.resolve({
                ok: true,
                json: async () => ({ tracked: true }),
              });
            }
          });

          const result = await creditManager.executeWithCreditCheck(
            "test-server",
            "test-tool",
            { arg: "value" },
            mockCallTool,
            true, // hasQuoteTool - server has quote tool
          );

          expect(result).toHaveProperty("content");

          const content = result.content as Array<{ text: string }>;

          expect(Array.isArray(content)).toBe(true);
          expect(content[0]).toHaveProperty("text");
          expect(content[0].text).toContain("success");
          expect(mockCallTool).toHaveBeenCalledTimes(2); // quote + actual tool
        });
      });

      it("should throw error when credits are insufficient", async () => {
        await runWithContext({
          apiKey: "test_api_key",
          userId: "user-123",
          userEmail: "test@example.com",
        }, async () => {
        // Mock getQuote
          mockCallTool.mockImplementation(toolName => {
            if (toolName.includes("-->quote")) {
              return Promise.resolve({
                content: [{
                  text: JSON.stringify({
                    success: true,
                    estimated_cost: {
                      model_id: "test-model",
                      input_tokens: 100,
                      output_tokens: 50,
                    },
                  }),
                }],
              });
            }
          });

          // Mock checkCredits to deny
          (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              allowed: false,
              remainingDaily: 0,
              remainingMonthly: 100,
              userId: "user-123",
              service: "test-server",
            }),
          });

          await expect(
            creditManager.executeWithCreditCheck(
              "test-server",
              "test-tool",
              { arg: "value" },
              mockCallTool,
              true, // hasQuoteTool
            ),
          ).rejects.toThrow("Insufficient credits. Daily remaining: 0, Monthly remaining: 100");
        });
      });

      it("should extract actual metrics from response", async () => {
        await runWithContext({
          apiKey: "test_api_key",
          userId: "user-123",
          userEmail: "test@example.com",
        }, async () => {
        // Mock getQuote
          mockCallTool.mockImplementation(toolName => {
            if (toolName.includes("-->quote")) {
              return Promise.resolve({
                content: [{
                  text: JSON.stringify({
                    success: true,
                    estimated_cost: {
                      model_id: "test-model",
                      input_tokens: 100,
                      output_tokens: 50,
                    },
                  }),
                }],
              });
            }
            // Return response with models_metrics
            return Promise.resolve({
              content: [{
                text: JSON.stringify({
                  result: "success",
                  models_metrics: {
                    "actual-model": {
                      input_tokens: 120,
                      output_tokens: 60,
                    },
                  },
                }),
              }],
            });
          });

          // Mock checkCredits and trackUsage
          (global.fetch as jest.Mock).mockImplementation((url: string) => {
            if (url.includes("/usage/quota")) {
              return Promise.resolve({
                ok: true,
                json: async () => ({
                  allowed: true,
                  remainingDaily: 1000,
                  remainingMonthly: 50000,
                }),
              });
            }
            if (url.includes("/usage/track")) {
              return Promise.resolve({
                ok: true,
                json: async () => ({ tracked: true }),
              });
            }
          });

          const result = await creditManager.executeWithCreditCheck(
            "test-server",
            "test-tool",
            { arg: "value" },
            mockCallTool,
            true, // hasQuoteTool
          );

          // Check that trackUsage was called with actual metrics
          const trackCall = (global.fetch as jest.Mock).mock.calls.find((call: [string, RequestInit]) =>
            call[0].includes("/usage/track"),
          );
          const trackBody = JSON.parse(trackCall[1].body);
          expect(trackBody.inputTokens).toBe(120);
          expect(trackBody.outputTokens).toBe(60);
        });
      });

      it("should extract actual metrics from response using camelCase modelsMetrics", async () => {
        await runWithContext({
          apiKey: "test_api_key",
          userId: "user-123",
          userEmail: "test@example.com",
        }, async () => {
          // Mock getQuote
          mockCallTool.mockImplementation(toolName => {
            if (toolName.includes("-->quote")) {
              return Promise.resolve({
                content: [{
                  text: JSON.stringify({
                    success: true,
                    estimated_cost: {
                      model_id: "test-model",
                      input_tokens: 100,
                      output_tokens: 50,
                    },
                  }),
                }],
              });
            }

            return Promise.resolve({
              content: [{
                text: JSON.stringify({
                  result: "success",
                  modelsMetrics: {
                    "actual-model": {
                      input_tokens: 130,
                      output_tokens: 70,
                    },
                  },
                }),
              }],
            });
          });

          (global.fetch as jest.Mock).mockImplementation((url: string) => {
            if (url.includes("/usage/quota")) {
              return Promise.resolve({
                ok: true,
                json: async () => ({
                  allowed: true,
                  remainingDaily: 1000,
                  remainingMonthly: 50000,
                }),
              });
            }

            if (url.includes("/usage/track")) {
              return Promise.resolve({
                ok: true,
                json: async () => ({ tracked: true }),
              });
            }
          });

          const result = await creditManager.executeWithCreditCheck(
            "test-server",
            "test-tool",
            { arg: "value" },
            mockCallTool,
            true, // hasQuoteTool
          );

          const trackCall = (global.fetch as jest.Mock).mock.calls.find((call: [string, RequestInit]) =>
            call[0].includes("/usage/track"),
          );
          const trackBody = JSON.parse(trackCall[1].body);

          expect(trackBody.inputTokens).toBe(130);
          expect(trackBody.outputTokens).toBe(70);
        });
      });
    });
  });
});
