import { Database } from "../services/database.js";

export const up = async (database: Database): Promise<void> => {
  await database.query(`
    ALTER TABLE tool_calls
    ADD COLUMN IF NOT EXISTS user_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS user_email VARCHAR(255),
    ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(20)
  `);

  await database.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_calls_user_id ON tool_calls(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_user_email ON tool_calls(user_email, created_at DESC);
  `);
};

export const down = async (database: Database): Promise<void> => {
  await database.query(`
    DROP INDEX IF EXISTS idx_tool_calls_user_id;
    DROP INDEX IF EXISTS idx_tool_calls_user_email;
  `);

  await database.query(`
    ALTER TABLE tool_calls
    DROP COLUMN IF EXISTS user_id,
    DROP COLUMN IF EXISTS user_email,
    DROP COLUMN IF EXISTS api_key_prefix
  `);
};
