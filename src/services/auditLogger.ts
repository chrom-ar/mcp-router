import { Database } from "./database.js";

export interface ToolCallAudit {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  response?: unknown;
  durationMs?: number;
  status: "success" | "error";
  errorMessage?: string;
  userId?: string;
  userEmail?: string;
  apiKey?: string;
}

export interface ToolCallStats {
  total_calls: number;
  successful_calls: number;
  error_calls: number;
  avg_duration_ms: number | null;
  max_duration_ms: number | null;
  min_duration_ms: number | null;
}

export interface ToolUsageStats {
  server_name: string;
  tool_name: string;
  call_count: number;
  success_count: number;
  error_count: number;
  avg_duration_ms: number | null;
}

export interface ToolPerformanceStats {
  server_name: string;
  tool_name: string;
  avg_duration_ms: number;
  max_duration_ms: number;
  call_count: number;
}

export interface ToolErrorStats {
  server_name: string;
  tool_name: string;
  total_calls: number;
  error_count: number;
  error_rate: number;
}

export interface RecentCall {
  id: string;
  server_name: string;
  tool_name: string;
  status: string;
  duration_ms: number | null;
  error_message: string | null;
  created_at: Date;
}

export interface ToolCallDetail extends ToolCallAudit {
  id: string;
  created_at: Date;
}

export class AuditLogger {
  private database: Database;
  private enabled: boolean;
  private logArguments: boolean;
  private logResponses: boolean;
  private batchQueue: ToolCallAudit[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private batchSize = 20;
  private batchInterval = 10000; // 10 seconds

  constructor(
    database: Database,
    options?: {
      enabled?: boolean;
      logArguments?: boolean;
      logResponses?: boolean;
      batchSize?: number;
      batchInterval?: number;
    },
  ) {
    this.database = database;
    this.enabled = options?.enabled || process.env.ENABLE_AUDIT_LOG === "true";
    this.logArguments = options?.logArguments !== false; // Default true
    this.logResponses = options?.logResponses !== false; // Default true
    this.batchSize = options?.batchSize || 20;
    this.batchInterval = options?.batchInterval || 10000;
  }

  async logToolCall(audit: ToolCallAudit): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const sanitizedAudit = {
      ...audit,
      arguments: this.logArguments ? audit.arguments : undefined,
      response: this.logResponses ? audit.response : undefined,
    };

    this.batchQueue.push(sanitizedAudit);

    if (this.batchQueue.length >= this.batchSize) {
      await this.flush();
    } else {
      this.scheduleBatchFlush();
    }
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimer) {
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.flush().catch(error => {
        console.error("Error flushing audit batch:", error);
      });
    }, this.batchInterval);
  }

  async flush(): Promise<void> {
    if (this.batchQueue.length === 0) {
      return;
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);

      this.batchTimer = null;
    }

    const auditsToFlush = [...this.batchQueue];
    this.batchQueue = [];

    try {
      await this.database.transaction(async client => {
        for (const audit of auditsToFlush) {
          await client.query(
            `INSERT INTO tool_calls
             (server_name, tool_name, arguments, response, duration_ms, status, error_message, user_id, user_email, api_key_prefix)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              audit.serverName,
              audit.toolName,
              audit.arguments ? JSON.stringify(audit.arguments) : null,
              audit.response ? JSON.stringify(audit.response) : null,
              audit.durationMs || null,
              audit.status,
              audit.errorMessage || null,
              audit.userId || null,
              audit.userEmail || null,
              audit.apiKey || null,
            ],
          );
        }
      });
    } catch (error: unknown) {
      console.error("Failed to log tool calls to database:", error);
    }
  }

  async getStats(hoursBack = 24): Promise<ToolCallStats> {
    const result = await this.database.query<ToolCallStats>(
      `SELECT
        COUNT(*) as total_calls,
        COUNT(CASE WHEN status = 'success' THEN 1 END) as successful_calls,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_calls,
        AVG(CASE WHEN status = 'success' THEN duration_ms END) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        MIN(CASE WHEN duration_ms > 0 THEN duration_ms END) as min_duration_ms
       FROM tool_calls
       WHERE created_at > NOW() - INTERVAL '$1 hours'`,
      [hoursBack],
    );

    return result.rows[0];
  }

  async getMostUsedTools(limit = 10, hoursBack = 24): Promise<ToolUsageStats[]> {
    const result = await this.database.query<ToolUsageStats>(
      `SELECT
        server_name,
        tool_name,
        COUNT(*) as call_count,
        COUNT(CASE WHEN status = 'success' THEN 1 END) as success_count,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
        AVG(CASE WHEN status = 'success' THEN duration_ms END) as avg_duration_ms
       FROM tool_calls
       WHERE created_at > NOW() - INTERVAL '$1 hours'
       GROUP BY server_name, tool_name
       ORDER BY call_count DESC
       LIMIT $2`,
      [hoursBack, limit],
    );

    return result.rows;
  }

  async getSlowestTools(limit = 10, hoursBack = 24): Promise<ToolPerformanceStats[]> {
    const result = await this.database.query<ToolPerformanceStats>(
      `SELECT
        server_name,
        tool_name,
        AVG(duration_ms) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        COUNT(*) as call_count
       FROM tool_calls
       WHERE created_at > NOW() - INTERVAL '$1 hours'
         AND status = 'success'
         AND duration_ms IS NOT NULL
       GROUP BY server_name, tool_name
       HAVING COUNT(*) > 5
       ORDER BY avg_duration_ms DESC
       LIMIT $2`,
      [hoursBack, limit],
    );

    return result.rows;
  }

  async getErrorProneTools(limit = 10, hoursBack = 24): Promise<ToolErrorStats[]> {
    const result = await this.database.query<ToolErrorStats>(
      `SELECT
        server_name,
        tool_name,
        COUNT(*) as total_calls,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
        ROUND(100.0 * COUNT(CASE WHEN status = 'error' THEN 1 END) / COUNT(*), 2) as error_rate
       FROM tool_calls
       WHERE created_at > NOW() - INTERVAL '$1 hours'
       GROUP BY server_name, tool_name
       HAVING COUNT(*) > 10
       ORDER BY error_rate DESC
       LIMIT $2`,
      [hoursBack, limit],
    );

    return result.rows;
  }

  async getRecentCalls(limit = 100): Promise<RecentCall[]> {
    const result = await this.database.query<RecentCall>(
      `SELECT
        id,
        server_name,
        tool_name,
        status,
        duration_ms,
        error_message,
        created_at
       FROM tool_calls
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async getCallById(id: string): Promise<ToolCallDetail | null> {
    const result = await this.database.queryOne<ToolCallDetail>(
      "SELECT * FROM tool_calls WHERE id = $1",
      [id],
    );

    return result;
  }

  async cleanup(daysOld?: number): Promise<number> {
    const days = daysOld || parseInt(process.env.AUDIT_RETENTION_DAYS || "30");
    const result = await this.database.query(
      "DELETE FROM tool_calls WHERE created_at < NOW() - INTERVAL '$1 days'",
      [days],
    );

    return result.rowCount;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;

    if (!enabled) {
      this.flush().catch(error => {
        console.error("Error flushing audit logs:", error);
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);

      this.batchTimer = null;
    }

    await this.flush();
  }
}
