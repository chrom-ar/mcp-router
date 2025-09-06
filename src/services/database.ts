import { EventEmitter } from "events";
import { Pool, PoolClient, PoolConfig } from "pg";

export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  poolSize?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export class Database extends EventEmitter {
  private pool: Pool | null = null;
  private config: DatabaseConfig;
  private isConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: DatabaseConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      const poolConfig: PoolConfig = this.config.connectionString
        ? {
          connectionString: this.config.connectionString,
          max: this.config.poolSize || 20,
          idleTimeoutMillis: this.config.idleTimeoutMillis || 30000,
          connectionTimeoutMillis: this.config.connectionTimeoutMillis || 2000,
        }
        : {
          host: this.config.host || "localhost",
          port: this.config.port || 5432,
          database: this.config.database || "mcp_router",
          user: this.config.user || "postgres",
          password: this.config.password || "postgres",
          max: this.config.poolSize || 20,
          idleTimeoutMillis: this.config.idleTimeoutMillis || 30000,
          connectionTimeoutMillis: this.config.connectionTimeoutMillis || 2000,
        };

      if (this.config.ssl) {
        poolConfig.ssl = this.config.ssl;
      }

      this.pool = new Pool(poolConfig);

      await this.pool.query("SELECT NOW()");

      this.isConnected = true;

      this.pool.on("error", (err: Error) => {
        console.error("Unexpected database error:", err);
        this.emit("error", err);
        this.handleConnectionError();
      });

      // console.log("Database connected successfully");
      this.emit("connected");
    } catch (error) {
      console.error("Failed to connect to database:", error);
      this.isConnected = false;
      this.emit("connection_failed", error);

      throw error;
    }
  }

  private handleConnectionError(): void {
    this.isConnected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      // console.log("Attempting to reconnect to database...");
      try {
        await this.disconnect();
        await this.connect();
      } catch (error: unknown) {
        console.error("Reconnection failed:", error);

        this.handleConnectionError();
      }
    }, 5000);
  }

  async query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (!this.pool) {
      throw new Error("Database not connected");
    }

    try {
      const result = await this.pool.query(text, params);

      return {
        rows: result.rows,
        rowCount: result.rowCount || 0,
      };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error) {
        const dbError = error as Error & { code: string };

        if (dbError.code === "ECONNREFUSED" || dbError.code === "ENOTFOUND") {
          console.error("Database query failed - connection issue:", dbError.message);

          this.handleConnectionError();
        }
      }

      throw error;
    }
  }

  async queryOne<T = unknown>(text: string, params?: unknown[]): Promise<T | null> {
    const result = await this.query<T>(text, params);
    return result.rows[0] || null;
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new Error("Database not connected");
    }

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await callback(client);

      await client.query("COMMIT");

      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK");

      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
    if (!this.pool || !this.isConnected) {
      return { healthy: false, error: "Not connected" };
    }

    try {
      const start = Date.now();

      await this.pool.query("SELECT 1");

      const latency = Date.now() - start;

      return { healthy: true, latency };
    } catch (error: unknown) {
      return { healthy: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);

      this.reconnectTimer = null;
    }

    if (this.pool) {
      try {
        await this.pool.end();

        this.pool = null;
        this.isConnected = false;
        // console.log("Database disconnected");
        this.emit("disconnected");
      } catch (error: unknown) {
        console.error("Error disconnecting from database:", error);

        throw error;
      }
    }
  }

  getStatus(): { connected: boolean; poolSize?: number; idle?: number; waiting?: number } {
    if (!this.pool) {
      return { connected: false };
    }

    return {
      connected: this.isConnected,
      poolSize: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }
}

let databaseInstance: Database | null = null;

export const getDatabase = (config?: DatabaseConfig): Database => {
  if (!databaseInstance && config) {
    databaseInstance = new Database(config);
  } else if (!databaseInstance) {
    throw new Error("Database not initialized. Please provide configuration.");
  }

  return databaseInstance;
};

export const initDatabaseFromEnv = (): Database => {
  const config: DatabaseConfig = {
    connectionString: process.env.DATABASE_URL,
    poolSize: parseInt(process.env.DB_POOL_SIZE || "20"),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || "30000"),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || "2000"),
  };

  if (process.env.DB_SSL === "true") {
    config.ssl = process.env.DB_SSL_REJECT_UNAUTHORIZED === "false"
      ? { rejectUnauthorized: false }
      : true;
  }

  if (!config.connectionString) {
    config.host = process.env.DB_HOST || "localhost";
    config.port = parseInt(process.env.DB_PORT || "5432");
    config.database = process.env.DB_NAME || "mcp_router";
    config.user = process.env.DB_USER || "postgres";
    config.password = process.env.DB_PASSWORD || "postgres";
  }

  return getDatabase(config);
};
