mod ai;
mod db;

use db::{Attachment, Memo, Schedule, Todo, Transaction, Dataset, DatasetRow, Postit};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use calamine::{Reader, Xlsx};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use once_cell::sync::Lazy;

// 스캔 취소 플래그
static SCAN_CANCELLED: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

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

// ===== 폴더 정리 기능 =====

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub extension: String,
    pub modified: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrganizePlan {
    pub file_path: String,
    pub file_name: String,
    pub suggested_folder: String,
    pub reason: String,
    pub selected: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MovedFileInfo {
    pub file_name: String,
    pub from_path: String,
    pub to_path: String,
    pub to_folder: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrganizeResult {
    pub success: bool,
    pub moved_count: i32,
    pub failed_count: i32,
    pub message: String,
    pub moved_files: Vec<MovedFileInfo>,  // 이동된 파일 상세 정보
}

// 폴더 스캔
#[tauri::command]
fn scan_folder(path: String) -> Result<Vec<FileInfo>, String> {
    use std::fs;

    let entries = fs::read_dir(&path).map_err(|e| format!("폴더를 읽을 수 없습니다: {}", e))?;

    let mut files: Vec<FileInfo> = Vec::new();

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            let metadata = entry.metadata().ok();

            let name = entry.file_name().to_string_lossy().to_string();

            // 숨김 파일 제외
            if name.starts_with('.') {
                continue;
            }

            let is_dir = path.is_dir();
            let extension = if is_dir {
                String::new()
            } else {
                path.extension()
                    .map(|e| e.to_string_lossy().to_string())
                    .unwrap_or_default()
            };

            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified = metadata
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let datetime: chrono::DateTime<chrono::Local> = t.into();
                    datetime.format("%Y-%m-%d %H:%M").to_string()
                })
                .unwrap_or_default();

            files.push(FileInfo {
                name,
                path: path.to_string_lossy().to_string(),
                size,
                extension,
                modified,
                is_dir,
            });
        }
    }

    // 파일명으로 정렬
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(files)
}

// AI로 파일 정리 분석
#[tauri::command]
async fn analyze_files_for_organization(files: Vec<FileInfo>) -> Result<Vec<OrganizePlan>, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    let model = db::get_setting("gemini_model").unwrap_or_default();

    // 파일만 필터링 (폴더 제외) 및 튜플로 변환
    let file_tuples: Vec<(String, String, u64, String, String)> = files
        .iter()
        .filter(|f| !f.is_dir)
        .map(|f| (f.name.clone(), f.extension.clone(), f.size, f.modified.clone(), f.path.clone()))
        .collect();

    if file_tuples.is_empty() {
        return Ok(Vec::new());
    }

    let ai_results = ai::analyze_files_for_organization(&api_key, &model, &file_tuples).await?;

    // 결과를 OrganizePlan으로 변환
    let plans: Vec<OrganizePlan> = ai_results
        .into_iter()
        .map(|(file_path, file_name, suggested_folder, reason)| OrganizePlan {
            file_path,
            file_name,
            suggested_folder,
            reason,
            selected: true,
        })
        .collect();

    Ok(plans)
}

// 파일 정리 실행
#[tauri::command]
fn execute_organization(base_path: String, plans: Vec<OrganizePlan>) -> Result<OrganizeResult, String> {
    use std::fs;
    use std::path::Path;

    let mut moved_count = 0;
    let mut failed_count = 0;
    let mut moved_files: Vec<MovedFileInfo> = Vec::new();

    for plan in plans {
        if !plan.selected {
            continue;
        }

        let source = Path::new(&plan.file_path);
        let target_dir = Path::new(&base_path).join(&plan.suggested_folder);

        // 대상 폴더 생성
        if !target_dir.exists() {
            if let Err(_) = fs::create_dir_all(&target_dir) {
                failed_count += 1;
                continue;
            }
        }

        let target_path = target_dir.join(&plan.file_name);

        // 파일 이동
        let move_success = if let Err(_) = fs::rename(source, &target_path) {
            // rename 실패 시 copy + delete 시도
            if let Ok(_) = fs::copy(source, &target_path) {
                fs::remove_file(source).ok();
                true
            } else {
                false
            }
        } else {
            true
        };

        if move_success {
            moved_count += 1;
            moved_files.push(MovedFileInfo {
                file_name: plan.file_name.clone(),
                from_path: plan.file_path.clone(),
                to_path: target_path.to_string_lossy().to_string(),
                to_folder: plan.suggested_folder.clone(),
            });
        } else {
            failed_count += 1;
        }
    }

    Ok(OrganizeResult {
        success: failed_count == 0,
        moved_count,
        failed_count,
        message: format!("{}개 파일 이동 완료, {}개 실패", moved_count, failed_count),
        moved_files,
    })
}

