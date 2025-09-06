import { Database } from "../services/database.js";
import { McpServerConfig, McpServerConfigInput } from "../types/index.js";

export interface ServerRecord {
  id: string;
  name: string;
  url: string;
  description?: string;
  enabled: boolean;
  timeout_ms: number;
  retry_attempts: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export class ServerRepository {
  private database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async findAll(includeDisabled = false): Promise<ServerRecord[]> {
    const query = includeDisabled
      ? "SELECT * FROM servers WHERE deleted_at IS NULL ORDER BY name"
      : "SELECT * FROM servers WHERE deleted_at IS NULL AND enabled = true ORDER BY name";

    const result = await this.database.query<ServerRecord>(query);
    return result.rows;
  }

  async findById(id: string): Promise<ServerRecord | null> {
    const result = await this.database.queryOne<ServerRecord>(
      "SELECT * FROM servers WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return result;
  }

  async findByName(name: string): Promise<ServerRecord | null> {
    const result = await this.database.queryOne<ServerRecord>(
      "SELECT * FROM servers WHERE name = $1 AND deleted_at IS NULL",
      [name],
    );
    return result;
  }

  async create(config: McpServerConfigInput): Promise<ServerRecord> {
    return this.upsert(config);
  }

  async update(id: string, updates: Partial<McpServerConfigInput>): Promise<ServerRecord | null> {
    const server = await this.findById(id);
    if (!server) {
      return null;
    }

    return this.upsert({ ...server, ...updates });
  }

  async upsert(config: McpServerConfigInput): Promise<ServerRecord> {
    const query = `
      INSERT INTO servers (name, url, description, enabled, timeout_ms, retry_attempts, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (name)
      DO UPDATE SET
        url = EXCLUDED.url,
        description = EXCLUDED.description,
        enabled = EXCLUDED.enabled,
        timeout_ms = EXCLUDED.timeout_ms,
        retry_attempts = EXCLUDED.retry_attempts,
        metadata = EXCLUDED.metadata,
        updated_at = NOW(),
        deleted_at = NULL
      RETURNING *
    `;

    const result = await this.database.queryOne<ServerRecord>(query, [
      config.name,
      config.url,
      config.description || null,
      config.enabled !== false,
      config.timeout || 30000,
      config.retryAttempts || 3,
      JSON.stringify({}),
    ]);

    return result!;
  }

  async getById(id: string): Promise<ServerRecord | null> {
    return this.findById(id);
  }

  async getByName(name: string): Promise<ServerRecord | null> {
    return this.findByName(name);
  }

  async getAll(includeDisabled = false): Promise<ServerRecord[]> {
    return this.findAll(includeDisabled);
  }

  async getEnabled(): Promise<ServerRecord[]> {
    const result = await this.database.query<ServerRecord>(
      "SELECT * FROM servers WHERE enabled = true AND deleted_at IS NULL ORDER BY name",
    );
    return result.rows;
  }

  async setEnabled(name: string, enabled: boolean): Promise<ServerRecord | null> {
    const result = await this.database.queryOne<ServerRecord>(
      "UPDATE servers SET enabled = $2, updated_at = NOW() WHERE name = $1 AND deleted_at IS NULL RETURNING *",
      [name, enabled],
    );
    return result;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.database.query(
      "UPDATE servers SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return result.rowCount > 0;
  }

  async hardDelete(id: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM servers WHERE id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  async updateMetadata(id: string, metadata: Record<string, unknown> | null): Promise<ServerRecord | null> {
    const result = await this.database.queryOne<ServerRecord>(
      "UPDATE servers SET metadata = $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *",
      [id, metadata ? JSON.stringify(metadata) : null],
    );
    return result;
  }

  toConfig(record: ServerRecord): McpServerConfig {
    return {
      id: record.id,
      name: record.name,
      url: record.url,
      description: record.description,
      enabled: record.enabled,
      timeout: record.timeout_ms,
      retryAttempts: record.retry_attempts,
    };
  }

  async getAllAsConfigs(includeDisabled = false): Promise<McpServerConfig[]> {
    const records = await this.findAll(includeDisabled);

    return records.map(record => this.toConfig(record));
  }

  async count(includeDisabled = false): Promise<number> {
    const query = includeDisabled
      ? "SELECT COUNT(*) FROM servers WHERE deleted_at IS NULL"
      : "SELECT COUNT(*) FROM servers WHERE deleted_at IS NULL AND enabled = true";

    const result = await this.database.queryOne<{ count: string }>(query);
    return parseInt(result?.count || "0");
  }

  async cleanupDeleted(daysOld = 30): Promise<number> {
    const result = await this.database.query(
      "DELETE FROM servers WHERE deleted_at < NOW() - INTERVAL '$1 days'",
      [daysOld],
    );
    return result.rowCount;
  }
}
