use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use once_cell::sync::OnceCell;
use parking_lot::Mutex;

static DB: OnceCell<Mutex<Connection>> = OnceCell::new();

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Memo {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub formatted_content: String,
    pub summary: String,
    pub category: String,
    pub tags: String,
    pub embedding: Option<Vec<u8>>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiUsage {
    pub id: i64,
    pub operation: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Settings {
    pub gemini_api_key: String,
    pub language: String,
}

pub fn init_db(app_dir: PathBuf) -> Result<()> {
    let db_path = app_dir.join("jolajoamemo.db");
    std::fs::create_dir_all(&app_dir).ok();

    let conn = Connection::open(db_path)?;

    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS memos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            formatted_content TEXT NOT NULL,
            summary TEXT DEFAULT '',
            category TEXT DEFAULT '',
            tags TEXT DEFAULT '',
            embedding BLOB,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS api_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            timestamp TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_memos_category ON memos(category);
        CREATE INDEX IF NOT EXISTS idx_memos_tags ON memos(tags);

        INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'ko');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('gemini_api_key', '');
    "#)?;

    DB.set(Mutex::new(conn)).ok();
    Ok(())
}

pub fn get_db() -> &'static Mutex<Connection> {
    DB.get().expect("Database not initialized")
}

// 메모 저장
pub fn save_memo(memo: &Memo) -> Result<i64> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT INTO memos (title, content, formatted_content, summary, category, tags, embedding)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            memo.title,
            memo.content,
            memo.formatted_content,
            memo.summary,
            memo.category,
            memo.tags,
            memo.embedding
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// 메모 업데이트 (병합용)
pub fn update_memo(id: i64, content: &str, formatted_content: &str, summary: &str, tags: &str, embedding: Option<&[u8]>) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "UPDATE memos SET content = ?1, formatted_content = ?2, summary = ?3, tags = ?4, embedding = ?5, updated_at = datetime('now') WHERE id = ?6",
        params![content, formatted_content, summary, tags, embedding, id],
    )?;
    Ok(())
}

// 모든 메모 조회
pub fn get_all_memos() -> Result<Vec<Memo>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, title, content, formatted_content, summary, category, tags, embedding, created_at, updated_at FROM memos ORDER BY updated_at DESC"
    )?;

    let memos = stmt.query_map([], |row| {
        Ok(Memo {
            id: row.get(0)?,
            title: row.get(1)?,
            content: row.get(2)?,
            formatted_content: row.get(3)?,
            summary: row.get(4)?,
            category: row.get(5)?,
            tags: row.get(6)?,
            embedding: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(memos)
}

// 메모 검색 (텍스트)
pub fn search_memos(query: &str) -> Result<Vec<Memo>> {
    let conn = get_db().lock();
    let search_pattern = format!("%{}%", query);
    let mut stmt = conn.prepare(
        "SELECT id, title, content, formatted_content, summary, category, tags, embedding, created_at, updated_at
         FROM memos
         WHERE title LIKE ?1 OR content LIKE ?1 OR formatted_content LIKE ?1 OR tags LIKE ?1 OR category LIKE ?1
         ORDER BY updated_at DESC"
    )?;

    let memos = stmt.query_map([&search_pattern], |row| {
        Ok(Memo {
            id: row.get(0)?,
            title: row.get(1)?,
            content: row.get(2)?,
            formatted_content: row.get(3)?,
            summary: row.get(4)?,
            category: row.get(5)?,
            tags: row.get(6)?,
            embedding: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(memos)
}

// 설정 저장
pub fn save_setting(key: &str, value: &str) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

// 설정 조회
pub fn get_setting(key: &str) -> Result<String> {
    let conn = get_db().lock();
    let value: String = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    ).unwrap_or_default();
    Ok(value)
}

// API 사용량 기록
pub fn log_api_usage(operation: &str, model: &str, input_tokens: i64, output_tokens: i64, cost_usd: f64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT INTO api_usage (operation, model, input_tokens, output_tokens, cost_usd) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![operation, model, input_tokens, output_tokens, cost_usd],
    )?;
    Ok(())
}

// 오늘 사용량 조회
pub fn get_today_usage() -> Result<(i64, i64, f64)> {
    let conn = get_db().lock();
    let result = conn.query_row(
        "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost_usd), 0)
         FROM api_usage WHERE date(timestamp) = date('now')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap_or((0, 0, 0.0));
    Ok(result)
}