// ===== 자동 검색 & 리포트 생성 기능 (에이전트 기반) =====

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SourceSummary {
    pub title: String,
    pub url: String,
    pub source: String,
    pub summary: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResearchResult {
    pub query: String,
    pub summary: String,
    pub key_points: Vec<String>,
    pub sources: Vec<ai::SearchItem>,
    pub source_summaries: Vec<SourceSummary>,  // 각 출처별 요약 (별첨)
    pub full_report: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub search_engines_used: Vec<String>,  // 사용된 검색 엔진
    pub memo_id: Option<i64>,              // 자동 저장된 메모 ID
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResearchProgress {
    pub step: usize,
    pub total_steps: usize,
    pub task_type: String,
    pub description: String,
    pub status: String,  // "pending", "in_progress", "completed", "failed"
    pub tasks: Vec<ResearchTaskInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResearchTaskInfo {
    pub id: usize,
    pub task_type: String,
    pub description: String,
    pub status: String,
}

// 에이전트 기반 리서치 실행 (내부 투두리스트 + 여러 번 AI 호출)
#[tauri::command]
async fn run_research(app_handle: tauri::AppHandle, query: String) -> Result<ResearchResult, String> {
    // API 키 가져오기
    let gemini_api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if gemini_api_key.is_empty() {
        return Err("Gemini API 키를 먼저 설정해주세요".to_string());
    }

    // 리서치는 항상 Gemini 3.0 Pro 사용 (최고 품질, 논문 수준)
    let model = "gemini-3-pro-preview";

    // 검색 API 키
    let naver_client_id = db::get_setting("naver_client_id").unwrap_or_default();
    let naver_client_secret = db::get_setting("naver_client_secret").unwrap_or_default();
    let google_search_api_key = db::get_setting("google_search_api_key").unwrap_or_default();
    let google_search_cx = db::get_setting("google_search_cx").unwrap_or_default();

    let has_naver = !naver_client_id.is_empty() && !naver_client_secret.is_empty();
    let has_google = !google_search_api_key.is_empty() && !google_search_cx.is_empty();

    if !has_naver && !has_google {
        return Err("검색 API 키를 설정해주세요 (설정 > 검색 API)".to_string());
    }

    // 사용된 검색 엔진 추적
    let mut search_engines_used: Vec<String> = Vec::new();
    if has_naver { search_engines_used.push("네이버".to_string()); }
    if has_google { search_engines_used.push("구글".to_string()); }

    // 토큰 사용량 추적
    let mut total_input_tokens: i64 = 0;
    let mut total_output_tokens: i64 = 0;
    let mut total_cost: f64 = 0.0;

    // 내부 투두리스트 초기화 (7단계)
    let mut tasks: Vec<ResearchTaskInfo> = vec![
        ResearchTaskInfo { id: 1, task_type: "plan".to_string(), description: "검색 쿼리 계획 수립".to_string(), status: "pending".to_string() },
        ResearchTaskInfo { id: 2, task_type: "search".to_string(), description: "검색 엔진 쿼리 실행".to_string(), status: "pending".to_string() },
        ResearchTaskInfo { id: 3, task_type: "select".to_string(), description: "크롤링할 페이지 선택".to_string(), status: "pending".to_string() },
        ResearchTaskInfo { id: 4, task_type: "crawl".to_string(), description: "선택된 페이지 크롤링".to_string(), status: "pending".to_string() },
        ResearchTaskInfo { id: 5, task_type: "analyze".to_string(), description: "각 페이지에서 정보 추출".to_string(), status: "pending".to_string() },
        ResearchTaskInfo { id: 6, task_type: "summarize".to_string(), description: "출처별 개별 요약 생성".to_string(), status: "pending".to_string() },
        ResearchTaskInfo { id: 7, task_type: "compile".to_string(), description: "최종 리포트 작성".to_string(), status: "pending".to_string() },
    ];

    // 진행 상황 이벤트 발송 헬퍼
    let emit_progress = |app: &tauri::AppHandle, step: usize, tasks: &[ResearchTaskInfo], current_task: &str, status: &str| {
        let progress = ResearchProgress {
            step,
            total_steps: 7,
            task_type: current_task.to_string(),
            description: tasks.get(step.saturating_sub(1)).map(|t| t.description.clone()).unwrap_or_default(),
            status: status.to_string(),
            tasks: tasks.to_vec(),
        };
        app.emit("research-progress", &progress).ok();
    };

    // === 1단계: AI가 검색 쿼리 계획 수립 ===
    tasks[0].status = "in_progress".to_string();
    tasks[0].description = "AI가 검색 쿼리 계획 수립 중...".to_string();
    emit_progress(&app_handle, 1, &tasks, "plan", "in_progress");

    let (search_queries, input, output, cost) = ai::plan_research(&gemini_api_key, &model, &query).await?;
    total_input_tokens += input;
    total_output_tokens += output;
    total_cost += cost;

    // 생성된 쿼리 목록을 상세히 표시
    let queries_preview: String = search_queries.iter().take(3).map(|q| format!("\"{}\"", q)).collect::<Vec<_>>().join(", ");
    tasks[0].status = "completed".to_string();
    tasks[0].description = format!("검색 쿼리 {} 개 생성: {}", search_queries.len(), queries_preview);
    emit_progress(&app_handle, 1, &tasks, "plan", "completed");

    // === 2단계: 검색 실행 ===
    let engines_text = search_engines_used.join(" + ");
    tasks[1].status = "in_progress".to_string();
    tasks[1].description = format!("{} 검색 시작...", engines_text);
    emit_progress(&app_handle, 2, &tasks, "search", "in_progress");

    let mut all_search_results: Vec<ai::SearchItem> = Vec::new();
    let mut naver_count = 0;
    let mut google_count = 0;

    let mut google_errors: Vec<String> = Vec::new();
    let mut naver_errors: Vec<String> = Vec::new();

    for (idx, search_query) in search_queries.iter().enumerate() {
        // 현재 검색 중인 쿼리 표시
        tasks[1].description = format!("검색 중 ({}/{}): \"{}\"", idx + 1, search_queries.len(), search_query);
        emit_progress(&app_handle, 2, &tasks, "search", "in_progress");

        // Google 검색 우선 (쿼리당 10개 - API 제한이지만 가장 중요)
        if has_google {
            tasks[1].description = format!("구글 검색 중 ({}/{}): \"{}\"", idx + 1, search_queries.len(), search_query);
            emit_progress(&app_handle, 2, &tasks, "search", "in_progress");

            match ai::search_google(&google_search_api_key, &google_search_cx, search_query, 10).await {
                Ok(results) => {
                    google_count += results.len();
                    all_search_results.extend(results);
                }
                Err(e) => {
                    google_errors.push(format!("쿼리 '{}': {}", search_query, e));
                }
            }
        }

        // 네이버 검색 (뉴스 위주 - 쿼리당 30개: 뉴스20 + 블로그5 + 웹5)
        if has_naver {
            tasks[1].description = format!("네이버 검색 중 ({}/{}): \"{}\"", idx + 1, search_queries.len(), search_query);
            emit_progress(&app_handle, 2, &tasks, "search", "in_progress");

            match ai::search_naver(&naver_client_id, &naver_client_secret, search_query, 15).await {
                Ok(results) => {
                    naver_count += results.len();
                    all_search_results.extend(results);
                }
                Err(e) => {
                    naver_errors.push(format!("쿼리 '{}': {}", search_query, e));
                }
            }
        }
    }

    // 검색 오류 로그 (있으면 표시)
    if !google_errors.is_empty() {
        tasks[1].description = format!("구글 검색 오류: {}", google_errors.join("; "));
        emit_progress(&app_handle, 2, &tasks, "search", "in_progress");
    }
    if !naver_errors.is_empty() {
        tasks[1].description = format!("네이버 검색 오류: {}", naver_errors.join("; "));
        emit_progress(&app_handle, 2, &tasks, "search", "in_progress");
    }

    // 중복 제거 (URL 기준)
    let mut seen_urls = std::collections::HashSet::new();
    all_search_results.retain(|item| seen_urls.insert(item.link.clone()));

    // 검색 결과 상세 표시
    let mut result_parts: Vec<String> = Vec::new();
    if naver_count > 0 { result_parts.push(format!("네이버 {}개", naver_count)); }
    if google_count > 0 { result_parts.push(format!("구글 {}개", google_count)); }

    tasks[1].status = "completed".to_string();
    tasks[1].description = format!("{} 수집 완료 (중복 제거 후 총 {}개)", result_parts.join(" + "), all_search_results.len());
    emit_progress(&app_handle, 2, &tasks, "search", "completed");

    if all_search_results.is_empty() {
        return Err("검색 결과가 없습니다".to_string());
    }

    // === 3단계: AI가 크롤링할 페이지 선택 ===
    tasks[2].status = "in_progress".to_string();
    tasks[2].description = format!("AI가 {}개 결과 중 크롤링할 페이지 선택 중...", all_search_results.len());
    emit_progress(&app_handle, 3, &tasks, "select", "in_progress");

    let (selected_urls, input, output, cost) = ai::select_pages_to_crawl(&gemini_api_key, &model, &query, &all_search_results).await?;
    total_input_tokens += input;
    total_output_tokens += output;
    total_cost += cost;

    tasks[2].status = "completed".to_string();
    tasks[2].description = format!("{}개 페이지 선택 완료 (분석 대상)", selected_urls.len());
    emit_progress(&app_handle, 3, &tasks, "select", "completed");

    // === 4단계: 선택된 페이지 크롤링 ===
    tasks[3].status = "in_progress".to_string();
    tasks[3].description = format!("{}개 페이지 크롤링 시작...", selected_urls.len());
    emit_progress(&app_handle, 4, &tasks, "crawl", "in_progress");

    let mut crawled_contents: Vec<(String, String)> = Vec::new();
    for (idx, url) in selected_urls.iter().enumerate() {
        // 현재 크롤링 중인 URL 표시 (도메인만 추출해서 표시)
        let domain = url.split('/').take(3).collect::<Vec<_>>().join("/");
        tasks[3].description = format!("크롤링 중 ({}/{}): {}", idx + 1, selected_urls.len(), domain);
        emit_progress(&app_handle, 4, &tasks, "crawl", "in_progress");

        if let Ok(content) = ai::fetch_page_content(url).await {
            if !content.is_empty() {
                crawled_contents.push((url.clone(), content));
            }
        }
    }

    tasks[3].status = "completed".to_string();
    tasks[3].description = format!("{}개 페이지 크롤링 성공 ({}개 실패)", crawled_contents.len(), selected_urls.len() - crawled_contents.len());
    emit_progress(&app_handle, 4, &tasks, "crawl", "completed");

    // === 5단계: AI가 각 페이지에서 정보 추출 ===
    tasks[4].status = "in_progress".to_string();
    tasks[4].description = format!("{}개 페이지에서 정보 추출 시작...", crawled_contents.len());
    emit_progress(&app_handle, 5, &tasks, "analyze", "in_progress");

    let mut all_insights: Vec<String> = Vec::new();
    for (idx, (url, content)) in crawled_contents.iter().enumerate() {
        // 현재 분석 중인 페이지 표시
        let domain = url.split('/').take(3).collect::<Vec<_>>().join("/");
        tasks[4].description = format!("분석 중 ({}/{}): {} [인사이트 {}개]", idx + 1, crawled_contents.len(), domain, all_insights.len());
        emit_progress(&app_handle, 5, &tasks, "analyze", "in_progress");

        if let Ok((insights, input, output, cost)) = ai::extract_insights(&gemini_api_key, &model, &query, url, content).await {
            total_input_tokens += input;
            total_output_tokens += output;
            total_cost += cost;
            all_insights.extend(insights);
        }
    }

    tasks[4].status = "completed".to_string();
    tasks[4].description = format!("{}개 페이지에서 총 {}개 인사이트 추출 완료", crawled_contents.len(), all_insights.len());
    emit_progress(&app_handle, 5, &tasks, "analyze", "completed");

    // 사용된 출처 목록 생성
    let used_sources: Vec<ai::SearchItem> = all_search_results
        .iter()
        .filter(|item| selected_urls.contains(&item.link))
        .cloned()
        .collect();

    // === 6단계: 출처별 개별 요약 생성 (별첨) ===
    tasks[5].status = "in_progress".to_string();
    tasks[5].description = format!("{}개 출처 개별 요약 시작...", crawled_contents.len());
    emit_progress(&app_handle, 6, &tasks, "summarize", "in_progress");

    let mut source_summaries: Vec<SourceSummary> = Vec::new();
    let mut summarized_count = 0;
    for (url, content) in &crawled_contents {
        // 해당 URL의 출처 정보 찾기
        if let Some(source_info) = used_sources.iter().find(|s| &s.link == url) {
            // 현재 요약 중인 출처 표시
            let short_title: String = source_info.title.chars().take(30).collect();
            tasks[5].description = format!("요약 중 ({}/{}): \"{}...\"", summarized_count + 1, crawled_contents.len(), short_title);
            emit_progress(&app_handle, 6, &tasks, "summarize", "in_progress");

            if let Ok((summary_text, input, output, cost)) = ai::summarize_source(
                &gemini_api_key, &model, &query, &source_info.title, url, content
            ).await {
                total_input_tokens += input;
                total_output_tokens += output;
                total_cost += cost;

                source_summaries.push(SourceSummary {
                    title: source_info.title.clone(),
                    url: url.clone(),
                    source: source_info.source.clone(),
                    summary: summary_text,
                });
                summarized_count += 1;
            }
        }
    }

    tasks[5].status = "completed".to_string();
    tasks[5].description = format!("{}개 출처 개별 요약 완료 (별첨 생성)", source_summaries.len());
    emit_progress(&app_handle, 6, &tasks, "summarize", "completed");

    // === 7단계: 최종 리포트 작성 ===
    tasks[6].status = "in_progress".to_string();
    tasks[6].description = format!("{}개 인사이트를 바탕으로 최종 리포트 작성 중...", all_insights.len());
    emit_progress(&app_handle, 7, &tasks, "compile", "in_progress");

    let (summary, full_report, key_points, input, output, cost) =
        ai::compile_final_report(&gemini_api_key, &model, &query, &all_insights, &used_sources).await?;
    total_input_tokens += input;
    total_output_tokens += output;
    total_cost += cost;

    tasks[6].status = "completed".to_string();
    tasks[6].description = format!("리포트 작성 완료 (핵심 포인트 {}개, 총 {}자)", key_points.len(), full_report.len());
    emit_progress(&app_handle, 7, &tasks, "compile", "completed");

    // 사용량 기록
    db::log_api_usage(
        "research",
        model,
        total_input_tokens,
        total_output_tokens,
        total_cost,
    ).map_err(|e| e.to_string())?;

    // 리서치 결과를 메모로 자동 저장
    let sources_text = used_sources
        .iter()
        .take(30)
        .map(|s| format!("- {} ({})\n  {}", s.title, s.source, s.link))
        .collect::<Vec<_>>()
        .join("\n");

    // 별첨 (출처별 요약)
    let appendix_text = source_summaries
        .iter()
        .enumerate()
        .map(|(i, ss)| format!("\n[{}] {}\n출처: {} ({})\n{}", i+1, ss.title, ss.source, ss.url, ss.summary))
        .collect::<Vec<_>>()
        .join("\n");

    let memo_content = format!(
        "{}\n\n핵심 포인트:\n{}\n\n상세 리포트:\n{}\n\n출처 ({}):\n{}\n\n=== 별첨: 출처별 상세 요약 ===\n{}\n\n---\n검색 엔진: {} | 토큰: {} | 비용: ${:.4}",
        summary,
        key_points.iter().enumerate().map(|(i, p)| format!("{}. {}", i+1, p)).collect::<Vec<_>>().join("\n"),
        full_report,
        used_sources.len(),
        sources_text,
        appendix_text,
        search_engines_used.join(", "),
        total_input_tokens + total_output_tokens,
        total_cost
    );

    let research_memo = Memo {
        id: 0,
        title: format!("[AI 리서치] {}", query),
        content: memo_content.clone(),
        formatted_content: memo_content,
        summary: summary.clone(),
        category: "리서치".to_string(),
        tags: "AI,리서치,자동생성".to_string(),
        embedding: None,
        created_at: String::new(),
        updated_at: String::new(),
    };

    let memo_id = db::save_memo(&research_memo).ok();

    Ok(ResearchResult {
        query,
        summary,
        key_points,
        sources: used_sources,
        source_summaries,
        full_report,
        input_tokens: total_input_tokens,
        output_tokens: total_output_tokens,
        cost_usd: total_cost,
        search_engines_used,
        memo_id,
    })
}

// ===== 데이터셋(엑셀) 기능 =====

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportExcelResult {
    pub success: bool,
    pub dataset_id: i64,
    pub name: String,
    pub columns: Vec<String>,
    pub row_count: i64,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DatasetAnalysis {
    pub summary: String,
    pub insights: Vec<String>,
    pub statistics: Vec<StatItem>,
    pub chart_data: Option<ChartData>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatItem {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChartData {
    pub chart_type: String,  // "bar", "line", "pie"
    pub title: String,
    pub labels: Vec<String>,
    pub values: Vec<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DatasetQAResult {
    pub answer: String,
    pub relevant_rows: Vec<Vec<String>>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

// 엑셀 파일 임포트 (Base64 데이터로 받음)
#[tauri::command]
async fn import_excel(file_data: String, file_name: String) -> Result<ImportExcelResult, String> {
    // Base64 디코딩
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &file_data
    ).map_err(|e| format!("Base64 디코딩 실패: {}", e))?;

    // 엑셀 파일 파싱
    let cursor = Cursor::new(bytes);
    let mut workbook: Xlsx<_> = Xlsx::new(cursor)
        .map_err(|e| format!("엑셀 파일 읽기 실패: {}", e))?;

    // 모든 시트 읽기
    let sheet_names = workbook.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err("엑셀 파일에 시트가 없습니다".to_string());
    }

    let mut all_rows_data: Vec<Vec<String>> = Vec::new();
    let mut columns: Vec<String> = Vec::new();
    let mut first_sheet = true;

    // 모든 시트를 순회하며 데이터 합치기
    for sheet_name in &sheet_names {
        let range = match workbook.worksheet_range(sheet_name) {
            Ok(r) => r,
            Err(_) => continue,
        };

        for (row_idx, row) in range.rows().enumerate() {
            let row_values: Vec<String> = row
                .iter()
                .map(|cell| {
                    match cell {
                        calamine::Data::Empty => String::new(),
                        calamine::Data::String(s) => s.clone(),
                        calamine::Data::Float(f) => {
                            if f.fract() == 0.0 {
                                format!("{}", *f as i64)
                            } else {
                                format!("{}", f)
                            }
                        },
                        calamine::Data::Int(i) => format!("{}", i),
                        calamine::Data::Bool(b) => format!("{}", b),
                        calamine::Data::DateTime(dt) => format!("{}", dt),
                        calamine::Data::Error(e) => format!("Error: {:?}", e),
                        _ => String::new(),
                    }
                })
                .collect();

            if row_idx == 0 && first_sheet {
                // 첫 번째 시트의 첫 번째 행은 컬럼명
                columns = row_values.iter()
                    .enumerate()
                    .map(|(i, v)| if v.is_empty() { format!("Column{}", i + 1) } else { v.clone() })
                    .collect();
            } else if row_idx > 0 || !first_sheet {
                // 데이터 행 추가 (다른 시트의 헤더는 스킵)
                if row_idx > 0 {
                    all_rows_data.push(row_values);
                }
            }
        }
        first_sheet = false;
    }

    let rows_data = all_rows_data;

    if columns.is_empty() {
        return Err("컬럼 정보를 찾을 수 없습니다".to_string());
    }

    // 데이터셋 이름 (파일명에서 확장자 제거)
    let dataset_name = file_name
        .rsplit('.')
        .skip(1)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(".");

    let dataset_name = if dataset_name.is_empty() { file_name.clone() } else { dataset_name };

    // DB에 저장
    let dataset_id = db::save_dataset(&dataset_name, "", &columns)
        .map_err(|e| format!("데이터셋 저장 실패: {}", e))?;

    let row_count = db::save_dataset_rows(dataset_id, &rows_data)
        .map_err(|e| format!("데이터 저장 실패: {}", e))?;

    Ok(ImportExcelResult {
        success: true,
        dataset_id,
        name: dataset_name,
        columns,
        row_count,
        message: format!("{}개 행 임포트 완료", row_count),
    })
}

// 데이터셋 목록 조회
#[tauri::command]
fn get_datasets() -> Result<Vec<Dataset>, String> {
    db::get_all_datasets().map_err(|e| e.to_string())
}

// 데이터셋 상세 조회
#[tauri::command]
fn get_dataset_detail(id: i64) -> Result<Dataset, String> {
    db::get_dataset(id).map_err(|e| e.to_string())
}

// 데이터셋 행 조회 (페이징)
#[tauri::command]
fn get_dataset_rows(dataset_id: i64, offset: i64, limit: i64) -> Result<Vec<DatasetRow>, String> {
    db::get_dataset_rows(dataset_id, offset, limit).map_err(|e| e.to_string())
}

// 데이터셋 검색
#[tauri::command]
fn search_dataset(dataset_id: i64, query: String) -> Result<Vec<DatasetRow>, String> {
    db::search_dataset_rows(dataset_id, &query).map_err(|e| e.to_string())
}

// 데이터셋 삭제
#[tauri::command]
fn delete_dataset(id: i64) -> Result<(), String> {
    db::delete_dataset(id).map_err(|e| e.to_string())
}

// AI 데이터셋 분석
#[tauri::command]
async fn analyze_dataset(id: i64) -> Result<DatasetAnalysis, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    let model = db::get_setting("gemini_model").unwrap_or_default();
    let dataset = db::get_dataset(id).map_err(|e| e.to_string())?;
    let rows = db::get_all_dataset_rows(id).map_err(|e| e.to_string())?;

    // 최대 500행만 분석 (토큰 제한)
    let sample_rows: Vec<Vec<String>> = rows.iter().take(500).map(|r| r.data.clone()).collect();

    let (analysis, input_tokens, output_tokens, cost) =
        ai::analyze_dataset_data(&api_key, &model, &dataset.name, &dataset.columns, &sample_rows).await?;

    // 사용량 기록
    let model_name = if model.is_empty() { "gemini-2.0-flash" } else { &model };
    db::log_api_usage("dataset_analyze", model_name, input_tokens, output_tokens, cost)
        .map_err(|e| e.to_string())?;

    Ok(DatasetAnalysis {
        summary: analysis.summary,
        insights: analysis.insights,
        statistics: analysis.statistics.into_iter().map(|(k, v)| StatItem { label: k, value: v }).collect(),
        chart_data: analysis.chart_data.map(|c| ChartData {
            chart_type: c.chart_type,
            title: c.title,
            labels: c.labels,
            values: c.values,
        }),
        input_tokens,
        output_tokens,
        cost_usd: cost,
    })
}

// AI 데이터셋 질문 답변
#[tauri::command]
async fn query_dataset(id: i64, question: String) -> Result<DatasetQAResult, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    let model = db::get_setting("gemini_model").unwrap_or_default();
    let dataset = db::get_dataset(id).map_err(|e| e.to_string())?;
    let rows = db::get_all_dataset_rows(id).map_err(|e| e.to_string())?;

    // 최대 500행만 분석
    let sample_rows: Vec<Vec<String>> = rows.iter().take(500).map(|r| r.data.clone()).collect();

    let (answer, relevant_indices, input_tokens, output_tokens, cost) =
        ai::query_dataset_data(&api_key, &model, &dataset.name, &dataset.columns, &sample_rows, &question).await?;

    // 사용량 기록
    let model_name = if model.is_empty() { "gemini-2.0-flash" } else { &model };
    db::log_api_usage("dataset_query", model_name, input_tokens, output_tokens, cost)
        .map_err(|e| e.to_string())?;

    // 관련 행 추출
    let relevant_rows: Vec<Vec<String>> = relevant_indices
        .iter()
        .filter_map(|&idx| sample_rows.get(idx).cloned())
        .collect();

    Ok(DatasetQAResult {
        answer,
        relevant_rows,
        input_tokens,
        output_tokens,
        cost_usd: cost,
    })
}

// ===== API 키 테스트 커맨드들 =====

#[tauri::command]
async fn test_gemini_key(api_key: String) -> Result<String, String> {
    ai::test_gemini_api(&api_key).await
}

#[tauri::command]
async fn test_naver_key(client_id: String, client_secret: String) -> Result<String, String> {
    ai::test_naver_api(&client_id, &client_secret).await
}

#[tauri::command]
async fn test_google_key(api_key: String, cx: String) -> Result<String, String> {
    ai::test_google_api(&api_key, &cx).await
}

// ===== AI 데이터 추출 =====

#[derive(serde::Serialize)]
struct ExtractResponse {
    url: String,
    data: serde_json::Value,
    input_tokens: i64,
    output_tokens: i64,
    cost_usd: f64,
}

#[tauri::command]
async fn extract_from_url(url: String, schema: String) -> Result<ExtractResponse, String> {
    let gemini_api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if gemini_api_key.is_empty() {
        return Err("Gemini API 키를 먼저 설정해주세요".to_string());
    }

    let model = db::get_setting("gemini_model").unwrap_or_default();

    let result = ai::extract_data_from_url(&gemini_api_key, &model, &url, &schema).await?;

    // 토큰 사용량 기록
    let _ = db::log_api_usage("extract", &model, result.input_tokens, result.output_tokens, result.cost_usd);

    Ok(ExtractResponse {
        url: result.url,
        data: result.data,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        cost_usd: result.cost_usd,
    })
}

#[tauri::command]
async fn extract_from_urls(urls: Vec<String>, schema: String) -> Result<Vec<ExtractResponse>, String> {
    let gemini_api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if gemini_api_key.is_empty() {
        return Err("Gemini API 키를 먼저 설정해주세요".to_string());
    }

    let model = db::get_setting("gemini_model").unwrap_or_default();

    let results = ai::extract_data_batch(&gemini_api_key, &model, &urls, &schema).await?;

    let mut total_input = 0i64;
    let mut total_output = 0i64;
    let mut total_cost = 0.0f64;

    let responses: Vec<ExtractResponse> = results
        .into_iter()
        .map(|r| {
            total_input += r.input_tokens;
            total_output += r.output_tokens;
            total_cost += r.cost_usd;
            ExtractResponse {
                url: r.url,
                data: r.data,
                input_tokens: r.input_tokens,
                output_tokens: r.output_tokens,
                cost_usd: r.cost_usd,
            }
        })
        .collect();

    // 총 토큰 사용량 기록
    let _ = db::log_api_usage("extract_batch", &model, total_input, total_output, total_cost);

    Ok(responses)
}

// ===== Google Slides API =====

#[derive(Debug, Serialize, Deserialize)]
pub struct GoogleSlidesResult {
    pub presentation_id: String,
    pub presentation_url: String,
    pub slide_count: usize,
}

#[tauri::command]
fn get_google_auth_url(client_id: String) -> String {
    ai::get_google_auth_url(&client_id)
}

#[tauri::command]
async fn exchange_google_code(client_id: String, client_secret: String, code: String) -> Result<(), String> {
    let tokens = ai::exchange_google_code(&client_id, &client_secret, &code).await?;
    ai::set_google_tokens(tokens).await;
    Ok(())
}

#[tauri::command]
async fn create_google_slides(title: String, slides: Vec<ai::SlideContent>) -> Result<GoogleSlidesResult, String> {
    // 저장된 토큰 가져오기
    let tokens = ai::get_google_tokens().await
        .ok_or("Google 로그인이 필요합니다")?;

    // 토큰 만료 확인 및 갱신
    let access_token = if tokens.expires_at < chrono::Utc::now().timestamp() {
        if let Some(refresh_token) = &tokens.refresh_token {
            let client_id = db::get_setting("google_slides_client_id").map_err(|e| e.to_string())?;
            let client_secret = db::get_setting("google_slides_client_secret").map_err(|e| e.to_string())?;
            let new_tokens = ai::refresh_google_token(&client_id, &client_secret, refresh_token).await?;
            let access_token = new_tokens.access_token.clone();
            ai::set_google_tokens(new_tokens).await;
            access_token
        } else {
            return Err("Google 재로그인이 필요합니다".to_string());
        }
    } else {
        tokens.access_token.clone()
    };

    let slide_count = slides.len();
    let (presentation_id, presentation_url) = ai::create_slides_from_research(&access_token, &title, &slides).await?;

    Ok(GoogleSlidesResult {
        presentation_id,
        presentation_url,
        slide_count,
    })
}

#[tauri::command]
async fn check_google_auth() -> Result<bool, String> {
    let tokens = ai::get_google_tokens().await;
    Ok(tokens.is_some())
}

// ===== 데이터 수집 =====

/// 리서치처럼 검색 후 웹을 돌아다니며 데이터 수집
#[tauri::command]
async fn run_data_collection(app_handle: tauri::AppHandle, query: String) -> Result<Vec<ai::CollectedData>, String> {
    // 검색 API 키 가져오기
    let naver_client_id = db::get_setting("naver_client_id").unwrap_or_default();
    let naver_client_secret = db::get_setting("naver_client_secret").unwrap_or_default();
    let google_search_api_key = db::get_setting("google_search_api_key").unwrap_or_default();
    let google_search_cx = db::get_setting("google_search_cx").unwrap_or_default();

    let has_naver = !naver_client_id.is_empty() && !naver_client_secret.is_empty();
    let has_google = !google_search_api_key.is_empty() && !google_search_cx.is_empty();

    if !has_naver && !has_google {
        return Err("검색 API 키를 설정해주세요 (설정 > 검색 API)".to_string());
    }

    let _ = app_handle.emit("data-collection-progress", serde_json::json!({
        "step": 1, "total": 100, "message": "검색 중..."
    }));

    // 검색 실행
    let mut all_urls: Vec<String> = Vec::new();

    // Google 검색
    if has_google {
        let _ = app_handle.emit("data-collection-progress", serde_json::json!({
            "step": 10, "total": 100, "message": "Google 검색 중..."
        }));
        if let Ok(results) = ai::search_google(&google_search_api_key, &google_search_cx, &query, 15).await {
            for item in results {
                if !all_urls.contains(&item.link) {
                    all_urls.push(item.link);
                }
            }
        }
    }

    // 네이버 검색
    if has_naver {
        let _ = app_handle.emit("data-collection-progress", serde_json::json!({
            "step": 20, "total": 100, "message": "네이버 검색 중..."
        }));
        if let Ok(results) = ai::search_naver(&naver_client_id, &naver_client_secret, &query, 15).await {
            for item in results {
                if !all_urls.contains(&item.link) {
                    all_urls.push(item.link);
                }
            }
        }
    }

    if all_urls.is_empty() {
        return Err("검색 결과가 없습니다".to_string());
    }

    let _ = app_handle.emit("data-collection-progress", serde_json::json!({
        "step": 30, "total": 100, "message": format!("{}개 페이지 발견, 데이터 수집 시작...", all_urls.len())
    }));

    // 각 URL에서 데이터 수집
    let mut results: Vec<ai::CollectedData> = Vec::new();
    let total_urls = all_urls.len();

    for (idx, url) in all_urls.iter().enumerate() {
        let progress = 30 + ((idx as f32 / total_urls as f32) * 70.0) as i32;
        let domain = url.split('/').take(3).collect::<Vec<_>>().join("/");

        let _ = app_handle.emit("data-collection-progress", serde_json::json!({
            "step": progress,
            "total": 100,
            "message": format!("데이터 수집 중 ({}/{})... {}", idx + 1, total_urls, domain)
        }));

        match ai::collect_web_data(url).await {
            Ok(data) => {
                // 데이터가 있는 페이지만 추가
                if !data.tables.is_empty() || !data.numbers.is_empty() || !data.lists.is_empty() {
                    results.push(data);
                }
            }
            Err(_) => {} // 실패한 URL은 무시
        }
    }

    let _ = app_handle.emit("data-collection-progress", serde_json::json!({
        "step": 100, "total": 100, "message": format!("완료! {}개 페이지에서 데이터 수집", results.len())
    }));

    Ok(results)
}

#[tauri::command]
async fn collect_web_data(app_handle: tauri::AppHandle, urls: Vec<String>) -> Result<Vec<ai::CollectedData>, String> {
    let mut results: Vec<ai::CollectedData> = Vec::new();

    for (idx, url) in urls.iter().enumerate() {
        // 진행 상황 이벤트
        let _ = app_handle.emit("collection-progress", serde_json::json!({
            "step": idx + 1,
            "total": urls.len(),
            "message": format!("수집 중: {}", url),
            "url": url
        }));

        match ai::collect_web_data(url).await {
            Ok(data) => results.push(data),
            Err(e) => {
                let _ = app_handle.emit("collection-progress", serde_json::json!({
                    "step": idx + 1,
                    "total": urls.len(),
                    "message": format!("실패: {} - {}", url, e),
                    "url": url
                }));
            }
        }
    }

    Ok(results)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SheetsExportResult {
    pub url: String,
}

#[tauri::command]
async fn export_collected_data_sheets(data: Vec<ai::CollectedData>, title: String) -> Result<SheetsExportResult, String> {
    let tokens = ai::get_google_tokens().await
        .ok_or("Google 로그인이 필요합니다")?;

    let access_token = if tokens.expires_at < chrono::Utc::now().timestamp() {
        if let Some(refresh_token) = &tokens.refresh_token {
            let client_id = db::get_setting("google_slides_client_id").map_err(|e| e.to_string())?;
            let client_secret = db::get_setting("google_slides_client_secret").map_err(|e| e.to_string())?;
            let new_tokens = ai::refresh_google_token(&client_id, &client_secret, refresh_token).await?;
            let access_token = new_tokens.access_token.clone();
            ai::set_google_tokens(new_tokens).await;
            access_token
        } else {
            return Err("Google 재로그인이 필요합니다".to_string());
        }
    } else {
        tokens.access_token.clone()
    };

    let url = ai::export_to_google_sheets(&access_token, &title, &data).await?;
    Ok(SheetsExportResult { url })
}

#[tauri::command]
async fn export_collected_data_excel(app_handle: tauri::AppHandle, data: Vec<ai::CollectedData>) -> Result<String, String> {
    use std::io::Write;

    // 저장 경로 설정
    let downloads_dir = dirs::download_dir()
        .ok_or("다운로드 폴더를 찾을 수 없습니다")?;

    let filename = format!("data_collection_{}.csv", chrono::Local::now().format("%Y%m%d_%H%M%S"));
    let filepath = downloads_dir.join(&filename);

    // CSV 파일 생성
    let mut file = std::fs::File::create(&filepath)
        .map_err(|e| format!("파일 생성 실패: {}", e))?;

    // BOM for Excel UTF-8
    file.write_all(&[0xEF, 0xBB, 0xBF])
        .map_err(|e| format!("BOM 쓰기 실패: {}", e))?;

    for collected in &data {
        // 출처 헤더
        writeln!(file, "\"=== {} ===\"", collected.title.replace("\"", "\"\""))
            .map_err(|e| format!("쓰기 실패: {}", e))?;
        writeln!(file, "\"{}\"", collected.url)
            .map_err(|e| format!("쓰기 실패: {}", e))?;
        writeln!(file, "").map_err(|e| format!("쓰기 실패: {}", e))?;

        // 테이블 데이터
        for table in &collected.tables {
            if !table.headers.is_empty() {
                let headers: Vec<String> = table.headers.iter()
                    .map(|h| format!("\"{}\"", h.replace("\"", "\"\"")))
                    .collect();
                writeln!(file, "{}", headers.join(","))
                    .map_err(|e| format!("쓰기 실패: {}", e))?;
            }
            for row in &table.rows {
                let cells: Vec<String> = row.iter()
                    .map(|c| format!("\"{}\"", c.replace("\"", "\"\"")))
                    .collect();
                writeln!(file, "{}", cells.join(","))
                    .map_err(|e| format!("쓰기 실패: {}", e))?;
            }
            writeln!(file, "").map_err(|e| format!("쓰기 실패: {}", e))?;
        }

        // 숫자 데이터
        if !collected.numbers.is_empty() {
            writeln!(file, "\"항목\",\"값\",\"단위\"")
                .map_err(|e| format!("쓰기 실패: {}", e))?;
            for num in &collected.numbers {
                writeln!(file, "\"{}\",\"{}\",\"{}\"",
                    num.label.replace("\"", "\"\""),
                    num.value,
                    num.unit.as_deref().unwrap_or("")
                ).map_err(|e| format!("쓰기 실패: {}", e))?;
            }
            writeln!(file, "").map_err(|e| format!("쓰기 실패: {}", e))?;
        }
    }

    Ok(filepath.to_string_lossy().to_string())
}

// ===== AI 브라우저 에이전트 =====

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentStepResponse {
    pub step_number: usize,
    pub action_type: String,
    pub selector: Option<String>,
    pub value: Option<String>,
    pub reason: String,
    pub result: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentResponse {
    pub goal: String,
    pub success: bool,
    pub steps: Vec<AgentStepResponse>,
    pub final_data: Option<serde_json::Value>,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
}

#[tauri::command]
async fn run_browser_agent(window: tauri::Window, goal: String, start_url: String, max_steps: Option<usize>) -> Result<AgentResponse, String> {
    let gemini_api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if gemini_api_key.is_empty() {
        return Err("Gemini API 키를 먼저 설정해주세요".to_string());
    }

    let model = db::get_setting("gemini_model").unwrap_or_default();
    let max_steps = max_steps.unwrap_or(10);

    // 진행 상황 콜백 - 각 단계마다 이벤트 발생
    let window_clone = window.clone();
    let on_progress = move |step: &ai::AgentStep| {
        let step_data = serde_json::json!({
            "step_number": step.step_number,
            "action_type": format!("{:?}", step.action.action_type),
            "selector": step.action.selector,
            "value": step.action.value,
            "reason": step.action.reason,
            "result": step.result,
        });
        let _ = window_clone.emit("agent-progress", step_data);
    };

    let result = ai::run_agent(&gemini_api_key, &model, &goal, &start_url, max_steps, on_progress).await?;

    // 토큰 사용량 기록
    let _ = db::log_api_usage(
        "agent",
        &model,
        result.total_input_tokens,
        result.total_output_tokens,
        result.total_cost_usd,
    );

    // 응답 변환
    let steps: Vec<AgentStepResponse> = result
        .steps
        .into_iter()
        .map(|s| AgentStepResponse {
            step_number: s.step_number,
            action_type: format!("{:?}", s.action.action_type),
            selector: s.action.selector,
            value: s.action.value,
            reason: s.action.reason,
            result: s.result,
        })
        .collect();

    Ok(AgentResponse {
        goal: result.goal,
        success: result.success,
        steps,
        final_data: result.final_data,
        total_input_tokens: result.total_input_tokens,
        total_output_tokens: result.total_output_tokens,
        total_cost_usd: result.total_cost_usd,
    })
}

// ===== 파일 컨설팅 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TreeNode {
    name: String,
    path: String,
    is_folder: bool,
    children: Vec<TreeNode>,
    file_count: u64,
    size: u64,
    status: String, // "scanning", "complete"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScanProgress {
    message: String,
    current_file: Option<String>,
    file_count: u64,
    folder_count: u64,
    total_size: u64,
    recent_files: Vec<String>,
    phase: String,  // "scanning", "analyzing", "complete"
    folder_tree: Vec<TreeNode>, // 트리 구조
    current_path: Option<String>, // 현재 스캔 중인 폴더 경로
}

#[tauri::command]
fn cancel_scan() -> Result<(), String> {
    SCAN_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn is_scan_cancelled() -> bool {
    SCAN_CANCELLED.load(Ordering::SeqCst)
}

#[tauri::command]
async fn scan_for_consulting(app_handle: tauri::AppHandle, path: String) -> Result<ai::FileConsultingResult, String> {
    use std::sync::{Arc, atomic::{AtomicU64, Ordering as AtomicOrdering}};
    use std::collections::{VecDeque, HashMap};
    use parking_lot::Mutex;

    // 스캔 시작 시 취소 플래그 초기화
    SCAN_CANCELLED.store(false, Ordering::SeqCst);

    let file_count = Arc::new(AtomicU64::new(0));
    let folder_count = Arc::new(AtomicU64::new(0));
    let total_size = Arc::new(AtomicU64::new(0));
    let recent_files = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(10)));

    // 트리 구조 추적 (폴더 경로 -> (name, parent_path, file_count, size, status))
    let folder_info: Arc<Mutex<HashMap<String, (String, Option<String>, u64, u64, String)>>> = Arc::new(Mutex::new(HashMap::new()));
    let root_path_clone = path.clone();

    let file_count_clone = file_count.clone();
    let folder_count_clone = folder_count.clone();
    let total_size_clone = total_size.clone();
    let recent_files_clone = recent_files.clone();
    let folder_info_clone = folder_info.clone();
    let app_handle_clone = app_handle.clone();

    // 루트 폴더 등록
    {
        let root_name = std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        folder_info.lock().insert(path.clone(), (root_name, None, 0, 0, "scanning".to_string()));
    }

    let result = ai::scan_directory_with_details_cancellable(
        &path,
        move |file_path, size, is_folder| {
            let current_path_for_tree = file_path.clone();

            if is_folder {
                folder_count_clone.fetch_add(1, Ordering::Relaxed);

                // 폴더 정보 추가
                let folder_name = std::path::Path::new(&file_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                let parent_path = std::path::Path::new(&file_path)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string());

                folder_info_clone.lock().insert(
                    file_path.clone(),
                    (folder_name, parent_path, 0, 0, "scanning".to_string())
                );
            } else {
                file_count_clone.fetch_add(1, Ordering::Relaxed);
                total_size_clone.fetch_add(size, Ordering::Relaxed);

                // 부모 폴더 통계 업데이트
                if let Some(parent) = std::path::Path::new(&file_path).parent() {
                    let parent_str = parent.to_string_lossy().to_string();
                    let mut info = folder_info_clone.lock();
                    if let Some(entry) = info.get_mut(&parent_str) {
                        entry.2 += 1; // file_count
                        entry.3 += size; // size
                    }
                }

                // 최근 파일 목록 업데이트 (최대 8개)
                let file_name = std::path::Path::new(&file_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                let mut recent = recent_files_clone.lock();
                if recent.len() >= 8 {
                    recent.pop_front();
                }
                recent.push_back(file_name);
            }

            // 50개 파일마다 또는 폴더일 때 progress 이벤트 전송
            let fc = file_count_clone.load(Ordering::Relaxed);
            if fc % 50 == 0 || is_folder {
                let recent_vec: Vec<String> = recent_files_clone.lock().iter().cloned().collect();

                // 트리 구조 생성 (최대 3레벨, 각 레벨 최대 8개 폴더)
                let folder_tree = build_folder_tree(&folder_info_clone.lock(), &root_path_clone, 0, 3);

                let _ = app_handle_clone.emit("consulting-progress", ScanProgress {
                    message: format!("스캔 중... {} 파일, {} 폴더", fc, folder_count_clone.load(Ordering::Relaxed)),
                    current_file: Some(file_path.clone()),
                    file_count: fc,
                    folder_count: folder_count_clone.load(Ordering::Relaxed),
                    total_size: total_size_clone.load(Ordering::Relaxed),
                    recent_files: recent_vec,
                    phase: "scanning".to_string(),
                    folder_tree,
                    current_path: Some(current_path_for_tree),
                });
            }
        },
        || SCAN_CANCELLED.load(Ordering::SeqCst),
    ).await?;

    // 완료된 폴더들 상태 업데이트
    {
        let mut info = folder_info.lock();
        for (_, entry) in info.iter_mut() {
            entry.4 = "complete".to_string();
        }
    }

    let final_tree = build_folder_tree(&folder_info.lock(), &path, 0, 5);

    // 완료 이벤트
    let _ = app_handle.emit("consulting-progress", ScanProgress {
        message: "분석 완료!".to_string(),
        current_file: None,
        file_count: file_count.load(Ordering::Relaxed),
        folder_count: folder_count.load(Ordering::Relaxed),
        total_size: total_size.load(Ordering::Relaxed),
        recent_files: vec![],
        phase: "complete".to_string(),
        folder_tree: final_tree,
        current_path: None,
    });

    Ok(result)
}

// 폴더 트리 빌드 헬퍼 함수
fn build_folder_tree(
    folder_info: &std::collections::HashMap<String, (String, Option<String>, u64, u64, String)>,
    parent_path: &str,
    depth: usize,
    max_depth: usize,
) -> Vec<TreeNode> {
    if depth >= max_depth {
        return vec![];
    }

    let mut children: Vec<TreeNode> = folder_info
        .iter()
        .filter(|(path, (_, parent, _, _, _))| {
            if let Some(p) = parent {
                p == parent_path
            } else {
                false
            }
        })
        .take(8) // 각 레벨 최대 8개
        .map(|(path, (name, _, file_count, size, status))| {
            TreeNode {
                name: name.clone(),
                path: path.clone(),
                is_folder: true,
                children: build_folder_tree(folder_info, path, depth + 1, max_depth),
                file_count: *file_count,
                size: *size,
                status: status.clone(),
            }
        })
        .collect();

    // 크기 순으로 정렬
    children.sort_by(|a, b| b.size.cmp(&a.size));
    children
}

#[tauri::command]
async fn get_ai_file_consulting(result: ai::FileConsultingResult) -> Result<String, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    ai::get_ai_consulting(&api_key, &result).await
}

#[tauri::command]
fn open_file_path(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("파일 열기 실패: {}", e))
}

#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Finder 열기 실패: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Explorer 열기 실패: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new(&path)))
            .spawn()
            .map_err(|e| format!("파일 매니저 열기 실패: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn delete_file_or_folder(path: String, to_trash: bool) -> Result<String, String> {
    use std::path::Path;

    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Err("경로가 존재하지 않습니다".to_string());
    }

    if to_trash {
        // 휴지통으로 이동
        trash::delete(&path).map_err(|e| format!("휴지통으로 이동 실패: {}", e))?;
        Ok(format!("'{}' 휴지통으로 이동 완료", path_obj.file_name().unwrap_or_default().to_string_lossy()))
    } else {
        // 영구 삭제
        if path_obj.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| format!("폴더 삭제 실패: {}", e))?;
        } else {
            std::fs::remove_file(&path).map_err(|e| format!("파일 삭제 실패: {}", e))?;
        }
        Ok(format!("'{}' 영구 삭제 완료", path_obj.file_name().unwrap_or_default().to_string_lossy()))
    }
}

#[tauri::command]
async fn get_folder_rename_suggestions(folder_names: Vec<String>) -> Result<Vec<ai::FolderRenameSuggestion>, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    ai::get_folder_rename_suggestions(&api_key, &folder_names).await
}

