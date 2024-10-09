// database.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./channel_mappings.db');

// Helper function to run migrations
function runMigrations() {
  db.serialize(() => {
    // Create or update mappings table
    db.run(`
      CREATE TABLE IF NOT EXISTS mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id TEXT NOT NULL,
        slack_channel_id TEXT NOT NULL,
        slack_workspace_id TEXT NOT NULL,
        telegram_bot_id TEXT NOT NULL,
        UNIQUE(telegram_chat_id, slack_workspace_id, telegram_bot_id)
      );
    `);

    // Create or update pending_mappings table
    db.run(`
      CREATE TABLE IF NOT EXISTS pending_mappings (
        code TEXT PRIMARY KEY,
        slack_channel_id TEXT,
        slack_user_id TEXT,
        slack_workspace_id TEXT,
        telegram_bot_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create slack_teams table
    db.run(`
      CREATE TABLE IF NOT EXISTS slack_teams (
        team_id TEXT PRIMARY KEY,
        team_name TEXT,
        access_token TEXT NOT NULL,
        bot_user_id TEXT NOT NULL
      );
    `);

    // Create errors table
    db.run(`
      CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        error_message TEXT NOT NULL,
        stack_trace TEXT
      );
    `);

    // Create team_bots table
    db.run(`
      CREATE TABLE IF NOT EXISTS team_bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        telegram_bot_token TEXT NOT NULL,
        telegram_bot_username TEXT NOT NULL,
        telegram_bot_id TEXT NOT NULL,
        UNIQUE(team_id, telegram_bot_id)
      );
    `);

    // **Create channel_messages table**
    db.run(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL UNIQUE,
        message_ts TEXT NOT NULL
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS channel_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slack_channel_id TEXT NOT NULL,
        slack_workspace_id TEXT NOT NULL,
        connection_type TEXT NOT NULL,
        UNIQUE(slack_channel_id, slack_workspace_id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS slack_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slack_channel_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        UNIQUE(slack_channel_id, telegram_chat_id)
      )
    `);


  });
}

// Function to verify tables
function verifyTablesExist(db, callback) {
  const requiredTables = [
    'mappings',
    'pending_mappings',
    'slack_teams',
    'errors',
    'team_bots',
    'channel_messages', // Added channel_messages to the required tables
  ];
  let missingTables = [];

  let checkNext = () => {
    if (requiredTables.length === 0) {
      callback(missingTables);
      return;
    }

    const table = requiredTables.shift();
    db.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name =? `,
      [table],
      (err, row) => {
        if (err) {
          console.error('Error checking table existence:', err);
          missingTables.push(table);
        } else if (!row) {
          missingTables.push(table);
        }
        checkNext();
      }
    );
  };

  checkNext();
}

// Run migrations
runMigrations();

// Export the db object and verification function
module.exports = { db, verifyTablesExist };