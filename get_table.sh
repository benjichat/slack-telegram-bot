for table in $(sqlite3 channel_mappings.db "SELECT name FROM sqlite_master WHERE type='table';"); do
  echo "Table: $table"
  sqlite3 channel_mappings.db "PRAGMA table_info($table);"
  echo
done