#[tauri::command]
fn rename_folder(old_path: String, new_name: String) -> Result<String, String> {
    use std::path::Path;

    let old_path_obj = Path::new(&old_path);
    if !old_path_obj.exists() {
        return Err("폴더가 존재하지 않습니다".to_string());
    }

    if !old_path_obj.is_dir() {
        return Err("선택한 경로가 폴더가 아닙니다".to_string());
    }

    // 새 경로 생성 (같은 부모 폴더 내에서 이름만 변경)
    let parent = old_path_obj.parent().ok_or("부모 폴더를 찾을 수 없습니다")?;
    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err(format!("'{}' 폴더가 이미 존재합니다", new_name));
    }

    // 폴더 이름 변경
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("폴더 이름 변경 실패: {}", e))?;

    Ok(format!("폴더 이름이 '{}'에서 '{}'로 변경되었습니다",
        old_path_obj.file_name().unwrap_or_default().to_string_lossy(),
        new_name
    ))
}

// 포스트잇 저장
#[tauri::command]
async fn save_postit(postit: Postit) -> Result<(), String> {
    db::save_postit(&postit).map_err(|e| e.to_string())
}

// 포스트잇 조회
#[tauri::command]
async fn get_postit(id: String) -> Result<Option<Postit>, String> {
    db::get_postit(&id).map_err(|e| e.to_string())
}

