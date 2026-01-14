mod ai;
mod db;

use db::{Attachment, Memo, Schedule, Todo, Transaction};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize)]
pub struct InputResult {
    pub success: bool,
    pub message: String,
    pub memo_id: Option<i64>,
    pub merged: bool,
    pub title: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub schedules_added: i32,
    pub todos_added: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub answer: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UsageStats {
    pub today_input_tokens: i64,
    pub today_output_tokens: i64,
    pub today_cost_usd: f64,
}

// 입력: 텍스트를 분석해서 저장 또는 병합 (여러 개 자동 분리)
#[tauri::command]
async fn input_memo(content: String) -> Result<InputResult, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    // 모델 설정 가져오기 (없으면 기본값)
    let model = db::get_setting("gemini_model").unwrap_or_default();

    // 기존 메모 목록 가져오기
    let existing_memos = db::get_all_memos().map_err(|e| e.to_string())?;
    let memo_info: Vec<(i64, String, String)> = existing_memos
        .iter()
        .map(|m| (m.id, m.title.clone(), m.summary.clone()))
        .collect();

    // 기존 카테고리 목록 가져오기
    let existing_categories = db::get_all_categories().map_err(|e| e.to_string())?;

    // AI 분석 (여러 개 자동 분리)
    let (items, usage) = ai::analyze_multi_memo(&api_key, &model, &content, &memo_info, &existing_categories).await?;

    // 사용량 기록
    let model_name = if model.is_empty() { "gemini-3-flash-preview" } else { &model };
    db::log_api_usage(
        "analyze",
        model_name,
        usage.input_tokens,
        usage.output_tokens,
        usage.cost_usd,
    )
    .map_err(|e| e.to_string())?;

    let mut saved_count = 0;
    let mut merged_count = 0;
    let mut titles: Vec<String> = Vec::new();

    let mut schedules_added = 0;
    let mut todos_added = 0;
    let mut transactions_added = 0;

    let mut last_memo_id: Option<i64> = None;  // 마지막 메모 ID 저장

    for analysis in items {
        let tags_str = analysis.tags.join(", ");
        let mut memo_id: Option<i64> = None;

        // 병합 또는 새로 저장
        if let Some(merge_id) = analysis.should_merge_with {
            if let Some(existing) = existing_memos.iter().find(|m| m.id == merge_id) {
                let merged_content = format!("{}\n\n---\n\n{}", existing.content, &content);
                let merged_formatted = format!(
                    "{}\n\n---\n\n{}",
                    existing.formatted_content, analysis.formatted_content
                );
                let merged_tags = if existing.tags.is_empty() {
                    tags_str.clone()
                } else {
                    format!("{}, {}", existing.tags, tags_str)
                };

                db::update_memo(
                    merge_id,
                    &merged_content,
                    &merged_formatted,
                    &analysis.summary,
                    &merged_tags,
                    None,
                )
                .map_err(|e| e.to_string())?;

                memo_id = Some(merge_id);
                last_memo_id = memo_id;  // 마지막 메모 ID 저장
                merged_count += 1;
                titles.push(format!("{}(병합)", existing.title));
            }
        } else {
            // 새 메모 저장 (원본 입력 그대로 저장)
            let new_memo = Memo {
                id: 0,
                title: analysis.title.clone(),
                content: content.clone(),  // 사용자 입력 원본 그대로 저장
                formatted_content: analysis.formatted_content,
                summary: analysis.summary,
                category: analysis.category,
                tags: tags_str,
                embedding: None,
                created_at: String::new(),
                updated_at: String::new(),
            };

            let new_id = db::save_memo(&new_memo).map_err(|e| e.to_string())?;
            memo_id = Some(new_id);
            last_memo_id = memo_id;  // 마지막 메모 ID 저장
            saved_count += 1;
            titles.push(analysis.title);
        }

        // 일정 저장 (메모와 연결)
        for schedule_info in analysis.schedules {
            let schedule = Schedule {
                id: 0,
                memo_id,  // 원본 메모와 연결
                title: schedule_info.title,
                start_time: schedule_info.start_time,
                end_time: schedule_info.end_time,
                location: schedule_info.location,
                description: schedule_info.description,
                google_event_id: None,
                created_at: String::new(),
            };
            db::save_schedule(&schedule).map_err(|e| e.to_string())?;
            schedules_added += 1;
        }

        // 할일 저장 (메모와 연결)
        for todo_info in analysis.todos {
            let todo = Todo {
                id: 0,
                memo_id,  // 원본 메모와 연결
                title: todo_info.title,
                completed: false,
                priority: todo_info.priority,
                due_date: todo_info.due_date,
                created_at: String::new(),
            };
            db::save_todo(&todo).map_err(|e| e.to_string())?;
            todos_added += 1;
        }

        // 거래 저장 (메모와 연결)
        for tx_info in analysis.transactions {
            let transaction = Transaction {
                id: 0,
                memo_id,  // 원본 메모와 연결
                tx_type: tx_info.tx_type,
                amount: tx_info.amount,
                description: tx_info.description,
                category: tx_info.category,
                tx_date: tx_info.tx_date,
                created_at: String::new(),
            };
            db::save_transaction(&transaction).map_err(|e| e.to_string())?;
            transactions_added += 1;
        }
    }

