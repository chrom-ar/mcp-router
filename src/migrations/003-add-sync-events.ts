import { Database } from "../services/database.js";

export const up = async (database: Database): Promise<void> => {
  await database.query(`
    CREATE TABLE IF NOT EXISTS sync_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(50) NOT NULL,
      event_data JSONB NOT NULL,
      instance_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      processed_by VARCHAR(255)[]
    )
  `);

  await database.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_events_unprocessed 
    ON sync_events(created_at) 
    WHERE processed_at IS NULL
  `);

  await database.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_events_created_at 
    ON sync_events(created_at)
  `);

  await database.query(`
    ALTER TABLE servers 
    ADD COLUMN IF NOT EXISTS managed_by VARCHAR(255)
  `);
};

export const down = async (database: Database): Promise<void> => {
  await database.query("DROP TABLE IF EXISTS sync_events CASCADE");
  await database.query("ALTER TABLE servers DROP COLUMN IF EXISTS managed_by");
};