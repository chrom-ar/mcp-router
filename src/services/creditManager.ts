import { getRequestContext } from "./requestContext.js";

interface QuoteResult {
  success: boolean;
  tool_name?: string;
  estimated_cost?: {
    model_id?: string;
    input_tokens: number;
    output_tokens?: number;
  };
  error?: string;
}

interface QuotaCheckResult {
  allowed: boolean;
  remainingDaily: number;
  remainingMonthly: number;
  userId: string;
  service: string;
}

interface UsageTrackResult {
  success: boolean;
  usage?: {
    daily: number;
    monthly: number;
    remainingDaily: number;
    remainingMonthly: number;
  };
  error?: string;
}

export class CreditManager {
  private userApiUrl: string;
  private adminApiKey: string;
  private toolNameSeparator: string;

  constructor(toolNameSeparator: string = "-->") {
    this.userApiUrl = process.env.USER_MANAGEMENT_API || "https://users.chrom.ar";
    this.toolNameSeparator = process.env.TOOL_NAME_SEPARATOR || toolNameSeparator;
    const adminApiKey = process.env.USER_MANAGEMENT_API_KEY;

    if (!adminApiKey) {
      throw new Error("USER_MANAGEMENT_API_KEY environment variable is required");
    }

    this.adminApiKey = adminApiKey;
  }

  async getQuote(
    serverName: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    callToolFn: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    hasQuoteTool: boolean,
  ): Promise<QuoteResult | null> {
    if (!hasQuoteTool) {
      return null;
    }

    try {
      const quoteToolName = `${serverName}${this.toolNameSeparator}quote`;
      const quoteArgs = {
        tool_name: toolName.replace(`${serverName}${this.toolNameSeparator}`, ""),
        tool_args: toolArgs,
      };

      const result = await callToolFn(quoteToolName, quoteArgs);
      const content = result?.content as Array<{ text?: string }> | undefined;

      if (content?.[0]?.text) {
        const parsed = JSON.parse(content[0].text);

        if (!parsed.success || !parsed.estimated_cost) {
          console.error(`[CREDIT] Quote failed for ${serverName}:${toolName}:`, parsed);
        }

        return parsed;
      }

      console.error(`[CREDIT] No quote response for ${serverName}:${toolName}`);

      return null;
    } catch (error: unknown) {
      console.error(`[CREDIT] Error getting quote for ${serverName}:${toolName}:`, error);
      return null;
    }
  }

  async checkCredits(
    apiKey: string,
    service: string,
    model?: string,
    inputTokens: number = 0,
    outputTokens: number = 0,
  ): Promise<QuotaCheckResult> {
    try {
      const requestBody = {
        apiKey,
        service,
        model: model || "default",
        inputTokens,
        outputTokens,
      };

      const response = await fetch(`${this.userApiUrl}/usage/quota`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.adminApiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.text();

        throw new Error(`Credit check failed: ${response.status} - ${errorData}`);
      }

      const data = await response.json();

      return data as QuotaCheckResult;
    } catch (error: unknown) {
      console.error("Error checking credits:", error);

      throw error;
    }
  }

