mod ai;
mod db;

use db::Memo;
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

// 입력: 텍스트를 분석해서 저장 또는 병합
#[tauri::command]
async fn input_memo(content: String) -> Result<InputResult, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

    // 기존 메모 목록 가져오기
    let existing_memos = db::get_all_memos().map_err(|e| e.to_string())?;
    let memo_info: Vec<(i64, String, String)> = existing_memos
        .iter()
        .map(|m| (m.id, m.title.clone(), m.summary.clone()))
        .collect();

    // AI 분석
    let (analysis, usage) = ai::analyze_memo(&api_key, &content, &memo_info).await?;

    // 사용량 기록
    db::log_api_usage(
        "analyze",
        "gemini-2.0-flash",
        usage.input_tokens,
        usage.output_tokens,
        usage.cost_usd,
    )
    .map_err(|e| e.to_string())?;

    let tags_str = analysis.tags.join(", ");

    // 병합 또는 새로 저장
    if let Some(merge_id) = analysis.should_merge_with {
        // 기존 메모와 병합
        if let Some(existing) = existing_memos.iter().find(|m| m.id == merge_id) {
            let merged_content = format!("{}\n\n---\n\n{}", existing.content, content);
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

            return Ok(InputResult {
                success: true,
                message: format!("기존 메모 '{}'에 병합되었습니다", existing.title),
                memo_id: Some(merge_id),
                merged: true,
                title: existing.title.clone(),
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cost_usd: usage.cost_usd,
            });
        }
    }

    // 새 메모 저장
    let new_memo = Memo {
        id: 0,
        title: analysis.title.clone(),
        content: content.clone(),
        formatted_content: analysis.formatted_content,
        summary: analysis.summary,
        category: analysis.category,
        tags: tags_str,
        embedding: None,
        created_at: String::new(),
        updated_at: String::new(),
    };

    let memo_id = db::save_memo(&new_memo).map_err(|e| e.to_string())?;

    Ok(InputResult {
        success: true,
        message: format!("새 메모 '{}'가 저장되었습니다", analysis.title),
        memo_id: Some(memo_id),
        merged: false,
        title: analysis.title,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: usage.cost_usd,
    })
}

// 찾기: 질문에 대한 답변
#[tauri::command]
async fn search_memo(question: String) -> Result<SearchResult, String> {
    let api_key = db::get_setting("gemini_api_key").map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        return Err("API 키를 먼저 설정해주세요".to_string());
    }

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
    let (answer, usage) = ai::ask_question(&api_key, &question, &context).await?;

    // 사용량 기록
    db::log_api_usage(
        "search",
        "gemini-2.0-flash",
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("Failed to get app dir");
            db::init_db(app_dir).expect("Failed to init database");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            input_memo,
            search_memo,
            get_memos,
            save_setting,
            get_setting,
            get_usage,
            export_db,
            import_db
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
