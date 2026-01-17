use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::Rng;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

static DB: OnceCell<Mutex<Connection>> = OnceCell::new();
static ENCRYPTION_KEY: OnceCell<[u8; 32]> = OnceCell::new();

// 암호화 키 초기화 (앱당 고유 키 생성 또는 로드)
fn init_encryption_key(conn: &Connection) -> [u8; 32] {
    // 기존 키가 있는지 확인
    let existing_key: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'encryption_key'", [], |row| row.get(0))
        .ok();

    if let Some(key_b64) = existing_key {
        // 기존 키 복호화
        if let Ok(key_bytes) = BASE64.decode(&key_b64) {
            if key_bytes.len() == 32 {
                let mut key = [0u8; 32];
                key.copy_from_slice(&key_bytes);
                return key;
            }
        }
    }

    // 새 키 생성
    let mut key = [0u8; 32];
    rand::thread_rng().fill(&mut key);

    // 키 저장
    let key_b64 = BASE64.encode(&key);
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('encryption_key', ?1)",
        params![key_b64],
    ).ok();

    key
}

// 값 암호화
pub fn encrypt_value(plaintext: &str) -> String {
    let key = ENCRYPTION_KEY.get().expect("Encryption key not initialized");
    let cipher = Aes256Gcm::new_from_slice(key).expect("Invalid key length");

    // 랜덤 nonce 생성
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // 암호화
    let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes())
        .expect("Encryption failed");

    // nonce + ciphertext를 base64로 인코딩
    let mut combined = nonce_bytes.to_vec();
    combined.extend(ciphertext);
    BASE64.encode(&combined)
}