    let mut extra_parts = Vec::new();
    if schedules_added > 0 { extra_parts.push(format!("일정 {}개", schedules_added)); }
    if todos_added > 0 { extra_parts.push(format!("할일 {}개", todos_added)); }
    if transactions_added > 0 { extra_parts.push(format!("가계부 {}건", transactions_added)); }
    let extra_msg = if extra_parts.is_empty() { String::new() } else { format!(" ({})", extra_parts.join(", ")) };

    let message = if titles.len() == 1 {
        format!("'{}' 저장됨{}", titles[0], extra_msg)
    } else {
        format!(
            "{}개 저장, {}개 병합: {}{}",
            saved_count,
            merged_count,
            titles.join(", "),
            extra_msg
        )
    };

    Ok(InputResult {
        success: true,
        message,
        memo_id: last_memo_id,
        merged: merged_count > 0,
        title: titles.join(", "),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: usage.cost_usd,
        schedules_added,
        todos_added,
    })
}

// 찾기: 질문에 대한 답변
#[tauri::command]
async fn search_memo(question: String) -> Result<SearchResult, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    // 모델 설정 가져오기 (없으면 기본값)
    let model = db::get_setting("gemini_model").unwrap_or_default();

    // 모든 메모 가져오기
    let memos = db::get_all_memos().map_err(|e| e.to_string())?;

    if memos.is_empty() {
        return Ok(SearchResult {
            answer: "저장된 메모가 없습니다. 먼저 메모를 입력해주세요.".to_string(),
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
        });
    }

    // 컨텍스트 구성
    let context: Vec<(String, String)> = memos
        .iter()
        .map(|m| (m.title.clone(), m.formatted_content.clone()))
        .collect();

    // AI 질의응답
    let (answer, usage) = ai::ask_question(&api_key, &model, &question, &context).await?;

    // 사용량 기록
    let model_name = if model.is_empty() { "gemini-3-flash-preview" } else { &model };
    db::log_api_usage(
        "search",
        model_name,
        usage.input_tokens,
        usage.output_tokens,
        usage.cost_usd,
    )
    .map_err(|e| e.to_string())?;

    Ok(SearchResult {
        answer,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: usage.cost_usd,
    })
}

// 모든 메모 조회
#[tauri::command]
fn get_memos() -> Result<Vec<Memo>, String> {
    db::get_all_memos().map_err(|e| e.to_string())
}

// 설정 저장
#[tauri::command]
fn save_setting(key: String, value: String) -> Result<(), String> {
    db::save_setting(&key, &value).map_err(|e| e.to_string())
}

// 설정 조회
#[tauri::command]
fn get_setting(key: String) -> Result<String, String> {
    db::get_setting(&key).map_err(|e| e.to_string())
}

// 오늘 사용량
#[tauri::command]
fn get_usage() -> Result<UsageStats, String> {
    let (input, output, cost) = db::get_today_usage().map_err(|e| e.to_string())?;
    Ok(UsageStats {
        today_input_tokens: input,
        today_output_tokens: output,
        today_cost_usd: cost,
    })
}

