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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Schedule {
    pub id: i64,
    pub memo_id: Option<i64>,
    pub title: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub google_event_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Todo {
    pub id: i64,
    pub memo_id: Option<i64>,
    pub title: String,
    pub completed: bool,
    pub priority: Option<String>,  // high, medium, low
    pub due_date: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Transaction {
    pub id: i64,
    pub memo_id: Option<i64>,
    pub tx_type: String,  // "income" or "expense"
    pub amount: i64,
    pub description: String,
    pub category: Option<String>,
    pub tx_date: Option<String>,
    pub created_at: String,
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

        CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memo_id INTEGER,
            title TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            location TEXT,
            description TEXT,
            google_event_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (memo_id) REFERENCES memos(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_schedules_start ON schedules(start_time);

        CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memo_id INTEGER,
            title TEXT NOT NULL,
            completed INTEGER DEFAULT 0,
            priority TEXT,
            due_date TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (memo_id) REFERENCES memos(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
        CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_date);

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memo_id INTEGER,
            tx_type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            description TEXT NOT NULL,
            category TEXT,
            tx_date TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (memo_id) REFERENCES memos(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(tx_type);
        CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(tx_date);

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

// 전체 메모 삭제
pub fn delete_all_memos() -> Result<usize> {
    let conn = get_db().lock();
    let count = conn.execute("DELETE FROM memos", [])?;
    Ok(count)
}

// 메모 전체 업데이트 (편집용)
pub fn update_memo_full(id: i64, title: &str, formatted_content: &str, category: &str, tags: &str) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "UPDATE memos SET title = ?1, formatted_content = ?2, category = ?3, tags = ?4, updated_at = datetime('now') WHERE id = ?5",
        params![title, formatted_content, category, tags, id],
    )?;
    Ok(())
}

// 메모 삭제
pub fn delete_memo(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute("DELETE FROM memos WHERE id = ?1", params![id])?;
    Ok(())
}

// ===== 일정 관련 함수 =====

// 일정 저장
pub fn save_schedule(schedule: &Schedule) -> Result<i64> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT INTO schedules (memo_id, title, start_time, end_time, location, description, google_event_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            schedule.memo_id,
            schedule.title,
            schedule.start_time,
            schedule.end_time,
            schedule.location,
            schedule.description,
            schedule.google_event_id
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// 모든 일정 조회
pub fn get_all_schedules() -> Result<Vec<Schedule>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, memo_id, title, start_time, end_time, location, description, google_event_id, created_at
         FROM schedules ORDER BY start_time ASC"
    )?;

    let schedules = stmt.query_map([], |row| {
        Ok(Schedule {
            id: row.get(0)?,
            memo_id: row.get(1)?,
            title: row.get(2)?,
            start_time: row.get(3)?,
            end_time: row.get(4)?,
            location: row.get(5)?,
            description: row.get(6)?,
            google_event_id: row.get(7)?,
            created_at: row.get(8)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(schedules)
}

// 일정의 memo_id 조회
pub fn get_schedule_memo_id(id: i64) -> Result<Option<i64>> {
    let conn = get_db().lock();
    match conn.query_row(
        "SELECT memo_id FROM schedules WHERE id = ?1",
        params![id],
        |row| row.get::<_, Option<i64>>(0),
    ) {
        Ok(memo_id) => Ok(memo_id),
        Err(_) => Ok(None),
    }
}

// 일정 삭제
pub fn delete_schedule(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute("DELETE FROM schedules WHERE id = ?1", params![id])?;
    Ok(())
}

// Google 이벤트 ID 업데이트
pub fn update_schedule_google_id(id: i64, google_event_id: &str) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "UPDATE schedules SET google_event_id = ?1 WHERE id = ?2",
        params![google_event_id, id],
    )?;
    Ok(())
}

// ===== 할일 관련 함수 =====

// 할일 저장
pub fn save_todo(todo: &Todo) -> Result<i64> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT INTO todos (memo_id, title, completed, priority, due_date) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            todo.memo_id,
            todo.title,
            todo.completed as i32,
            todo.priority,
            todo.due_date
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// 모든 할일 조회
pub fn get_all_todos() -> Result<Vec<Todo>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, memo_id, title, completed, priority, due_date, created_at
         FROM todos ORDER BY completed ASC, due_date ASC, created_at DESC"
    )?;

    let todos = stmt.query_map([], |row| {
        Ok(Todo {
            id: row.get(0)?,
            memo_id: row.get(1)?,
            title: row.get(2)?,
            completed: row.get::<_, i32>(3)? != 0,
            priority: row.get(4)?,
            due_date: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(todos)
}

// 할일 완료 토글
pub fn toggle_todo(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "UPDATE todos SET completed = NOT completed WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

// 할일의 memo_id 조회
pub fn get_todo_memo_id(id: i64) -> Result<Option<i64>> {
    let conn = get_db().lock();
    match conn.query_row(
        "SELECT memo_id FROM todos WHERE id = ?1",
        params![id],
        |row| row.get::<_, Option<i64>>(0),
    ) {
        Ok(memo_id) => Ok(memo_id),
        Err(_) => Ok(None),
    }
}

// 할일 삭제
pub fn delete_todo(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute("DELETE FROM todos WHERE id = ?1", params![id])?;
    Ok(())
}

// ===== 페이징 관련 함수 =====

// 메모 페이징 조회
pub fn get_memos_paginated(offset: i64, limit: i64) -> Result<Vec<Memo>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, title, content, formatted_content, summary, category, tags, embedding, created_at, updated_at
         FROM memos ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2"
    )?;

    let memos = stmt.query_map([limit, offset], |row| {
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

// 전체 메모 개수
pub fn get_memo_count() -> Result<i64> {
    let conn = get_db().lock();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM memos", [], |row| row.get(0))?;
    Ok(count)
}

// 기존 카테고리 목록 조회 (중복 제거)
pub fn get_all_categories() -> Result<Vec<String>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT category FROM memos WHERE category != '' ORDER BY category"
    )?;

    let categories = stmt.query_map([], |row| {
        row.get::<_, String>(0)
    })?.collect::<Result<Vec<_>>>()?;

    Ok(categories)
}

// 테스트 데이터 삽입
pub fn insert_test_memos(count: i64) -> Result<i64> {
    let conn = get_db().lock();

    // 표준 카테고리 목록 사용
    let categories = ["업무", "개인", "아이디어", "회의록", "학습", "연락처", "쇼핑", "여행", "건강", "기타"];
    let tags_list = [
        "중요, 긴급",
        "나중에, 참고",
        "아이디어, 브레인스토밍",
        "회의, 팀",
        "공부, 기술",
        "연락처, 사람",
        "쇼핑, 구매",
        "여행, 휴가",
        "운동, 건강",
        "기타, 메모",
    ];

    for i in 0..count {
        let cat_idx = (i as usize) % categories.len();
        let title = format!("테스트 메모 #{}", i + 1);
        let content = format!(
            "이것은 테스트 메모 {}번입니다.\n\n오늘의 할일:\n- 첫 번째 할일\n- 두 번째 할일\n- 세 번째 할일\n\n이 메모는 무한 스크롤 테스트를 위해 생성되었습니다.",
            i + 1
        );

        conn.execute(
            "INSERT INTO memos (title, content, formatted_content, summary, category, tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                title,
                content,
                content,
                format!("테스트 메모 {} 요약", i + 1),
                categories[cat_idx],
                tags_list[cat_idx]
            ],
        )?;
    }

    Ok(count)
}

// ===== 가계부(거래) 관련 함수 =====

// 거래 저장
pub fn save_transaction(transaction: &Transaction) -> Result<i64> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT INTO transactions (memo_id, tx_type, amount, description, category, tx_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            transaction.memo_id,
            transaction.tx_type,
            transaction.amount,
            transaction.description,
            transaction.category,
            transaction.tx_date
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// 모든 거래 조회
pub fn get_all_transactions() -> Result<Vec<Transaction>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, memo_id, tx_type, amount, description, category, tx_date, created_at
         FROM transactions ORDER BY tx_date DESC, created_at DESC"
    )?;

    let transactions = stmt.query_map([], |row| {
        Ok(Transaction {
            id: row.get(0)?,
            memo_id: row.get(1)?,
            tx_type: row.get(2)?,
            amount: row.get(3)?,
            description: row.get(4)?,
            category: row.get(5)?,
            tx_date: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(transactions)
}

// 거래의 memo_id 조회
pub fn get_transaction_memo_id(id: i64) -> Result<Option<i64>> {
    let conn = get_db().lock();
    match conn.query_row(
        "SELECT memo_id FROM transactions WHERE id = ?1",
        params![id],
        |row| row.get::<_, Option<i64>>(0),
    ) {
        Ok(memo_id) => Ok(memo_id),
        Err(_) => Ok(None),
    }
}

// 거래 삭제
pub fn delete_transaction(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute("DELETE FROM transactions WHERE id = ?1", params![id])?;
    Ok(())
}
