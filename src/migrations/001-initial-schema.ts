import { Database } from "../services/database.js";

export const up = async (database: Database): Promise<void> => {
  await database.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) UNIQUE NOT NULL,
      url VARCHAR(1024) NOT NULL,
      description TEXT,
      enabled BOOLEAN DEFAULT true,
      timeout_ms INTEGER DEFAULT 30000,
      retry_attempts INTEGER DEFAULT 3,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS server_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      details JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_name VARCHAR(255),
      tool_name VARCHAR(255) NOT NULL,
      arguments JSONB,
      response JSONB,
      duration_ms INTEGER,
      status VARCHAR(20) NOT NULL,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS tool_schemas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
      tool_name VARCHAR(255) NOT NULL,
      description TEXT,
      input_schema JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(server_id, tool_name)
    )
  `);

  await database.query(`
    CREATE INDEX IF NOT EXISTS idx_servers_name ON servers(name) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_servers_enabled ON servers(enabled) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_server_events_server_id ON server_events(server_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_server_events_type ON server_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON tool_calls(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_server ON tool_calls(server_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_schemas_server ON tool_schemas(server_id);
  `);
};

export const down = async (database: Database): Promise<void> => {
  await database.query("DROP TABLE IF EXISTS tool_schemas CASCADE");
  await database.query("DROP TABLE IF EXISTS tool_calls CASCADE");
  await database.query("DROP TABLE IF EXISTS server_events CASCADE");
  await database.query("DROP TABLE IF EXISTS servers CASCADE");
};