  async trackUsage(
    apiKey: string,
    service: string,
    model: string | undefined,
    inputTokens: number,
    outputTokens: number,
    metadata?: Record<string, unknown>,
  ): Promise<UsageTrackResult> {
    try {
      const response = await fetch(`${this.userApiUrl}/usage/track`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.adminApiKey}`,
        },
        body: JSON.stringify({
          apiKey,
          service,
          model: model || "default",
          inputTokens,
          outputTokens,
          usage: inputTokens + outputTokens, // Total tokens
          metadata,
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();

        console.error(`[CREDIT] Usage tracking failed: ${response.status} - ${errorData}`);

        return { success: false, error: errorData };
      }

      const data = await response.json();

      return { success: true, ...data };
    } catch (error: unknown) {
      console.error("[CREDIT] Error tracking usage:", error);

      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.userApiUrl}/validate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey }),
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json();

      return data.valid === true;
    } catch (error: unknown) {
      console.error("Error validating API key:", error);

      return false;
    }
  }

  async executeWithCreditCheck(
    serverName: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    callToolFn: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    hasQuoteTool: boolean,
  ): Promise<Record<string, unknown>> {
    const context = getRequestContext();

    // Bypass checks for special cases (like quote tool itself)
    if (this.shouldBypassCreditCheck(toolName, context)) {
      return await callToolFn(`${serverName}${this.toolNameSeparator}${toolName}`, toolArgs);
    }

    // Get quote from server
    const quoteInfo = await this.getQuoteInfo(serverName, toolName, toolArgs, callToolFn, hasQuoteTool);

    // Handle servers without quote tool
    if (!quoteInfo.hasQuoteTool) {
      return await this.executeWithApiKeyValidation(
        serverName,
        toolName,
        toolArgs,
        callToolFn,
        context,
      );
    }

    // Handle servers with quote tool
    return await this.executeWithFullCreditCheck(
      serverName,
      toolName,
      toolArgs,
      callToolFn,
      context,
      quoteInfo,
    );
  }

  private shouldBypassCreditCheck(toolName: string, context: { apiKey?: string } | undefined): boolean {
    return toolName === "quote" || !context?.apiKey;
  }

  private async getQuoteInfo(
    serverName: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    callToolFn: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    hasQuoteTool: boolean,
  ): Promise<{
    hasQuoteTool: boolean;
    inputTokens: number;
    outputTokens: number;
    model?: string;
  }> {
    const quote = await this.getQuote(serverName, toolName, toolArgs, callToolFn, hasQuoteTool);

    if (quote?.success && quote.estimated_cost) {
      return {
        hasQuoteTool: true,
        inputTokens: quote.estimated_cost.input_tokens || 0,
        outputTokens: quote.estimated_cost.output_tokens || 0,
        model: quote.estimated_cost.model_id,
      };
    }

    if (!quote && hasQuoteTool) {
      console.error(`[CREDIT] No quote available for ${serverName}:${toolName}`);
    }

    return {
      hasQuoteTool: false,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  private async executeWithApiKeyValidation(
    serverName: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    callToolFn: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    context: { apiKey?: string; userId?: string; userEmail?: string } | undefined,
  ): Promise<Record<string, unknown>> {
    const isValid = context?.apiKey ? await this.validateApiKey(context.apiKey) : false;

    if (!isValid) {
      console.error(`[CREDIT] API key validation failed for user ${context?.userEmail || context?.userId || "unknown"}`);

      throw new Error("Invalid API key");
    }

    return await callToolFn(`${serverName}${this.toolNameSeparator}${toolName}`, toolArgs);
  }

  private async executeWithFullCreditCheck(
    serverName: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    callToolFn: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    context: { apiKey?: string; userId?: string; userEmail?: string } | undefined,
    quoteInfo: {
      inputTokens: number;
      outputTokens: number;
      model?: string;
    },
  ): Promise<Record<string, unknown>> {
    await this.verifySufficientCredits(
      context,
      serverName,
      toolName,
      quoteInfo,
    );

    const startTime = Date.now();
    const result = await callToolFn(`${serverName}${this.toolNameSeparator}${toolName}`, toolArgs);
    const actualMetrics = this.extractActualMetrics(result, quoteInfo, serverName, toolName);
    const duration = Date.now() - startTime;

    await this.trackUsage(
      context?.apiKey || "",
      serverName,
      actualMetrics.model,
      actualMetrics.inputTokens,
      actualMetrics.outputTokens,
      {
        toolName,
        duration,
        success: true,
        userId: context?.userId,
        userEmail: context?.userEmail,
        quotedInputTokens: quoteInfo.inputTokens,
        quotedOutputTokens: quoteInfo.outputTokens,
      },
    );

    return result;
  }

  private async verifySufficientCredits(
    context: { apiKey?: string; userId?: string; userEmail?: string } | undefined,
    serverName: string,
    toolName: string,
    quoteInfo: {
      inputTokens: number;
      outputTokens: number;
      model?: string;
    },
  ): Promise<void> {
    const creditCheck = await this.checkCredits(
      context?.apiKey || "",
      serverName,
      quoteInfo.model,
      quoteInfo.inputTokens,
      quoteInfo.outputTokens,
    );

    if (!creditCheck.allowed) {
      console.error(
        `[CREDIT] Insufficient credits for ${context?.userEmail || context?.userId} on ${serverName}:${toolName} - ` +
        `Daily: ${creditCheck.remainingDaily}, Monthly: ${creditCheck.remainingMonthly}`,
      );

      throw new Error(
        `Insufficient credits. Daily remaining: ${creditCheck.remainingDaily}, Monthly remaining: ${creditCheck.remainingMonthly}`,
      );
    }
  }

  private extractActualMetrics(
    result: Record<string, unknown>,
    quoteInfo: {
      inputTokens: number;
      outputTokens: number;
      model?: string;
    },
    serverName: string,
    toolName: string,
  ): {
    inputTokens: number;
    outputTokens: number;
    model?: string;
  } {
    let actualInputTokens = quoteInfo.inputTokens;
    let actualOutputTokens = quoteInfo.outputTokens;
    let actualModel = quoteInfo.model;

    try {
      const content = result?.content as Array<{ text?: string }> | undefined;

      if (content?.[0]?.text) {
        const responseData = JSON.parse(content[0].text);
        const metricsData = responseData.models_metrics || responseData.modelsMetrics;

        if (metricsData) {
          actualInputTokens = 0;
          actualOutputTokens = 0;

          for (const [modelId, metrics] of Object.entries(metricsData)) {
            const modelMetrics = metrics as { input_tokens?: number; output_tokens?: number };

            actualInputTokens += modelMetrics.input_tokens || 0;
            actualOutputTokens += modelMetrics.output_tokens || 0;

            if (!actualModel && modelId) {
              actualModel = modelId;
            }
          }

          // Log significant differences
          if (Math.abs(actualInputTokens - quoteInfo.inputTokens) > 10 ||
              Math.abs(actualOutputTokens - quoteInfo.outputTokens) > 10) {
            console.log(
              `[CREDIT] Token mismatch for ${serverName}:${toolName}: ` +
              `actual(${actualInputTokens}/${actualOutputTokens}) vs ` +
              `quoted(${quoteInfo.inputTokens}/${quoteInfo.outputTokens})`,
            );
          }
        }
      }
    } catch (parseError: unknown) {
      console.error("[CREDIT] Failed to parse actual metrics from response:", parseError);
    }

    return {
      inputTokens: actualInputTokens,
      outputTokens: actualOutputTokens,
      model: actualModel,
    };
  }
}