// 전체 포스트잇 조회
#[tauri::command]
async fn get_all_postits() -> Result<Vec<Postit>, String> {
    db::get_all_postits().map_err(|e| e.to_string())
}

// 포스트잇 삭제
#[tauri::command]
async fn delete_postit(id: String) -> Result<(), String> {
    db::delete_postit(&id).map_err(|e| e.to_string())
}

// === 알람 관련 명령 ===

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AlarmData {
    pub id: i64,
    pub time: String,
    pub message: String,
    pub enabled: bool,
    pub days: Vec<i32>,
}

// 알람 저장
#[tauri::command]
async fn save_alarm(time: String, message: String, days: Vec<i32>) -> Result<i64, String> {
    let days_json = serde_json::to_string(&days).unwrap_or_default();
    db::save_alarm(&time, &message, &days_json).map_err(|e| e.to_string())
}

// 전체 알람 조회
#[tauri::command]
async fn get_alarms() -> Result<Vec<AlarmData>, String> {
    let alarms = db::get_all_alarms().map_err(|e| e.to_string())?;
    let result: Vec<AlarmData> = alarms.iter().map(|a| {
        let days: Vec<i32> = serde_json::from_str(&a.days).unwrap_or_default();
        AlarmData {
            id: a.id,
            time: a.time.clone(),
            message: a.message.clone(),
            enabled: a.enabled,
            days,
        }
    }).collect();
    Ok(result)
}