// 값 복호화
pub fn decrypt_value(encrypted: &str) -> Result<String> {
    let key = ENCRYPTION_KEY.get().expect("Encryption key not initialized");
    let cipher = Aes256Gcm::new_from_slice(key).expect("Invalid key length");

    // base64 디코딩
    let combined = BASE64.decode(encrypted)
        .map_err(|_| rusqlite::Error::InvalidQuery)?;

    if combined.len() < 12 {
        return Err(rusqlite::Error::InvalidQuery);
    }

    // nonce와 ciphertext 분리
    let nonce = Nonce::from_slice(&combined[..12]);
    let ciphertext = &combined[12..];

    // 복호화
    let plaintext = cipher.decrypt(nonce, ciphertext)
        .map_err(|_| rusqlite::Error::InvalidQuery)?;

    String::from_utf8(plaintext)
        .map_err(|_| rusqlite::Error::InvalidQuery)
}

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Attachment {
    pub id: i64,
    pub memo_id: i64,
    pub file_name: String,
    pub file_path: String,       // 저장된 경로 (복사 모드) 또는 원본 경로 (링크 모드)
    pub original_path: String,   // 원본 파일 경로
    pub is_copy: bool,           // 파일 복사 여부
    pub file_size: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dataset {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub columns: Vec<String>,
    pub row_count: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DatasetRow {
    pub id: i64,
    pub dataset_id: i64,
    pub row_index: i64,
    pub data: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SecretKey {
    pub id: i64,
    pub key_name: String,            // 키 이름 (예: OPENAI_API_KEY, AWS_SECRET)
    pub key_value: String,           // 키 값
    pub key_type: String,            // 키 타입 (API_KEY, TOKEN, SECRET, CREDENTIAL, ENV_VAR, PASSWORD)
    pub provider: String,            // 프로바이더 (OpenAI, AWS, Google, GitHub, etc.)
    pub provider_url: Option<String>, // 프로바이더 링크/콘솔 URL
    pub description: Option<String>, // 설명
    pub issued_date: String,         // 발급일자
    pub expires_at: Option<String>,  // 만료일자
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Postit {
    pub id: String,
    pub content: String,
    pub color: String,
    pub position_x: i32,
    pub position_y: i32,
    pub width: i32,
    pub height: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Alarm {
    pub id: i64,
    pub time: String,        // HH:MM 형식
    pub message: String,
    pub enabled: bool,
    pub days: String,        // JSON 배열 형식 (빈 배열이면 매일)
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

        CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memo_id INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            original_path TEXT NOT NULL,
            is_copy INTEGER DEFAULT 0,
            file_size INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (memo_id) REFERENCES memos(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_attachments_memo ON attachments(memo_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_name ON attachments(file_name);

        INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'ko');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('gemini_api_key', '');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('attachment_copy_mode', 'link');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('attachment_storage_path', '');

        -- 엑셀 데이터셋 테이블
        CREATE TABLE IF NOT EXISTS datasets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            columns_json TEXT NOT NULL,
            row_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS dataset_rows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dataset_id INTEGER NOT NULL,
            row_index INTEGER NOT NULL,
            data_json TEXT NOT NULL,
            FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_dataset_rows_dataset ON dataset_rows(dataset_id);
        CREATE INDEX IF NOT EXISTS idx_dataset_rows_index ON dataset_rows(row_index);

        -- 시크릿 키 관리 테이블 (API 키, 토큰, 시크릿 등)
        CREATE TABLE IF NOT EXISTS secret_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key_name TEXT NOT NULL,
            key_value TEXT NOT NULL,
            key_type TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_url TEXT,
            description TEXT,
            issued_date TEXT NOT NULL,
            expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_secret_keys_provider ON secret_keys(provider);
        CREATE INDEX IF NOT EXISTS idx_secret_keys_type ON secret_keys(key_type);
        CREATE INDEX IF NOT EXISTS idx_secret_keys_expires ON secret_keys(expires_at);

        -- 포스트잇 테이블
        CREATE TABLE IF NOT EXISTS postits (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT 'yellow',
            position_x INTEGER DEFAULT 100,
            position_y INTEGER DEFAULT 100,
            width INTEGER DEFAULT 220,
            height INTEGER DEFAULT 200,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- 알람 테이블
        CREATE TABLE IF NOT EXISTS alarms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            time TEXT NOT NULL,
            message TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            days TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_alarms_time ON alarms(time);
        CREATE INDEX IF NOT EXISTS idx_alarms_enabled ON alarms(enabled);
    "#)?;

    // 암호화 키 초기화
    let enc_key = init_encryption_key(&conn);
    ENCRYPTION_KEY.set(enc_key).ok();

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
pub fn update_memo_full(id: i64, title: &str, formatted_content: &str, category: &str, tags: &str, content: Option<&str>) -> Result<()> {
    let conn = get_db().lock();
    if let Some(original) = content {
        conn.execute(
            "UPDATE memos SET title = ?1, formatted_content = ?2, category = ?3, tags = ?4, content = ?5, updated_at = datetime('now') WHERE id = ?6",
            params![title, formatted_content, category, tags, original, id],
        )?;
    } else {
        conn.execute(
            "UPDATE memos SET title = ?1, formatted_content = ?2, category = ?3, tags = ?4, updated_at = datetime('now') WHERE id = ?5",
            params![title, formatted_content, category, tags, id],
        )?;
    }
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

// 카테고리 삭제 (해당 카테고리 메모들의 카테고리를 비움)
pub fn delete_category(category: &str) -> Result<usize> {
    let conn = get_db().lock();
    let count = conn.execute(
        "UPDATE memos SET category = '' WHERE category = ?1",
        params![category],
    )?;
    Ok(count)
}

// 카테고리 이름 변경
pub fn rename_category(old_name: &str, new_name: &str) -> Result<usize> {
    let conn = get_db().lock();
    let count = conn.execute(
        "UPDATE memos SET category = ?1 WHERE category = ?2",
        params![new_name, old_name],
    )?;
    Ok(count)
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

// 거래 수정
pub fn update_transaction(
    id: i64,
    tx_type: &str,
    amount: i64,
    description: &str,
    category: Option<&str>,
    tx_date: Option<&str>,
) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "UPDATE transactions SET tx_type = ?1, amount = ?2, description = ?3, category = ?4, tx_date = ?5 WHERE id = ?6",
        params![tx_type, amount, description, category, tx_date, id],
    )?;
    Ok(())
}

// ===== 메모 연결 항목 삭제 (재분석용) =====

// 메모에 연결된 일정 삭제
pub fn delete_schedules_by_memo_id(memo_id: i64) -> Result<usize> {
    let conn = get_db().lock();
    let count = conn.execute("DELETE FROM schedules WHERE memo_id = ?1", params![memo_id])?;
    Ok(count)
}

// 메모에 연결된 할일 삭제
pub fn delete_todos_by_memo_id(memo_id: i64) -> Result<usize> {
    let conn = get_db().lock();
    let count = conn.execute("DELETE FROM todos WHERE memo_id = ?1", params![memo_id])?;
    Ok(count)
}

// 메모에 연결된 거래 삭제
pub fn delete_transactions_by_memo_id(memo_id: i64) -> Result<usize> {
    let conn = get_db().lock();
    let count = conn.execute("DELETE FROM transactions WHERE memo_id = ?1", params![memo_id])?;
    Ok(count)
}

// 메모 원본 내용 조회
pub fn get_memo_content(id: i64) -> Result<String> {
    let conn = get_db().lock();
    let content: String = conn.query_row(
        "SELECT content FROM memos WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    Ok(content)
}

// ===== 첨부파일 관련 함수 =====

// 첨부파일 저장
pub fn save_attachment(attachment: &Attachment) -> Result<i64> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT INTO attachments (memo_id, file_name, file_path, original_path, is_copy, file_size)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            attachment.memo_id,
            attachment.file_name,
            attachment.file_path,
            attachment.original_path,
            attachment.is_copy as i32,
            attachment.file_size
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// 메모별 첨부파일 조회
pub fn get_attachments_by_memo(memo_id: i64) -> Result<Vec<Attachment>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, memo_id, file_name, file_path, original_path, is_copy, file_size, created_at
         FROM attachments WHERE memo_id = ?1 ORDER BY created_at DESC"
    )?;

    let attachments = stmt.query_map([memo_id], |row| {
        Ok(Attachment {
            id: row.get(0)?,
            memo_id: row.get(1)?,
            file_name: row.get(2)?,
            file_path: row.get(3)?,
            original_path: row.get(4)?,
            is_copy: row.get::<_, i32>(5)? != 0,
            file_size: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(attachments)
}

// 첨부파일 삭제
pub fn delete_attachment(id: i64) -> Result<Attachment> {
    let conn = get_db().lock();
    // 먼저 첨부파일 정보 조회 (파일 삭제용)
    let attachment = conn.query_row(
        "SELECT id, memo_id, file_name, file_path, original_path, is_copy, file_size, created_at
         FROM attachments WHERE id = ?1",
        params![id],
        |row| {
            Ok(Attachment {
                id: row.get(0)?,
                memo_id: row.get(1)?,
                file_name: row.get(2)?,
                file_path: row.get(3)?,
                original_path: row.get(4)?,
                is_copy: row.get::<_, i32>(5)? != 0,
                file_size: row.get(6)?,
                created_at: row.get(7)?,
            })
        },
    )?;
    conn.execute("DELETE FROM attachments WHERE id = ?1", params![id])?;
    Ok(attachment)
}

// 첨부파일 검색 (파일명으로)
pub fn search_attachments(query: &str) -> Result<Vec<Attachment>> {
    let conn = get_db().lock();
    let search_pattern = format!("%{}%", query);
    let mut stmt = conn.prepare(
        "SELECT id, memo_id, file_name, file_path, original_path, is_copy, file_size, created_at
         FROM attachments WHERE file_name LIKE ?1 ORDER BY created_at DESC"
    )?;

    let attachments = stmt.query_map([&search_pattern], |row| {
        Ok(Attachment {
            id: row.get(0)?,
            memo_id: row.get(1)?,
            file_name: row.get(2)?,
            file_path: row.get(3)?,
            original_path: row.get(4)?,
            is_copy: row.get::<_, i32>(5)? != 0,
            file_size: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(attachments)
}

// 메모별 첨부파일 삭제 (메모 삭제 시 CASCADE로 자동 삭제되지만, 파일도 삭제하기 위해)
pub fn get_and_delete_attachments_by_memo(memo_id: i64) -> Result<Vec<Attachment>> {
    let attachments = get_attachments_by_memo(memo_id)?;
    let conn = get_db().lock();
    conn.execute("DELETE FROM attachments WHERE memo_id = ?1", params![memo_id])?;
    Ok(attachments)
}

// ===== 데이터셋(엑셀) 관련 함수 =====

// 데이터셋 저장
pub fn save_dataset(name: &str, description: &str, columns: &[String]) -> Result<i64> {
    let conn = get_db().lock();
    let columns_json = serde_json::to_string(columns).unwrap_or_default();
    conn.execute(
        "INSERT INTO datasets (name, description, columns_json, row_count) VALUES (?1, ?2, ?3, 0)",
        params![name, description, columns_json],
    )?;
    Ok(conn.last_insert_rowid())
}

// 데이터셋 행 저장 (배치)
pub fn save_dataset_rows(dataset_id: i64, rows: &[Vec<String>]) -> Result<i64> {
    let conn = get_db().lock();

    for (idx, row) in rows.iter().enumerate() {
        let data_json = serde_json::to_string(row).unwrap_or_default();
        conn.execute(
            "INSERT INTO dataset_rows (dataset_id, row_index, data_json) VALUES (?1, ?2, ?3)",
            params![dataset_id, idx as i64, data_json],
        )?;
    }

    // row_count 업데이트
    conn.execute(
        "UPDATE datasets SET row_count = ?1 WHERE id = ?2",
        params![rows.len() as i64, dataset_id],
    )?;

    Ok(rows.len() as i64)
}

// 모든 데이터셋 조회
pub fn get_all_datasets() -> Result<Vec<Dataset>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, description, columns_json, row_count, created_at FROM datasets ORDER BY created_at DESC"
    )?;

    let datasets = stmt.query_map([], |row| {
        let columns_json: String = row.get(3)?;
        let columns: Vec<String> = serde_json::from_str(&columns_json).unwrap_or_default();
        Ok(Dataset {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            columns,
            row_count: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(datasets)
}

// 데이터셋 상세 조회
pub fn get_dataset(id: i64) -> Result<Dataset> {
    let conn = get_db().lock();
    let dataset = conn.query_row(
        "SELECT id, name, description, columns_json, row_count, created_at FROM datasets WHERE id = ?1",
        params![id],
        |row| {
            let columns_json: String = row.get(3)?;
            let columns: Vec<String> = serde_json::from_str(&columns_json).unwrap_or_default();
            Ok(Dataset {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                columns,
                row_count: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    )?;
    Ok(dataset)
}

// 데이터셋 행 조회 (페이징)
pub fn get_dataset_rows(dataset_id: i64, offset: i64, limit: i64) -> Result<Vec<DatasetRow>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, dataset_id, row_index, data_json FROM dataset_rows
         WHERE dataset_id = ?1 ORDER BY row_index LIMIT ?2 OFFSET ?3"
    )?;

    let rows = stmt.query_map(params![dataset_id, limit, offset], |row| {
        let data_json: String = row.get(3)?;
        let data: Vec<String> = serde_json::from_str(&data_json).unwrap_or_default();
        Ok(DatasetRow {
            id: row.get(0)?,
            dataset_id: row.get(1)?,
            row_index: row.get(2)?,
            data,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(rows)
}

// 데이터셋 전체 행 조회 (AI 분석용)
pub fn get_all_dataset_rows(dataset_id: i64) -> Result<Vec<DatasetRow>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, dataset_id, row_index, data_json FROM dataset_rows
         WHERE dataset_id = ?1 ORDER BY row_index"
    )?;

    let rows = stmt.query_map(params![dataset_id], |row| {
        let data_json: String = row.get(3)?;
        let data: Vec<String> = serde_json::from_str(&data_json).unwrap_or_default();
        Ok(DatasetRow {
            id: row.get(0)?,
            dataset_id: row.get(1)?,
            row_index: row.get(2)?,
            data,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(rows)
}

// 데이터셋 삭제
pub fn delete_dataset(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute("DELETE FROM dataset_rows WHERE dataset_id = ?1", params![id])?;
    conn.execute("DELETE FROM datasets WHERE id = ?1", params![id])?;
    Ok(())
}

// 데이터셋 검색 (특정 컬럼 값으로)
pub fn search_dataset_rows(dataset_id: i64, search_text: &str) -> Result<Vec<DatasetRow>> {
    let conn = get_db().lock();
    let pattern = format!("%{}%", search_text);
    let mut stmt = conn.prepare(
        "SELECT id, dataset_id, row_index, data_json FROM dataset_rows
         WHERE dataset_id = ?1 AND data_json LIKE ?2 ORDER BY row_index"
    )?;

    let rows = stmt.query_map(params![dataset_id, pattern], |row| {
        let data_json: String = row.get(3)?;
        let data: Vec<String> = serde_json::from_str(&data_json).unwrap_or_default();
        Ok(DatasetRow {
            id: row.get(0)?,
            dataset_id: row.get(1)?,
            row_index: row.get(2)?,
            data,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(rows)
}

// ===== 시크릿 키 관리 함수 =====

// 시크릿 키 저장
pub fn save_secret_key(key: &SecretKey) -> Result<i64> {
    let conn = get_db().lock();
    // 키 값 암호화
    let encrypted_value = encrypt_value(&key.key_value);
    conn.execute(
        "INSERT INTO secret_keys (key_name, key_value, key_type, provider, provider_url, description, issued_date, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            key.key_name,
            encrypted_value,  // 암호화된 값 저장
            key.key_type,
            key.provider,
            key.provider_url,
            key.description,
            key.issued_date,
            key.expires_at
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// 모든 시크릿 키 조회
pub fn get_all_secret_keys() -> Result<Vec<SecretKey>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, key_name, key_value, key_type, provider, provider_url, description, issued_date, expires_at, created_at
         FROM secret_keys ORDER BY provider ASC, key_name ASC, created_at DESC"
    )?;

    let keys = stmt.query_map([], |row| {
        let encrypted_value: String = row.get(2)?;
        // 복호화 (실패하면 암호화된 값 그대로 반환)
        let decrypted_value = decrypt_value(&encrypted_value).unwrap_or(encrypted_value);
        Ok(SecretKey {
            id: row.get(0)?,
            key_name: row.get(1)?,
            key_value: decrypted_value,  // 복호화된 값
            key_type: row.get(3)?,
            provider: row.get(4)?,
            provider_url: row.get(5)?,
            description: row.get(6)?,
            issued_date: row.get(7)?,
            expires_at: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(keys)
}

// 시크릿 키 수정
pub fn update_secret_key(
    id: i64,
    key_name: &str,
    key_value: &str,
    key_type: &str,
    provider: &str,
    provider_url: Option<&str>,
    description: Option<&str>,
    issued_date: &str,
    expires_at: Option<&str>,
) -> Result<()> {
    let conn = get_db().lock();
    // 키 값 암호화
    let encrypted_value = encrypt_value(key_value);
    conn.execute(
        "UPDATE secret_keys SET key_name = ?1, key_value = ?2, key_type = ?3, provider = ?4, provider_url = ?5, description = ?6, issued_date = ?7, expires_at = ?8 WHERE id = ?9",
        params![key_name, encrypted_value, key_type, provider, provider_url, description, issued_date, expires_at, id],
    )?;
    Ok(())
}

// 시크릿 키 삭제
pub fn delete_secret_key(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute("DELETE FROM secret_keys WHERE id = ?1", params![id])?;
    Ok(())
}

// 프로바이더별 시크릿 키 조회
pub fn get_secret_keys_by_provider(provider: &str) -> Result<Vec<SecretKey>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, key_name, key_value, key_type, provider, provider_url, description, issued_date, expires_at, created_at
         FROM secret_keys WHERE provider = ?1 ORDER BY key_name ASC, created_at DESC"
    )?;

    let keys = stmt.query_map([provider], |row| {
        let encrypted_value: String = row.get(2)?;
        let decrypted_value = decrypt_value(&encrypted_value).unwrap_or(encrypted_value);
        Ok(SecretKey {
            id: row.get(0)?,
            key_name: row.get(1)?,
            key_value: decrypted_value,
            key_type: row.get(3)?,
            provider: row.get(4)?,
            provider_url: row.get(5)?,
            description: row.get(6)?,
            issued_date: row.get(7)?,
            expires_at: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(keys)
}

// 모든 프로바이더 목록 조회
pub fn get_all_secret_providers() -> Result<Vec<String>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT provider FROM secret_keys ORDER BY provider"
    )?;

    let providers = stmt.query_map([], |row| {
        row.get::<_, String>(0)
    })?.collect::<Result<Vec<_>>>()?;

    Ok(providers)
}

// 키 타입별 시크릿 키 조회
pub fn get_secret_keys_by_type(key_type: &str) -> Result<Vec<SecretKey>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, key_name, key_value, key_type, provider, provider_url, description, issued_date, expires_at, created_at
         FROM secret_keys WHERE key_type = ?1 ORDER BY provider ASC, key_name ASC"
    )?;

    let keys = stmt.query_map([key_type], |row| {
        let encrypted_value: String = row.get(2)?;
        let decrypted_value = decrypt_value(&encrypted_value).unwrap_or(encrypted_value);
        Ok(SecretKey {
            id: row.get(0)?,
            key_name: row.get(1)?,
            key_value: decrypted_value,
            key_type: row.get(3)?,
            provider: row.get(4)?,
            provider_url: row.get(5)?,
            description: row.get(6)?,
            issued_date: row.get(7)?,
            expires_at: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(keys)
}

// === Postit 관련 함수 ===

pub fn save_postit(postit: &Postit) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT OR REPLACE INTO postits (id, content, color, position_x, position_y, width, height, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))",
        params![
            postit.id,
            postit.content,
            postit.color,
            postit.position_x,
            postit.position_y,
            postit.width,
            postit.height,
        ],
    )?;
    Ok(())
}

pub fn get_postit(id: &str) -> Result<Option<Postit>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, content, color, position_x, position_y, width, height, created_at, updated_at
         FROM postits WHERE id = ?1"
    )?;

    let result = stmt.query_row([id], |row| {
        Ok(Postit {
            id: row.get(0)?,
            content: row.get(1)?,
            color: row.get(2)?,
            position_x: row.get(3)?,
            position_y: row.get(4)?,
            width: row.get(5)?,
            height: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    });

    match result {
        Ok(postit) => Ok(Some(postit)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn get_all_postits() -> Result<Vec<Postit>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, content, color, position_x, position_y, width, height, created_at, updated_at
         FROM postits ORDER BY created_at DESC"
    )?;

    let postits = stmt.query_map([], |row| {
        Ok(Postit {
            id: row.get(0)?,
            content: row.get(1)?,
            color: row.get(2)?,
            position_x: row.get(3)?,
            position_y: row.get(4)?,
            width: row.get(5)?,
            height: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(postits)
}

pub fn delete_postit(id: &str) -> Result<()> {
    let conn = get_db().lock();
    conn.execute("DELETE FROM postits WHERE id = ?1", params![id])?;
    Ok(())
}

// === Alarm 관련 함수 ===

pub fn save_alarm(time: &str, message: &str, days: &str) -> Result<i64> {
    let conn = get_db().lock();
    conn.execute(
        "INSERT INTO alarms (time, message, enabled, days) VALUES (?1, ?2, 1, ?3)",
        params![time, message, days],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_all_alarms() -> Result<Vec<Alarm>> {
    let conn = get_db().lock();
    let mut stmt = conn.prepare(
        "SELECT id, time, message, enabled, days, created_at FROM alarms ORDER BY time ASC"
    )?;

    let alarms = stmt.query_map([], |row| {
        Ok(Alarm {
            id: row.get(0)?,
            time: row.get(1)?,
            message: row.get(2)?,
            enabled: row.get::<_, i32>(3)? != 0,
            days: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?.collect::<Result<Vec<_>>>()?;

    Ok(alarms)
}

pub fn toggle_alarm(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute(
        "UPDATE alarms SET enabled = NOT enabled WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn delete_alarm(id: i64) -> Result<()> {
    let conn = get_db().lock();
    conn.execute("DELETE FROM alarms WHERE id = ?1", params![id])?;
    Ok(())
}
