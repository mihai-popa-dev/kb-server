const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join('/app/data', 'kb.db');

let db;

async function initDatabase() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    db = new Database(DB_PATH);

    //Enable WAL mode for better performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create documents table
    db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source TEXT,
            namespace TEXT DEFAULT 'shared',
            tier TEXT DEFAULT 'cold',
            tags TEXT DEFAULT '[]',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create FTS5 virtual table for full-text search
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
        USING fts5(
            title,
            content,
            tags,
            content='documents',
            content_rowid='id'
        )
    `);

    // Keep FTS intex in sync with documents table
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS documents_ai
        AFTER INSERT ON documents BEGIN
            INSERT INTO documents_fts(rowid, title, content, tags)
            VALUES (new.id, new.title, new.content, new.tags);
        END
    `);

    db.exec(`
        CREATE TRIGGER IF NOT EXISTS documents_ad
        AFTER DELETE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
            VALUES ('delete', old.id, old.title, old.content, old.tags);
        END    
    `);

    db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au
    AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO documents_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END
  `);

  console.log(`Database initialized at ${DB_PATH}`);
}

function getDb() {
    if (!db) throw new Error('Database not initialized');
    return db;
}

modules.exports = { initDatabase, getDb };