// 알람 토글
#[tauri::command]
async fn toggle_alarm(id: i64) -> Result<(), String> {
    db::toggle_alarm(id).map_err(|e| e.to_string())
}

// 알람 삭제
#[tauri::command]
async fn delete_alarm(id: i64) -> Result<(), String> {
    db::delete_alarm(id).map_err(|e| e.to_string())
}

// 위젯 창 열기
#[tauri::command]
async fn open_widget(app: tauri::AppHandle, widget_type: String, widget_id: Option<String>) -> Result<(), String> {

    let (title, url, width, height, transparent) = match widget_type.as_str() {
        "calendar" => ("Calendar", "calendar.html", 260, 420, true),
        "clock" => ("Clock", "clock.html", 220, 120, true),
        "timer" => ("Timer", "timer.html", 240, 200, true),
        "postit" => {
            // 포스트잇 10장 제한 체크
            let existing_postits = db::get_all_postits().unwrap_or_default();
            if existing_postits.len() >= 10 && widget_id.is_none() {
                return Err("포스트잇은 최대 10장까지만 만들 수 있습니다.".to_string());
            }
            let id = widget_id.unwrap_or_else(|| format!("{}", chrono::Utc::now().timestamp_millis()));
            let url = format!("postit.html?id={}", id);
            return create_widget_window(&app, "Post-it", &url, 200, 180, true, &format!("postit_{}", id)).await;
        },
        "timeblock" => ("Time Block", "timeblock.html", 200, 120, true),
        _ => return Err(format!("알 수 없는 위젯: {}", widget_type)),
    };

    create_widget_window(&app, title, url, width, height, transparent, &widget_type).await
}