// DB 내보내기 (JSON)
#[tauri::command]
fn export_db() -> Result<String, String> {
    let memos = db::get_all_memos().map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&memos).map_err(|e| e.to_string())
}

// DB 불러오기 (JSON)
#[tauri::command]
fn import_db(json_data: String) -> Result<i32, String> {
    let memos: Vec<Memo> =
        serde_json::from_str(&json_data).map_err(|e| format!("JSON 파싱 실패: {}", e))?;
    let mut count = 0;
    for memo in memos {
        db::save_memo(&memo).map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

// 메모 업데이트 (편집용)
#[tauri::command]
fn update_memo(id: i64, title: String, formatted_content: String, category: String, tags: String, content: Option<String>) -> Result<(), String> {
    db::update_memo_full(id, &title, &formatted_content, &category, &tags, content.as_deref()).map_err(|e| e.to_string())
}

// 카테고리 목록 조회
#[tauri::command]
fn get_categories() -> Result<Vec<String>, String> {
    db::get_all_categories().map_err(|e| e.to_string())
}

// 카테고리 삭제
#[tauri::command]
fn delete_category(category: String) -> Result<usize, String> {
    db::delete_category(&category).map_err(|e| e.to_string())
}

// 카테고리 이름 변경
#[tauri::command]
fn rename_category(old_name: String, new_name: String) -> Result<usize, String> {
    db::rename_category(&old_name, &new_name).map_err(|e| e.to_string())
}

// 메모 재분석 (내용 변경 시 일정/할일/거래 업데이트)
#[tauri::command]
async fn reanalyze_memo(id: i64, new_content: String) -> Result<InputResult, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    let model = db::get_setting("gemini_model").unwrap_or_default();

    // 기존 연결 항목 삭제
    db::delete_schedules_by_memo_id(id).ok();
    db::delete_todos_by_memo_id(id).ok();
    db::delete_transactions_by_memo_id(id).ok();

    // 기존 메모 정보 (병합용으로 빈 목록 전달)
    let existing_categories = db::get_all_categories().map_err(|e| e.to_string())?;

    // AI 재분석 (병합 없이 단일 분석)
    let (items, usage) = ai::analyze_multi_memo(&api_key, &model, &new_content, &[], &existing_categories).await?;

    // 사용량 기록
    let model_name = if model.is_empty() { "gemini-3-flash-preview" } else { &model };
    db::log_api_usage(
        "reanalyze",
        model_name,
        usage.input_tokens,
        usage.output_tokens,
        usage.cost_usd,
    )
    .map_err(|e| e.to_string())?;

    let mut schedules_added = 0;
    let mut todos_added = 0;
    let mut transactions_added = 0;
    let mut title = String::new();

    // 첫 번째 분석 결과로 메모 업데이트
    if let Some(analysis) = items.first() {
        title = analysis.title.clone();
        let tags_str = analysis.tags.join(", ");

        // 메모 내용 업데이트
        db::update_memo(
            id,
            &new_content,
            &analysis.formatted_content,
            &analysis.summary,
            &tags_str,
            None,
        )
        .map_err(|e| e.to_string())?;

        // 메모 제목/카테고리 업데이트
        db::update_memo_full(id, &analysis.title, &analysis.formatted_content, &analysis.category, &tags_str, Some(&new_content))
            .map_err(|e| e.to_string())?;

        // 일정 저장
        for schedule_info in &analysis.schedules {
            let schedule = Schedule {
                id: 0,
                memo_id: Some(id),
                title: schedule_info.title.clone(),
                start_time: schedule_info.start_time.clone(),
                end_time: schedule_info.end_time.clone(),
                location: schedule_info.location.clone(),
                description: schedule_info.description.clone(),
                google_event_id: None,
                created_at: String::new(),
            };
            db::save_schedule(&schedule).map_err(|e| e.to_string())?;
            schedules_added += 1;
        }

        // 할일 저장
        for todo_info in &analysis.todos {
            let todo = Todo {
                id: 0,
                memo_id: Some(id),
                title: todo_info.title.clone(),
                completed: false,
                priority: todo_info.priority.clone(),
                due_date: todo_info.due_date.clone(),
                created_at: String::new(),
            };
            db::save_todo(&todo).map_err(|e| e.to_string())?;
            todos_added += 1;
        }

        // 거래 저장
        for tx_info in &analysis.transactions {
            let transaction = Transaction {
                id: 0,
                memo_id: Some(id),
                tx_type: tx_info.tx_type.clone(),
                amount: tx_info.amount,
                description: tx_info.description.clone(),
                category: tx_info.category.clone(),
                tx_date: tx_info.tx_date.clone(),
                created_at: String::new(),
            };
            db::save_transaction(&transaction).map_err(|e| e.to_string())?;
            transactions_added += 1;
        }
    }

    let mut extra_parts = Vec::new();
    if schedules_added > 0 { extra_parts.push(format!("일정 {}개", schedules_added)); }
    if todos_added > 0 { extra_parts.push(format!("할일 {}개", todos_added)); }
    if transactions_added > 0 { extra_parts.push(format!("가계부 {}건", transactions_added)); }
    let extra_msg = if extra_parts.is_empty() { String::new() } else { format!(" ({})", extra_parts.join(", ")) };

    Ok(InputResult {
        success: true,
        message: format!("'{}' 재분석 완료{}", title, extra_msg),
        memo_id: Some(id),
        merged: false,
        title,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: usage.cost_usd,
        schedules_added,
        todos_added,
    })
}

// 메모 삭제
#[tauri::command]
fn delete_memo(id: i64) -> Result<(), String> {
    db::delete_memo(id).map_err(|e| e.to_string())
}

// 전체 메모 삭제
#[tauri::command]
fn delete_all_memos() -> Result<usize, String> {
    db::delete_all_memos().map_err(|e| e.to_string())
}

// 모든 일정 조회
#[tauri::command]
fn get_schedules() -> Result<Vec<Schedule>, String> {
    db::get_all_schedules().map_err(|e| e.to_string())
}

// 일정 삭제 (원본 메모도 함께 삭제)
#[tauri::command]
fn delete_schedule(id: i64) -> Result<(), String> {
    // 먼저 연결된 메모 ID 조회
    if let Ok(Some(memo_id)) = db::get_schedule_memo_id(id) {
        db::delete_memo(memo_id).ok(); // 메모 삭제 (실패해도 계속)
    }
    db::delete_schedule(id).map_err(|e| e.to_string())
}

// 모든 할일 조회
#[tauri::command]
fn get_todos() -> Result<Vec<Todo>, String> {
    db::get_all_todos().map_err(|e| e.to_string())
}

// 할일 완료 토글
#[tauri::command]
fn toggle_todo(id: i64) -> Result<(), String> {
    db::toggle_todo(id).map_err(|e| e.to_string())
}

// 할일 삭제 (원본 메모도 함께 삭제)
#[tauri::command]
fn delete_todo(id: i64) -> Result<(), String> {
    // 먼저 연결된 메모 ID 조회
    if let Ok(Some(memo_id)) = db::get_todo_memo_id(id) {
        db::delete_memo(memo_id).ok(); // 메모 삭제 (실패해도 계속)
    }
    db::delete_todo(id).map_err(|e| e.to_string())
}

// 메모 페이징 조회
#[tauri::command]
fn get_memos_paginated(offset: i64, limit: i64) -> Result<Vec<Memo>, String> {
    db::get_memos_paginated(offset, limit).map_err(|e| e.to_string())
}

// 메모 총 개수
#[tauri::command]
fn get_memo_count() -> Result<i64, String> {
    db::get_memo_count().map_err(|e| e.to_string())
}

// 모든 거래 조회
#[tauri::command]
fn get_transactions() -> Result<Vec<Transaction>, String> {
    db::get_all_transactions().map_err(|e| e.to_string())
}

// 거래 삭제 (원본 메모도 함께 삭제)
#[tauri::command]
fn delete_transaction(id: i64) -> Result<(), String> {
    // 먼저 연결된 메모 ID 조회
    if let Ok(Some(memo_id)) = db::get_transaction_memo_id(id) {
        db::delete_memo(memo_id).ok(); // 메모 삭제 (실패해도 계속)
    }
    db::delete_transaction(id).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_transaction(
    id: i64,
    tx_type: String,
    amount: i64,
    description: String,
    category: Option<String>,
    tx_date: Option<String>,
) -> Result<(), String> {
    db::update_transaction(
        id,
        &tx_type,
        amount,
        &description,
        category.as_deref(),
        tx_date.as_deref(),
    )
    .map_err(|e| e.to_string())
}

// ===== 첨부파일 관련 명령어 =====

// 첨부파일 추가
#[tauri::command]
async fn add_attachment(
    app_handle: tauri::AppHandle,
    memo_id: i64,
    file_path: String,
) -> Result<Attachment, String> {
    use std::fs;
    use std::path::Path;

    let original_path = Path::new(&file_path);
    if !original_path.exists() {
        return Err("파일을 찾을 수 없습니다".to_string());
    }

    let file_name = original_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file_size = fs::metadata(&file_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    // 설정 확인: 복사 모드 여부
    let copy_mode = db::get_setting("attachment_copy_mode")
        .unwrap_or_default();
    let is_copy = copy_mode == "copy";

    let stored_path = if is_copy {
        // 저장 경로 가져오기
        let storage_path = db::get_setting("attachment_storage_path")
            .unwrap_or_default();

        let storage_dir = if storage_path.is_empty() {
            // 기본 경로: 앱 데이터 디렉토리/attachments
            app_handle
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("attachments")
        } else {
            Path::new(&storage_path).to_path_buf()
        };

        // 디렉토리 생성
        fs::create_dir_all(&storage_dir).map_err(|e| e.to_string())?;

        // 중복 파일명 처리
        let mut target_path = storage_dir.join(&file_name);
        let mut counter = 1;
        while target_path.exists() {
            let stem = original_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let ext = original_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let new_name = if ext.is_empty() {
                format!("{}_{}", stem, counter)
            } else {
                format!("{}_{}.{}", stem, counter, ext)
            };
            target_path = storage_dir.join(new_name);
            counter += 1;
        }

        // 파일 복사
        fs::copy(&file_path, &target_path).map_err(|e| e.to_string())?;
        target_path.to_string_lossy().to_string()
    } else {
        // 링크 모드: 원본 경로 그대로 사용
        file_path.clone()
    };

    let attachment = Attachment {
        id: 0,
        memo_id,
        file_name,
        file_path: stored_path.clone(),
        original_path: file_path,
        is_copy,
        file_size,
        created_at: String::new(),
    };

    let id = db::save_attachment(&attachment).map_err(|e| e.to_string())?;

    Ok(Attachment {
        id,
        ..attachment
    })
}

// 메모별 첨부파일 조회
#[tauri::command]
fn get_attachments(memo_id: i64) -> Result<Vec<Attachment>, String> {
    db::get_attachments_by_memo(memo_id).map_err(|e| e.to_string())
}

// 첨부파일 삭제
#[tauri::command]
fn remove_attachment(id: i64) -> Result<(), String> {
    use std::fs;

    let attachment = db::delete_attachment(id).map_err(|e| e.to_string())?;

    // 복사된 파일인 경우 파일도 삭제
    if attachment.is_copy {
        fs::remove_file(&attachment.file_path).ok(); // 실패해도 무시
    }

    Ok(())
}

// 첨부파일 열기
#[tauri::command]
fn open_attachment(file_path: String) -> Result<(), String> {
    open::that(&file_path).map_err(|e| e.to_string())
}

// 첨부파일 검색
#[tauri::command]
fn search_attachments(query: String) -> Result<Vec<Attachment>, String> {
    db::search_attachments(&query).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("Failed to get app dir");
            db::init_db(app_dir).expect("Failed to init database");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            input_memo,
            search_memo,
            get_memos,
            get_memos_paginated,
            get_memo_count,
            save_setting,
            get_setting,
            get_usage,
            export_db,
            import_db,
            update_memo,
            get_categories,
            delete_category,
            rename_category,
            reanalyze_memo,
            delete_memo,
            delete_all_memos,
            get_schedules,
            delete_schedule,
            get_todos,
            toggle_todo,
            delete_todo,
            get_transactions,
            delete_transaction,
            update_transaction,
            add_attachment,
            get_attachments,
            remove_attachment,
            open_attachment,
            search_attachments
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
