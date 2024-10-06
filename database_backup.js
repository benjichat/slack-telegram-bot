// database.js
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./channel_mappings.db");

// Helper function to run migrations
function runMigrations() {
  db.serialize(() => {
    // Create mappings table
    db.run(`
      CREATE TABLE IF NOT EXISTS mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id TEXT NOT NULL,
        slack_channel_id TEXT NOT NULL,
        slack_workspace_id TEXT NOT NULL,
        slack_channel_name TEXT,
        UNIQUE(telegram_chat_id, slack_workspace_id)
      );
    `);

    // // Create group_chats table
    // db.run(`
    //   CREATE TABLE IF NOT EXISTS group_chats (
    //     chat_id TEXT PRIMARY KEY,
    //     title TEXT
    //   );
    // `);

    // Create pending_mappings table
    db.run(`
      CREATE TABLE IF NOT EXISTS pending_mappings (
        code TEXT PRIMARY KEY,
        slack_channel_id TEXT,
        slack_user_id TEXT,
        slack_workspace_id TEXT,
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

    // create telegram bots table
    db.run(`
      CREATE TABLE IF NOT EXISTS telegram_bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_username TEXT,
        UNIQUE(workspace_id, bot_id)
      );
    `);

  });
}

// Function to verify tables
function verifyTablesExist(db, callback) {
  const requiredTables = [
    "mappings",
    // "group_chats",
    "pending_mappings",
    "slack_teams",
    "errors", // Added 'errors' table to required tables
  ];
  let missingTables = [];

  let checkNext = () => {
    if (requiredTables.length === 0) {
      callback(missingTables);
      return;
    }

    const table = requiredTables.shift();
    db.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [table],
      (err, row) => {
        if (err) {
          console.error("Error checking table existence:", err);
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