async fn create_widget_window(
    app: &tauri::AppHandle,
    title: &str,
    url: &str,
    width: u32,
    height: u32,
    _transparent: bool,
    label: &str,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    // 이미 열려있으면 포커스
    if let Some(window) = app.get_webview_window(label) {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width as f64, height as f64)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
            search_attachments,
            scan_folder,
            analyze_files_for_organization,
            execute_organization,
            run_research,
            import_excel,
            get_datasets,
            get_dataset_detail,
            get_dataset_rows,
            search_dataset,
            delete_dataset,
            analyze_dataset,
            query_dataset,
            test_gemini_key,
            test_naver_key,
            test_google_key,
            extract_from_url,
            extract_from_urls,
            run_browser_agent,
            get_google_auth_url,
            exchange_google_code,
            create_google_slides,
            check_google_auth,
            run_data_collection,
            collect_web_data,
            export_collected_data_sheets,
            export_collected_data_excel,
            scan_for_consulting,
            get_ai_file_consulting,
            open_file_path,
            open_in_finder,
            delete_file_or_folder,
            get_folder_rename_suggestions,
            rename_folder,
            cancel_scan,
            is_scan_cancelled,
            save_postit,
            get_postit,
            get_all_postits,
            delete_postit,
            open_widget,
            save_alarm,
            get_alarms,
            toggle_alarm,
            delete_alarm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
