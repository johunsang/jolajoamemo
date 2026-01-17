use chrono::Datelike;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use chromiumoxide::{Browser, BrowserConfig};
use futures::StreamExt;
use std::sync::Arc;
use tokio::sync::Mutex;
use once_cell::sync::Lazy;

// ===== API 키 테스트 함수들 =====

/// Gemini API 키 테스트
pub async fn test_gemini_api(api_key: &str) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("API 키가 비어있습니다".to_string());
    }

    let client = Client::new();
    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}",
            api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": "Say 'API key is valid' in Korean"}]}],
            "generationConfig": {
                "maxOutputTokens": 20
            }
        }))
        .send()
        .await
        .map_err(|e| format!("요청 실패: {}", e))?;

    if response.status().is_success() {
        Ok("✅ Gemini API 키가 유효합니다".to_string())
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("❌ API 오류 ({}): {}", status, body))
    }
}

/// Naver Search API 키 테스트
pub async fn test_naver_api(client_id: &str, client_secret: &str) -> Result<String, String> {
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("Client ID 또는 Secret이 비어있습니다".to_string());
    }

    let client = Client::new();
    let response = client
        .get("https://openapi.naver.com/v1/search/news.json?query=test&display=1")
        .header("X-Naver-Client-Id", client_id)
        .header("X-Naver-Client-Secret", client_secret)
        .send()
        .await
        .map_err(|e| format!("요청 실패: {}", e))?;

    if response.status().is_success() {
        Ok("✅ Naver API 키가 유효합니다".to_string())
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("❌ API 오류 ({}): {}", status, body))
    }
}

/// Google Search API 키 테스트
pub async fn test_google_api(api_key: &str, cx: &str) -> Result<String, String> {
    if api_key.is_empty() || cx.is_empty() {
        return Err("API Key 또는 CX가 비어있습니다".to_string());
    }

    let client = Client::new();
    let url = format!(
        "https://www.googleapis.com/customsearch/v1?key={}&cx={}&q=test&num=1",
        api_key, cx
    );

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("요청 실패: {}", e))?;

    if response.status().is_success() {
        Ok("✅ Google Search API 키가 유효합니다".to_string())
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("❌ API 오류 ({}): {}", status, body))
    }
}

/// AI 응답에서 JSON만 추출하는 헬퍼 함수
fn extract_json(text: &str) -> String {
    let text = text.trim();

    // ```json ... ``` 블록에서 추출
    if let Some(start) = text.find("```json") {
        if let Some(end) = text[start..].find("```\n").or_else(|| text[start..].rfind("```")) {
            let json_start = start + 7; // "```json" 길이
            let json_end = start + end;
            if json_end > json_start {
                return text[json_start..json_end].trim().to_string();
            }
        }
    }

    // ``` ... ``` 블록에서 추출
    if let Some(start) = text.find("```") {
        let after_first = start + 3;
        if let Some(end) = text[after_first..].find("```") {
            let content = &text[after_first..after_first + end];
            // 첫 줄이 언어 지정이면 건너뛰기
            let json_content = if content.starts_with('\n') {
                content.trim()
            } else if let Some(newline) = content.find('\n') {
                content[newline..].trim()
            } else {
                content.trim()
            };
            return json_content.to_string();
        }
    }

    // { ... } 또는 [ ... ] JSON 블록 추출
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            if end > start {
                return text[start..=end].to_string();
            }
        }
    }

    if let Some(start) = text.find('[') {
        if let Some(end) = text.rfind(']') {
            if end > start {
                return text[start..=end].to_string();
            }
        }
    }

    text.to_string()
}

// 전역 브라우저 인스턴스 (재사용)
static BROWSER: Lazy<Arc<Mutex<Option<Arc<Browser>>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

/// 브라우저 lock 파일 정리
fn cleanup_browser_locks() {
    use std::fs;
    use std::path::Path;

    // chromiumoxide 기본 임시 디렉토리에서 lock 파일 삭제
    if let Ok(temp_dir) = std::env::var("TMPDIR") {
        let runner_dir = Path::new(&temp_dir).join("chromiumoxide-runner");
        if runner_dir.exists() {
            // SingletonLock 파일 삭제
            let lock_file = runner_dir.join("SingletonLock");
            if lock_file.exists() {
                let _ = fs::remove_file(&lock_file);
            }
            // SingletonSocket 파일도 삭제
            let socket_file = runner_dir.join("SingletonSocket");
            if socket_file.exists() {
                let _ = fs::remove_file(&socket_file);
            }
            // 전체 디렉토리 삭제 시도
            let _ = fs::remove_dir_all(&runner_dir);
        }
    }

    // 이전 jolajoamemo 브라우저 디렉토리도 정리
    if let Ok(entries) = std::fs::read_dir("/tmp") {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("jolajoamemo-chrome-") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

/// 헤드리스 브라우저 (리서치/추출용 - 백그라운드 실행)
static HEADLESS_BROWSER: Lazy<Mutex<Option<Arc<Browser>>>> = Lazy::new(|| Mutex::new(None));

async fn get_headless_browser() -> Result<Arc<Browser>, String> {
    let mut browser_lock = HEADLESS_BROWSER.lock().await;

    if let Some(ref browser) = *browser_lock {
        return Ok(Arc::clone(browser));
    }

    // 헤드리스 브라우저 설정 (사용자 Chrome과 독립)
    let config = BrowserConfig::builder()
        .arg("--no-sandbox")
        .arg("--disable-dev-shm-usage")
        .arg("--disable-gpu")
        .arg("--lang=ko-KR")
        .build()
        .map_err(|e| format!("헤드리스 브라우저 설정 실패: {}", e))?;

    let (browser, mut handler) = Browser::launch(config)
        .await
        .map_err(|e| format!("헤드리스 브라우저 실행 실패: {}", e))?;

    tokio::spawn(async move {
        while let Some(_) = handler.next().await {}
    });

    let browser = Arc::new(browser);
    *browser_lock = Some(Arc::clone(&browser));
    Ok(browser)
}

/// 브라우저 인스턴스 가져오기 (에이전트용 - GUI 모드)
async fn get_browser() -> Result<Arc<Browser>, String> {
    let mut browser_lock = BROWSER.lock().await;

    if let Some(ref browser) = *browser_lock {
        return Ok(Arc::clone(browser));
    }

    // 기존 Chrome 종료 (프로필 잠금 해제를 위해)
    let _ = std::process::Command::new("osascript")
        .args(["-e", "tell application \"Google Chrome\" to quit"])
        .output();

    tokio::time::sleep(tokio::time::Duration::from_millis(2000)).await;
    cleanup_browser_locks();

    let home_dir = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let chrome_user_data = format!("{}/Library/Application Support/Google/Chrome", home_dir);
    let chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    let config = BrowserConfig::builder()
        .chrome_executable(chrome_path)
        .with_head()
        .arg("--no-sandbox")
        .arg("--disable-dev-shm-usage")
        .arg("--lang=ko-KR")
        .arg("--window-size=1920,1080")
        .arg(format!("--user-data-dir={}", chrome_user_data))
        .arg("--profile-directory=Default")
        .build()
        .map_err(|e| format!("브라우저 설정 실패: {}", e))?;

    let (browser, mut handler) = Browser::launch(config)
        .await
        .map_err(|e| format!("브라우저 실행 실패: {}", e))?;

    tokio::spawn(async move {
        while let Some(_) = handler.next().await {}
    });

    let browser = Arc::new(browser);
    *browser_lock = Some(Arc::clone(&browser));
    Ok(browser)
}

const DEFAULT_MODEL: &str = "gemini-3-flash-preview";

// Gemini API 기본 가격 (USD per 1M tokens) - 2.0 Flash 기준
const INPUT_PRICE_PER_M: f64 = 0.10;
const OUTPUT_PRICE_PER_M: f64 = 0.40;

// 모델별 가격 (input, output per 1M tokens)
pub fn get_model_price(model: &str) -> (f64, f64) {
    match model {
        // Gemini 2.0 (저렴)
        "gemini-2.0-flash-lite" => (0.075, 0.30),
        "gemini-2.0-flash" => (0.10, 0.40),
        // Gemini 2.5
        "gemini-2.5-flash-lite" => (0.10, 0.40),
        "gemini-2.5-flash" => (0.30, 2.50),
        "gemini-2.5-pro" => (1.25, 10.00),
        // Gemini 3
        "gemini-3-flash-preview" => (0.50, 3.00),
        "gemini-3-pro-preview" => (2.00, 12.00),
        _ => (INPUT_PRICE_PER_M, OUTPUT_PRICE_PER_M),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleInfo {
    pub title: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TodoInfo {
    pub title: String,
    pub priority: Option<String>,  // high, medium, low
    pub due_date: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransactionInfo {
    pub tx_type: String,  // "income" or "expense"
    pub amount: i64,
    pub description: String,
    pub category: Option<String>,
    pub tx_date: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub title: String,
    pub formatted_content: String,
    pub summary: String,
    pub category: String,
    pub tags: Vec<String>,
    pub should_merge_with: Option<i64>,
    #[serde(default)]
    pub schedules: Vec<ScheduleInfo>,
    #[serde(default)]
    pub todos: Vec<TodoInfo>,
    #[serde(default)]
    pub transactions: Vec<TransactionInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MultiAnalysisResult {
    pub items: Vec<AnalysisResult>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    candidates: Vec<Candidate>,
    #[serde(rename = "usageMetadata")]
    usage_metadata: Option<UsageMetadata>,
}

#[derive(Debug, Deserialize)]
struct Candidate {
    content: Content,
}

#[derive(Debug, Deserialize)]
struct Content {
    parts: Vec<Part>,
}

#[derive(Debug, Deserialize)]
struct Part {
    text: String,
}

#[derive(Debug, Deserialize)]
struct UsageMetadata {
    #[serde(rename = "promptTokenCount")]
    prompt_token_count: i64,
    #[serde(rename = "candidatesTokenCount")]
    candidates_token_count: i64,
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    embedding: EmbeddingData,
}

#[derive(Debug, Deserialize)]
struct EmbeddingData {
    values: Vec<f32>,
}

pub fn calculate_cost(model: &str, input_tokens: i64, output_tokens: i64) -> f64 {
    let (input_price, output_price) = get_model_price(model);
    (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0)
}

/// 민감 정보 마스킹 결과 (마스킹된 텍스트 + 복원용 매핑)
pub struct MaskResult {
    pub masked: String,
    pub mappings: Vec<(String, String)>, // (마스킹 토큰, 원본 값)
}

/// 민감 정보 마스킹 (AI에게 보낼 때 사용, 복원용 매핑도 반환)
pub fn mask_sensitive_info(text: &str) -> MaskResult {
    let mut masked = text.to_string();
    let mut mappings: Vec<(String, String)> = Vec::new();
    let mut counter = 0;

    // 고유 토큰 생성 함수
    let mut make_token = |label: &str, original: &str| -> String {
        counter += 1;
        let token = format!("[{}_{}]", label, counter);
        mappings.push((token.clone(), original.to_string()));
        token
    };

    // 1. API 키 패턴 (Google, OpenAI, AWS 등)
    let api_patterns = [
        r"AIza[0-9A-Za-z_-]{35}",
        r"sk-[0-9A-Za-z]{48}",
        r"sk-proj-[0-9A-Za-z_-]{100,}",
        r"AKIA[0-9A-Z]{16}",
        r"ghp_[0-9A-Za-z]{36}",
        r"glpat-[0-9A-Za-z_-]{20}",
    ];
    for pattern in api_patterns {
        if let Ok(re) = Regex::new(pattern) {
            let matches: Vec<String> = re.find_iter(&masked).map(|m| m.as_str().to_string()).collect();
            for m in matches {
                let token = make_token("API키", &m);
                masked = masked.replacen(&m, &token, 1);
            }
        }
    }

    // 2. 주민등록번호 (000000-0000000)
    if let Ok(re) = Regex::new(r"\d{6}[-\s]?\d{7}") {
        let matches: Vec<String> = re.find_iter(&masked).map(|m| m.as_str().to_string()).collect();
        for m in matches {
            let token = make_token("주민번호", &m);
            masked = masked.replacen(&m, &token, 1);
        }
    }

    // 3. 전화번호 (010-0000-0000, 02-000-0000 등)
    if let Ok(re) = Regex::new(r"0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}") {
        let matches: Vec<String> = re.find_iter(&masked).map(|m| m.as_str().to_string()).collect();
        for m in matches {
            let token = make_token("전화번호", &m);
            masked = masked.replacen(&m, &token, 1);
        }
    }

    // 4. 이메일 주소
    if let Ok(re) = Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}") {
        let matches: Vec<String> = re.find_iter(&masked).map(|m| m.as_str().to_string()).collect();
        for m in matches {
            let token = make_token("이메일", &m);
            masked = masked.replacen(&m, &token, 1);
        }
    }

    // 5. 신용카드 번호 (0000-0000-0000-0000)
    if let Ok(re) = Regex::new(r"\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}") {
        let matches: Vec<String> = re.find_iter(&masked).map(|m| m.as_str().to_string()).collect();
        for m in matches {
            let token = make_token("카드번호", &m);
            masked = masked.replacen(&m, &token, 1);
        }
    }

    // 6. 계좌번호 (은행명 + 숫자)
    if let Ok(re) = Regex::new(r"(?:국민|신한|우리|하나|농협|기업|SC|씨티|케이뱅크|카카오|토스).{0,5}\d{10,14}") {
        let matches: Vec<String> = re.find_iter(&masked).map(|m| m.as_str().to_string()).collect();
        for m in matches {
            let token = make_token("계좌번호", &m);
            masked = masked.replacen(&m, &token, 1);
        }
    }

    // 7. 도로명 주소
    if let Ok(re) = Regex::new(r"(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도)?\s*[가-힣]+(?:시|군|구)\s*[가-힣0-9]+(?:로|길|동|읍|면)\s*[\d\-가-힣\s]*") {
        let matches: Vec<String> = re.find_iter(&masked).map(|m| m.as_str().to_string()).collect();
        for m in matches {
            let token = make_token("주소", &m);
            masked = masked.replacen(&m, &token, 1);
        }
    }

    // 8. 비밀번호 패턴
    if let Ok(re) = Regex::new(r"(?i)(?:password|비밀번호|비번|pw|암호)\s*[:=]\s*\S+") {
        let matches: Vec<String> = re.find_iter(&masked).map(|m| m.as_str().to_string()).collect();
        for m in matches {
            let token = make_token("비밀번호", &m);
            masked = masked.replacen(&m, &token, 1);
        }
    }

    MaskResult { masked, mappings }
}

/// 마스킹된 텍스트를 원본으로 복원
pub fn unmask_text(masked_text: &str, mappings: &[(String, String)]) -> String {
    let mut result = masked_text.to_string();
    for (token, original) in mappings {
        result = result.replace(token, original);
    }
    result
}

// RAG 질의응답
pub async fn ask_question(
    api_key: &str,
    model: &str,
    question: &str,
    context_memos: &[(String, String)],
) -> Result<(String, TokenUsage), String> {
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };
    let client = Client::new();

    let context = context_memos
        .iter()
        .map(|(title, content)| format!("### {}\n{}", title, content))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    let prompt = format!(
        r#"당신은 사용자의 메모를 기반으로 질문에 답하는 AI 비서입니다.

## 저장된 메모 내용:
{}

## 사용자 질문:
{}

## 지침:
- 메모 내용을 기반으로 정확하게 답변하세요
- 메모에 없는 내용은 "메모에서 찾을 수 없습니다"라고 답하세요
- 간결하고 명확하게 답변하세요
- 관련 메모가 있다면 어떤 메모에서 찾았는지 알려주세요"#,
        context, question
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let usage = gemini_resp.usage_metadata.unwrap_or(UsageMetadata {
        prompt_token_count: 0,
        candidates_token_count: 0,
    });

    let token_usage = TokenUsage {
        input_tokens: usage.prompt_token_count,
        output_tokens: usage.candidates_token_count,
        cost_usd: calculate_cost(model, usage.prompt_token_count, usage.candidates_token_count),
    };

    Ok((text, token_usage))
}

// 여러 개 메모 자동 분리 분석
pub async fn analyze_multi_memo(
    api_key: &str,
    model: &str,
    content: &str,
    existing_memos: &[(i64, String, String)],
    existing_categories: &[String],
) -> Result<(Vec<AnalysisResult>, TokenUsage), String> {
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };
    let client = Client::new();

    // 민감 정보 마스킹 (AI에게 보낼 때만)
    let mask_result = mask_sensitive_info(content);
    let masked_content = &mask_result.masked;

    let existing_info = if existing_memos.is_empty() {
        "없음".to_string()
    } else {
        existing_memos
            .iter()
            .take(5)  // 5개로 제한하여 AI 혼란 방지
            .map(|(id, title, _summary)| format!("ID:{} - {}", id, title))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let categories_info = if existing_categories.is_empty() {
        "없음 (새로 생성 가능)".to_string()
    } else {
        existing_categories.join(", ")
    };

    // 현재 날짜/시간 가져오기
    let now = chrono::Local::now();
    let current_datetime = now.format("%Y-%m-%d %H:%M").to_string();
    let today_date = now.format("%Y-%m-%d").to_string();  // 오늘 날짜만
    let tomorrow_date = (now + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let current_weekday = match now.weekday() {
        chrono::Weekday::Mon => "월요일",
        chrono::Weekday::Tue => "화요일",
        chrono::Weekday::Wed => "수요일",
        chrono::Weekday::Thu => "목요일",
        chrono::Weekday::Fri => "금요일",
        chrono::Weekday::Sat => "토요일",
        chrono::Weekday::Sun => "일요일",
    };

    // "오늘", "내일" 등을 실제 날짜로 미리 치환
    let preprocessed_content = masked_content
        .replace("오늘", &format!("{}(오늘)", today_date))
        .replace("내일", &format!("{}(내일)", tomorrow_date));

    let prompt = format!(
        r#"당신은 메모 정리 AI입니다. 사용자가 입력한 텍스트를 분석하세요.

#########################################################
## 🚨🚨🚨 최우선 필수 추출 - 절대 놓치지 마세요!!! 🚨🚨🚨
#########################################################
1. **일정(schedules)**: 날짜+장소/방문/만남/약속 → 무조건 추출!
2. **할일(todos)**: ~해야함, ~까지, ~하기, 요청/심부름 → 무조건 추출!
3. **가계부(transactions)**: 금액(원, 천원, 만원) → 무조건 추출!

⚠️ 이 3가지를 놓치면 사용자에게 큰 피해가 갑니다!
⚠️ 조금이라도 해당되면 반드시 추출하세요!
#########################################################

##############################################
## ⚠️⚠️⚠️ 오늘 날짜: {} ⚠️⚠️⚠️
## 현재 시간: {} ({})
##############################################
## 🚨 "오늘"이라고 말하면 반드시 {} 사용!!! 🚨
## 🚨 절대로 하루를 더하지 마세요!!! 🚨
##############################################

## 입력된 텍스트:
{}

## 기존 메모 목록:
{}

## 기존 카테고리 목록:
{}

## 중요 작업:

### 1. 내용 구조화 (마크다운 형식으로 깔끔하게!)
- formatted_content는 반드시 **마크다운(Markdown)** 형식으로 정리
- 사용할 마크다운 문법:
  - 제목: ## 제목, ### 소제목
  - 목록: - 항목1, - 항목2
  - 번호: 1. 첫번째, 2. 두번째
  - 강조: **굵게**, *기울임*
  - 구분선: ---
- 예시 (연락처):
  ```
  ## 홍길동
  - **전화**: 010-1234-5678
  - **이메일**: hong@email.com
  - **주소**: 서울시 강남구 역삼동
  ```
- 예시 (회의록):
  ```
  ## 프로젝트 회의
  ### 참석자
  - 김철수, 이영희
  ### 논의 내용
  1. 일정 확인
  2. 예산 검토
  ### 결정 사항
  - 다음 주 월요일 착수
  ```
- 원본의 중요 정보는 절대 누락하지 말 것!

### 2. 텍스트 분리 (너무 잘게 쪼개지 마!)
- 같은 맥락/상황의 내용은 **하나의 메모**로 유지
- 예: 엄마 카톡 내용 → 전체를 "엄마 심부름" 1개 메모로 저장 (할일만 여러 개 추출)
- 예: 회의 내용 → 전체를 "회의록" 1개 메모로 저장 (할일/일정만 추출)
- **완전히 다른 주제**일 때만 분리 (예: 연락처 + 아이디어 = 2개)
- 관련된 내용은 절대 쪼개지 말고 하나로!

### 3. 카테고리 분류 (구체적으로! "메모" 사용 금지!)
- 메모 내용을 보고 가장 **구체적인** 카테고리를 선택/생성
- 기존 카테고리가 **정확히** 맞으면 사용, 아니면 새로 생성
- **⚠️ "메모"는 카테고리로 사용하지 마세요! 너무 일반적입니다!**
- 카테고리는 2~4글자 한국어로, 내용을 명확히 설명해야 함
- 카테고리 예시:
  - 연락처: 사람 이름, 전화번호, 이메일
  - 주소: 집주소, 회사주소, 배송주소
  - 계정정보: 아이디, 비밀번호, 서비스 정보
  - 회의록: 회의 내용, 미팅 기록
  - 아이디어: 생각, 계획, 브레인스토밍
  - 일기: 하루 기록, 감정, 일상
  - 레시피: 요리법, 음식 만들기
  - 쇼핑: 구매 목록, 살 것
  - 건강: 운동, 식단, 병원
  - 학습: 공부, 강의, 배움
  - 업무: 일, 프로젝트, 작업
  - 여행: 여행 계획, 관광지
  - 리뷰: 영화, 책, 제품 후기
  - 링크: URL, 웹사이트, 참고자료
- **다른 종류의 정보를 같은 카테고리에 넣지 마세요!**
- **"메모", "기타", "일반" 같은 모호한 카테고리 절대 금지!**

### 4. 병합 규칙 (매우 엄격하게!)
- **should_merge_with는 거의 항상 null로 설정하세요!**
- 병합은 오직 "완전히 동일한 대상"일 때만 (예: 똑같은 사람 "김철수"의 연락처 업데이트)
- 주제가 조금이라도 다르면 절대 병합하지 마세요!
- 의심되면 병합하지 마세요 - 새 메모로 저장!
- 주소, 연락처, 서비스 정보 등은 각각 별개의 메모로!

### 4. 일정 추출 (장소 이동/방문/만남이 있으면 무조건 일정!)
**중요: 다음 패턴이 있으면 반드시 schedules 배열에 추가!!!**
- "병원 방문", "~가다", "~방문", "~만나다", "~가야", "~에 가"
- "약속", "미팅", "회의", "면접", "출장", "여행"
- "예약", "진료", "상담", "점검"
- 날짜/시간 + 장소가 있으면 무조건 일정!

**날짜 변환 규칙 (⚠️ 최우선!!!):**
- 🚨🚨🚨 **"오늘" = {} (이 날짜 그대로 사용!!!)** 🚨🚨🚨
- "오늘 강의" → start_time: "{}T시간"
- "오늘 8시" → start_time: "{}T20:00"
- "오늘 저녁" → start_time: "{}T18:00"
- **절대 +1일 하지 마세요! 오늘은 오늘입니다!**
- "내일" → {}의 다음날
- "모레" → {}의 2일 후
- **반드시 YYYY-MM-DD 또는 YYYY-MM-DDTHH:MM 형식으로!**

**예시 (오늘이 {}일 때):**
- "오늘 저녁 8시 강의" → start_time: "{}T20:00" ✓
- "오늘 3시 회의" → start_time: "{}T15:00" ✓

### 5. 할일 추출 (적극적으로!)
- 다음 패턴 모두 할일로 추출:
  - "~해야 함/한다/해", "~할 것", "~하기", "~까지"
  - "~해줘", "~사와", "~가져와", "~해봐", "~예약해줘"
  - "~정리해야겠다", "~찾아봐야지", "~작성해야겠다"
  - 요청/부탁/심부름 형태의 모든 것
- 긴급/급함/ASAP/빨리 → priority: "high"
- 기한 있으면 → due_date를 실제 날짜로 계산 (예: "2026-01-15")
- 기한 없으면 → due_date: null
- **마찬가지로 "내일까지" → 실제 날짜 "2026-01-15"로 변환!**
- **하나의 입력에서 여러 개의 할일을 적극적으로 추출!**

### 6. 가계부(거래) 추출 - 핵심!!! 금액이 있으면 반드시 거래로 추출!!!
**중요: 숫자+원 패턴이 있으면 무조건 transactions 배열에 추가해야 함!!!**

- 금액 패턴 예시: "5000원", "5천원", "5만원", "50000원", "300만원", "3만5천원"
- tx_type 판단 기준:
  - income (수입): "입금", "월급", "보너스", "수입", "받았다", "들어왔다", "급여"
  - expense (지출): **그 외 모든 경우!** "커피", "점심", "저녁", "쇼핑", "결제", "구매", "사다", "샀다", "이체", "카페", "마트" 등
  - **기본값은 expense(지출)!!! 수입 키워드가 없으면 무조건 expense!!!**
- amount 변환 (반드시 숫자로!):
  - "5천원" → 5000, "3만원" → 30000, "3만5천원" → 35000
  - "100만원" → 1000000, "1억" → 100000000
- description: 무엇에 대한 거래인지 (예: "커피", "점심", "월급")
- category: "식비", "교통비", "월급", "쇼핑", "생활비", "카페", "문화" 등
- tx_date:
  - 날짜+시간 있으면 → "2026-01-14T15:30"
  - 날짜만 있으면 → "2026-01-14"
  - 없으면 → 현재 날짜 "{}"

**예시:**
- "커피 5000원" → {{tx_type: "expense", amount: 5000, description: "커피"}}
- "점심 1만원" → {{tx_type: "expense", amount: 10000, description: "점심"}}
- "월급 300만원 입금" → {{tx_type: "income", amount: 3000000, description: "월급"}}

## 응답 형식 (JSON 배열):
{{
  "items": [
    {{
      "title": "제목1",
      "formatted_content": "정리된 내용1",
      "summary": "한줄요약1",
      "category": "카테고리1",
      "tags": ["태그"],
      "should_merge_with": null,
      "schedules": [
        {{
          "title": "일정 제목",
          "start_time": "2026-01-15T15:00",
          "end_time": "2026-01-15T16:00",
          "location": "장소",
          "description": "설명"
        }}
      ],
      "todos": [
        {{
          "title": "할일 내용",
          "priority": "high",
          "due_date": "2026-01-15"
        }}
      ],
      "transactions": [
        {{
          "tx_type": "expense",
          "amount": 5000,
          "description": "커피",
          "category": "식비",
          "tx_date": "2026-01-14"
        }}
      ]
    }}
  ]
}}

일정/할일/거래가 없으면 각각 빈 배열 []로 두세요.
하나의 주제만 있으면 items에 1개만 넣으세요."#,
        today_date, current_datetime, current_weekday, today_date, preprocessed_content, existing_info, categories_info,
        // 날짜 변환 규칙 섹션
        today_date, today_date, today_date, today_date, today_date, today_date, today_date, today_date, today_date,
        // tx_date 기본값
        current_datetime
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let usage = gemini_resp.usage_metadata.unwrap_or(UsageMetadata {
        prompt_token_count: 0,
        candidates_token_count: 0,
    });

    let json_text = extract_json(&text);
    let multi_result: MultiAnalysisResult = serde_json::from_str(&json_text)
        .map_err(|e| format!("JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    // 마스킹된 민감 정보 복원
    let restored_items: Vec<AnalysisResult> = multi_result.items.into_iter().map(|mut item| {
        item.title = unmask_text(&item.title, &mask_result.mappings);
        item.formatted_content = unmask_text(&item.formatted_content, &mask_result.mappings);
        item.summary = unmask_text(&item.summary, &mask_result.mappings);
        item.tags = item.tags.into_iter().map(|t| unmask_text(&t, &mask_result.mappings)).collect();
        // 일정과 할일도 복원
        item.schedules = item.schedules.into_iter().map(|mut s| {
            s.title = unmask_text(&s.title, &mask_result.mappings);
            s.location = s.location.map(|l| unmask_text(&l, &mask_result.mappings));
            s.description = s.description.map(|d| unmask_text(&d, &mask_result.mappings));
            s
        }).collect();
        item.todos = item.todos.into_iter().map(|mut t| {
            t.title = unmask_text(&t.title, &mask_result.mappings);
            t
        }).collect();
        // 거래도 복원
        item.transactions = item.transactions.into_iter().map(|mut tx| {
            tx.description = unmask_text(&tx.description, &mask_result.mappings);
            tx.category = tx.category.map(|c| unmask_text(&c, &mask_result.mappings));
            tx
        }).collect();
        item
    }).collect();

    let token_usage = TokenUsage {
        input_tokens: usage.prompt_token_count,
        output_tokens: usage.candidates_token_count,
        cost_usd: calculate_cost(model, usage.prompt_token_count, usage.candidates_token_count),
    };

    Ok((restored_items, token_usage))
}

// ===== 폴더 정리 AI 기능 =====

#[derive(Debug, Deserialize)]
struct OrganizeResponse {
    files: Vec<OrganizePlanResponse>,
}

#[derive(Debug, Deserialize)]
struct OrganizePlanResponse {
    file_name: String,
    suggested_folder: String,
    reason: String,
}

/// AI로 파일 정리 분석
/// files: (파일명, 확장자, 크기, 수정일, 경로) 튜플 목록
/// 참고: 파일 정리는 복잡한 분석이 필요하므로 항상 Gemini 3 모델 사용
pub async fn analyze_files_for_organization(
    api_key: &str,
    _model: &str,  // 무시됨 - 항상 Gemini 3 사용
    files: &[(String, String, u64, String, String)], // (name, extension, size, modified, path)
) -> Result<Vec<(String, String, String, String)>, String> { // (file_path, file_name, suggested_folder, reason)
    // 파일 정리는 항상 Gemini 3 Flash 사용 (더 정확한 분류를 위해)
    let model = "gemini-3-flash-preview";
    let client = Client::new();

    // 파일이 너무 많으면 배치로 나눠서 처리 (최대 30개씩)
    const BATCH_SIZE: usize = 30;
    let mut all_results: Vec<(String, String, String, String)> = Vec::new();

    for chunk in files.chunks(BATCH_SIZE) {
        let batch_results = analyze_files_batch(api_key, model, chunk, &client).await?;
        all_results.extend(batch_results);
    }

    Ok(all_results)
}

/// 파일 배치 분석 (내부 함수)
async fn analyze_files_batch(
    api_key: &str,
    model: &str,
    files: &[(String, String, u64, String, String)],
    client: &Client,
) -> Result<Vec<(String, String, String, String)>, String> {
    // 파일 목록을 텍스트로 변환
    let file_list: Vec<String> = files
        .iter()
        .map(|(name, ext, size, _modified, _path)| {
            format!(
                "- {} (확장자: {}, 크기: {}KB)",
                name,
                if ext.is_empty() { "없음" } else { ext },
                size / 1024
            )
        })
        .collect();

    let file_names: Vec<String> = files.iter().map(|(name, _, _, _, _)| name.clone()).collect();

    let prompt = format!(
        r#"당신은 파일 정리 전문가입니다. 사용자의 폴더에 있는 파일들을 분석하고 적절한 하위 폴더로 정리하는 방안을 제안하세요.

## 파일 목록:
{}

## 정리 규칙:
1. **파일 유형별 분류**:
   - 이미지 (jpg, png, gif, webp, svg, ico, bmp) → "이미지" 또는 "사진"
   - 문서 (pdf, doc, docx, txt, hwp, xlsx, pptx) → "문서"
   - 영상 (mp4, mov, avi, mkv, wmv) → "영상"
   - 음악 (mp3, wav, flac, m4a, ogg) → "음악"
   - 압축파일 (zip, rar, 7z, tar, gz) → "압축파일"
   - 코드 (js, ts, py, java, html, css, json, rs) → "코드"
   - 실행파일 (exe, dmg, app, msi) → "설치파일"

2. **파일명 기반 분류** (더 우선):
   - 날짜가 포함된 사진 (IMG_20240101, Screenshot 2024) → "사진/2024" 등 연도별
   - "계약서", "이력서", "보고서" 등 키워드 → "문서/업무"
   - "영수증", "청구서" → "문서/재무"
   - 게임 관련 → "게임"
   - 스크린샷 → "스크린샷"

3. **정리 원칙**:
   - 하위 폴더는 1~2단계까지만 (예: "사진/2024", "문서/업무")
   - 폴더명은 한국어로, 직관적이고 짧게
   - 분류가 애매하면 "기타"로

## 응답 형식 (JSON만 출력):
{{
  "files": [
    {{
      "file_name": "정확한 파일명.확장자",
      "suggested_folder": "제안할 폴더명",
      "reason": "왜 이 폴더인지 간단한 이유"
    }}
  ]
}}

모든 파일에 대해 분석 결과를 제공하세요. 파일명은 정확히 일치해야 합니다.
분석 대상 파일명 목록: {:?}"#,
        file_list.join("\n"),
        file_names
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let json_text = extract_json(&text);
    let organize_resp: OrganizeResponse = serde_json::from_str(&json_text)
        .map_err(|e| format!("JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    // 파일 경로와 매핑하여 결과 반환
    let mut results: Vec<(String, String, String, String)> = Vec::new();

    for resp_plan in organize_resp.files {
        // 원본 파일 정보 찾기
        if let Some((name, _ext, _size, _modified, path)) = files.iter().find(|(name, _, _, _, _)| *name == resp_plan.file_name) {
            results.push((
                path.clone(),
                name.clone(),
                resp_plan.suggested_folder,
                resp_plan.reason,
            ));
        }
    }

    Ok(results)
}

// ===== 자동 검색 & 리포트 생성 기능 =====

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchItem {
    pub title: String,
    pub link: String,
    pub description: String,
    pub source: String, // "naver" or "google"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResearchReport {
    pub query: String,
    pub summary: String,
    pub key_points: Vec<String>,
    pub sources: Vec<SearchItem>,
    pub full_report: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

// ===== 에이전트 기반 리서치 시스템 =====

/// 1단계: AI가 리서치 계획 수립
pub async fn plan_research(
    api_key: &str,
    model: &str,
    query: &str,
) -> Result<(Vec<String>, i64, i64, f64), String> {
    let client = Client::new();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };

    let prompt = format!(
        r#"당신은 세계 최고의 리서치 전문가입니다. 사용자의 질문에 대해 최대한 많은 정보를 수집하기 위한 검색 쿼리 목록을 만들어주세요.

사용자 질문: "{}"

요구사항:
1. 다양한 관점에서 정보를 수집할 수 있는 검색 쿼리 5-7개 생성
2. 각 쿼리는 구체적이고 검색에 최적화된 형태로
3. 한국어와 영어 쿼리를 적절히 혼합
4. 다양한 시각의 정보를 얻기 위해 긍정적/부정적/중립적 관점의 쿼리 포함
5. 전문가 의견, 통계, 최신 뉴스, 분석 기사 등 다양한 유형의 정보를 얻을 수 있는 쿼리

응답 형식 (JSON):
{{
    "queries": [
        "검색 쿼리 1",
        "검색 쿼리 2",
        "검색 쿼리 3",
        "검색 쿼리 4",
        "검색 쿼리 5"
    ]
}}"#,
        query
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.7,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    #[derive(Deserialize)]
    struct PlanResponse {
        queries: Vec<String>,
    }

    let json_text = extract_json(&text);
    let plan: PlanResponse = serde_json::from_str(&json_text)
        .map_err(|e| format!("JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    Ok((plan.queries, input_tokens, output_tokens, cost))
}

/// 2단계: AI가 크롤링할 페이지 선택
pub async fn select_pages_to_crawl(
    api_key: &str,
    model: &str,
    query: &str,
    search_results: &[SearchItem],
) -> Result<(Vec<String>, i64, i64, f64), String> {
    let client = Client::new();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };

    let results_text: String = search_results
        .iter()
        .enumerate()
        .map(|(i, item)| format!("[{}] {} - {}\nURL: {}", i, item.title, item.description, item.link))
        .collect::<Vec<_>>()
        .join("\n\n");

    let prompt = format!(
        r#"검색 결과 중에서 "{}"에 대해 가장 유용하고 다양한 관점의 정보를 제공할 페이지들을 선택해주세요.

검색 결과:
{}

요구사항:
1. 가장 관련성 높고 신뢰할 수 있는 페이지 15-20개 선택 (가능한 많이)
2. 다양한 출처에서 선택 (같은 도메인은 최대 2-3개까지만)
3. 뉴스, 공식 문서, 전문 블로그, 연구 자료 우선
4. 긍정적/부정적/중립적 관점의 글을 골고루 선택
5. 최신 자료 우선

응답 형식 (JSON):
{{
    "selected_urls": [
        "https://example.com/page1",
        "https://example.com/page2",
        "https://example.com/page3"
    ]
}}"#,
        query, results_text
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    #[derive(Deserialize)]
    struct SelectResponse {
        selected_urls: Vec<String>,
    }

    let json_text = extract_json(&text);
    let selection: SelectResponse = serde_json::from_str(&json_text)
        .map_err(|e| format!("JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    Ok((selection.selected_urls, input_tokens, output_tokens, cost))
}

/// 3단계: AI가 각 페이지에서 핵심 정보 추출
pub async fn extract_insights(
    api_key: &str,
    model: &str,
    query: &str,
    url: &str,
    content: &str,
) -> Result<(Vec<String>, i64, i64, f64), String> {
    let client = Client::new();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };

    // 내용이 너무 길면 잘라내기
    let truncated_content: String = content.chars().take(8000).collect();

    let prompt = format!(
        r#"다음 웹페이지 내용에서 "{}"와 관련된 핵심 정보와 이 출처의 관점/의견을 추출해주세요.

페이지 URL: {}

페이지 내용:
{}

추출 요구사항:
1. 이 출처가 주제에 대해 갖고 있는 견해/의견을 상세히 파악
2. 구체적인 수치, 통계, 사실 정보를 모두 추출
3. 다른 출처와 다를 수 있는 독특한 관점이나 주장 포함
4. 각 정보에 반드시 출처명과 URL 일부 포함
5. 가능한 많은 정보를 추출 (5-10개)
6. 마크다운 기호(#, **, *, -)를 절대 사용하지 마세요

응답 형식 (JSON):
{{
    "insights": [
        "[관점] 이 출처의 핵심 의견/견해 요약 (출처: 페이지명)",
        "[사실] 구체적 정보나 수치 (출처: 페이지명)",
        "[분석] 출처의 분석이나 전망 (출처: 페이지명)",
        "[주장] 이 출처의 독특한 주장 (출처: 페이지명)",
        "[데이터] 통계나 연구 결과 (출처: 페이지명)"
    ]
}}"#,
        query, url, truncated_content
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    #[derive(Deserialize)]
    struct InsightResponse {
        insights: Vec<String>,
    }

    let json_text = extract_json(&text);
    let result: InsightResponse = serde_json::from_str(&json_text)
        .unwrap_or(InsightResponse { insights: Vec::new() });

    Ok((result.insights, input_tokens, output_tokens, cost))
}

/// 3-2단계: 각 출처별 개별 요약 생성 (별첨용)
pub async fn summarize_source(
    api_key: &str,
    model: &str,
    query: &str,
    title: &str,
    url: &str,
    content: &str,
) -> Result<(String, i64, i64, f64), String> {
    let client = Client::new();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };

    // 내용이 너무 길면 잘라내기
    let truncated_content: String = content.chars().take(6000).collect();

    let prompt = format!(
        r#"다음 웹페이지 내용을 "{}"라는 주제 관점에서 요약해주세요.

페이지 정보:
제목: {}
URL: {}

페이지 내용:
{}

요구사항:
1. 이 출처의 핵심 주장과 관점을 5-8문장으로 상세히 요약
2. 주제와 관련된 구체적인 정보, 수치, 통계가 있다면 반드시 포함
3. 이 출처가 다른 출처와 다른 독특한 관점이나 주장이 있다면 언급
4. 객관적이고 중립적인 톤으로 작성
5. 마크다운 기호(#, **, *, -)를 절대 사용하지 마세요. 일반 텍스트로만 작성

응답 형식 (JSON):
{{
    "summary": "이 출처의 상세 요약 (5-8문장). 마크다운 기호 없이 일반 텍스트로만 작성."
}}"#,
        query, title, url, truncated_content
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    #[derive(Deserialize)]
    struct SummaryResponse {
        summary: String,
    }

    let json_text = extract_json(&text);
    let result: SummaryResponse = serde_json::from_str(&json_text)
        .unwrap_or(SummaryResponse { summary: "요약 생성 실패".to_string() });

    Ok((result.summary, input_tokens, output_tokens, cost))
}

/// 4단계: 최종 리포트 작성
pub async fn compile_final_report(
    api_key: &str,
    model: &str,
    query: &str,
    insights: &[String],
    sources: &[SearchItem],
) -> Result<(String, String, Vec<String>, i64, i64, f64), String> {
    let client = Client::new();
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };

    let insights_text = insights.join("\n- ");
    let sources_text: String = sources
        .iter()
        .take(30)
        .enumerate()
        .map(|(i, s)| format!("[{}] {} ({}) - {}", i+1, s.title, s.source, s.link))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        r#"당신은 세계 최고 수준의 학술 연구원입니다.
"{}"에 대한 종합적이고 심층적인 연구 리포트를 작성해주세요.

수집된 인사이트 (출처별 정리):
- {}

참고 출처:
{}

작성 요구사항:

1. 세계 최고 수준의 학술 논문 구조
   - 서론: 연구 배경, 목적, 범위를 상세히 설명 (최소 300자)
   - 본론: 다양한 관점과 의견을 종합적으로 분석, 각 출처의 견해를 비교 대조 (최소 1500자)
   - 결론: 핵심 발견사항 요약, 시사점, 향후 전망 (최소 300자)

2. 출처 명시 규칙 (필수!)
   - 모든 주요 주장이나 사실에는 반드시 출처를 괄호 안에 명시
   - 예: 인공지능 시장은 2025년까지 연평균 35% 성장할 것으로 예측된다 (네이버 뉴스)
   - 서로 다른 출처의 의견이 다를 경우 각각 명시하고 비교 분석
   - 출처별로 독특한 관점이나 주장이 있다면 반드시 언급

3. 분석의 깊이
   - 단순 정보 나열이 아닌 비판적이고 심층적인 분석 포함
   - 상반된 의견이 있다면 양쪽 모두 제시하고 장단점 분석
   - 정보의 신뢰성과 한계점도 언급
   - 각 출처의 입장과 배경을 고려한 분석

4. 핵심 포인트는 가장 중요한 발견 7-10개 정리

5. 최소 2500자 이상의 매우 상세한 리포트 작성

6. 중요: 마크다운 기호 사용 금지
   - # ** * - 등의 마크다운 기호를 절대 사용하지 마세요
   - 일반 텍스트로만 작성하세요
   - 섹션 구분은 줄바꿈과 괄호만 사용 (예: [서론], [본론], [결론])

응답 형식 (JSON):
{{
    "summary": "4-5문장의 핵심 요약. 주요 발견과 결론 포함. 마크다운 기호 없이 작성.",
    "key_points": ["핵심 발견 1 (출처)", "핵심 발견 2 (출처)", "핵심 발견 3", "핵심 발견 4", "핵심 발견 5", "핵심 발견 6", "핵심 발견 7"],
    "full_report": "일반 텍스트 형식의 학술 리포트. 마크다운 기호(#, **, *, -)를 절대 사용하지 않음. 줄바꿈으로 섹션 구분. 각 주장에 출처 명시. [서론], [본론], [결론] 섹션으로 구성. 최소 2500자."
}}"#,
        query, insights_text, sources_text
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.4,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    #[derive(Deserialize)]
    struct ReportResponse {
        summary: String,
        key_points: Vec<String>,
        full_report: String,
    }

    let json_text = extract_json(&text);
    let report: ReportResponse = serde_json::from_str(&json_text)
        .map_err(|e| format!("JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    Ok((report.summary, report.full_report, report.key_points, input_tokens, output_tokens, cost))
}

/// 네이버 검색 API 호출 (뉴스 중심)
pub async fn search_naver(
    client_id: &str,
    client_secret: &str,
    query: &str,
    display: u32,
) -> Result<Vec<SearchItem>, String> {
    let client = Client::new();
    let encoded_query = urlencoding::encode(query);

    // 뉴스 위주로 검색 (뉴스 20개, 블로그 5개, 웹 5개)
    let news_display = (display * 2).min(100);  // 뉴스는 2배로
    let other_display = (display / 2).max(5);   // 블로그/웹은 절반

    let news_url = format!(
        "https://openapi.naver.com/v1/search/news.json?query={}&display={}&sort=date",
        encoded_query, news_display
    );
    let blog_url = format!(
        "https://openapi.naver.com/v1/search/blog.json?query={}&display={}",
        encoded_query, other_display
    );
    let webkr_url = format!(
        "https://openapi.naver.com/v1/search/webkr.json?query={}&display={}",
        encoded_query, other_display
    );

    let mut results: Vec<SearchItem> = Vec::new();

    // 뉴스 검색 (가장 중요, 언론사 이름 포함)
    if let Ok(resp) = client
        .get(&news_url)
        .header("X-Naver-Client-Id", client_id)
        .header("X-Naver-Client-Secret", client_secret)
        .send()
        .await
    {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(items) = json.get("items").and_then(|v| v.as_array()) {
                for item in items {
                    // 언론사 도메인 추출
                    let link = item.get("originallink")
                        .or_else(|| item.get("link"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let domain = link.split('/').nth(2).unwrap_or("뉴스");

                    results.push(SearchItem {
                        title: clean_html(item.get("title").and_then(|v| v.as_str()).unwrap_or("")),
                        link: link.to_string(),
                        description: clean_html(item.get("description").and_then(|v| v.as_str()).unwrap_or("")),
                        source: format!("네이버뉴스 ({})", domain),
                    });
                }
            }
        }
    }

    // 블로그 검색 (블로거 이름 포함)
    if let Ok(resp) = client
        .get(&blog_url)
        .header("X-Naver-Client-Id", client_id)
        .header("X-Naver-Client-Secret", client_secret)
        .send()
        .await
    {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(items) = json.get("items").and_then(|v| v.as_array()) {
                for item in items {
                    let blogger = item.get("bloggername").and_then(|v| v.as_str()).unwrap_or("블로그");

                    results.push(SearchItem {
                        title: clean_html(item.get("title").and_then(|v| v.as_str()).unwrap_or("")),
                        link: item.get("link").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        description: clean_html(item.get("description").and_then(|v| v.as_str()).unwrap_or("")),
                        source: format!("네이버블로그 ({})", blogger),
                    });
                }
            }
        }
    }

    // 웹문서 검색
    if let Ok(resp) = client
        .get(&webkr_url)
        .header("X-Naver-Client-Id", client_id)
        .header("X-Naver-Client-Secret", client_secret)
        .send()
        .await
    {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(items) = json.get("items").and_then(|v| v.as_array()) {
                for item in items {
                    let link = item.get("link").and_then(|v| v.as_str()).unwrap_or("");
                    let domain = link.split('/').nth(2).unwrap_or("웹");

                    results.push(SearchItem {
                        title: clean_html(item.get("title").and_then(|v| v.as_str()).unwrap_or("")),
                        link: link.to_string(),
                        description: clean_html(item.get("description").and_then(|v| v.as_str()).unwrap_or("")),
                        source: format!("네이버웹 ({})", domain),
                    });
                }
            }
        }
    }

    Ok(results)
}

/// Google Custom Search API 호출
pub async fn search_google(
    api_key: &str,
    cx: &str, // Custom Search Engine ID
    query: &str,
    num: u32,
) -> Result<Vec<SearchItem>, String> {
    let client = Client::new();
    let encoded_query = urlencoding::encode(query);

    // Google API는 최대 10개까지만 지원
    let actual_num = num.min(10);

    let url = format!(
        "https://www.googleapis.com/customsearch/v1?key={}&cx={}&q={}&num={}",
        api_key, cx, encoded_query, actual_num
    );

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Google 검색 API 요청 실패: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Google 검색 응답 파싱 실패: {}", e))?;

    // API 오류 확인
    if let Some(error) = json.get("error") {
        let code = error.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
        let message = error.get("message").and_then(|v| v.as_str()).unwrap_or("알 수 없는 오류");
        return Err(format!("Google API 오류 ({}): {}", code, message));
    }

    let mut results: Vec<SearchItem> = Vec::new();

    if let Some(items) = json.get("items").and_then(|v| v.as_array()) {
        for item in items {
            // 도메인 추출하여 출처에 표시
            let link = item.get("link").and_then(|v| v.as_str()).unwrap_or("");
            let domain = link.split('/').nth(2).unwrap_or("google");

            results.push(SearchItem {
                title: item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                link: link.to_string(),
                description: item.get("snippet").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                source: format!("google ({})", domain),
            });
        }
    } else {
        // items가 없으면 검색 결과가 없는 것
        return Ok(Vec::new());
    }

    Ok(results)
}

/// 웹페이지 내용 가져오기 (Chromium 기반 - headless)
pub async fn fetch_page_content(url: &str) -> Result<String, String> {
    use tokio::time::{timeout, Duration};

    // 헤드리스 브라우저 사용 (백그라운드 실행)
    let browser = get_headless_browser().await?;

    // 15초 타임아웃으로 페이지 로드
    let page_result = timeout(Duration::from_secs(15), async {
        let page = browser
            .new_page(url)
            .await
            .map_err(|e| format!("페이지 생성 실패: {}", e))?;

        // 페이지 로드 대기
        page.wait_for_navigation()
            .await
            .map_err(|e| format!("페이지 로드 실패: {}", e))?;

        // HTML 내용 가져오기
        let html = page
            .content()
            .await
            .map_err(|e| format!("내용 가져오기 실패: {}", e))?;

        // 페이지 닫기
        let _ = page.close().await;

        Ok::<String, String>(html)
    })
    .await;

    let html = match page_result {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("페이지 로드 타임아웃 (15초)".to_string()),
    };

    // HTML에서 텍스트만 추출
    let text = extract_text_from_html(&html);

    // 최대 8000자로 제한
    Ok(text.chars().take(8000).collect())
}

/// HTML에서 텍스트 추출
fn extract_text_from_html(html: &str) -> String {
    // script, style 태그 제거
    let re_script = Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap();
    let re_style = Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap();
    let re_tags = Regex::new(r"<[^>]+>").unwrap();
    let re_whitespace = Regex::new(r"\s+").unwrap();

    let text = re_script.replace_all(html, "");
    let text = re_style.replace_all(&text, "");
    let text = re_tags.replace_all(&text, " ");
    let text = re_whitespace.replace_all(&text, " ");

    // HTML 엔티티 디코딩
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}

/// HTML 태그 제거 (검색 결과 정리용)
fn clean_html(text: &str) -> String {
    let re = Regex::new(r"<[^>]+>").unwrap();
    re.replace_all(text, "")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .to_string()
}

// ===== 데이터셋 분석 함수 =====

#[derive(Debug, Serialize, Deserialize)]
pub struct DatasetAnalysisResult {
    pub summary: String,
    pub insights: Vec<String>,
    pub statistics: Vec<(String, String)>,
    pub chart_data: Option<ChartDataResult>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChartDataResult {
    pub chart_type: String,
    pub title: String,
    pub labels: Vec<String>,
    pub values: Vec<f64>,
}

/// 데이터셋 분석
pub async fn analyze_dataset_data(
    gemini_api_key: &str,
    model: &str,
    dataset_name: &str,
    columns: &[String],
    rows: &[Vec<String>],
) -> Result<(DatasetAnalysisResult, i64, i64, f64), String> {
    let client = Client::new();
    let model = if model.is_empty() { "gemini-2.0-flash" } else { model };

    // 데이터 샘플 생성 (최대 100행)
    let sample_size = rows.len().min(100);
    let sample_rows: Vec<String> = rows.iter()
        .take(sample_size)
        .map(|r| r.join(" | "))
        .collect();

    let data_preview = format!(
        "컬럼: {}\n\n샘플 데이터 ({}행 중 {}행):\n{}",
        columns.join(" | "),
        rows.len(),
        sample_size,
        sample_rows.join("\n")
    );

    let prompt = format!(r#"당신은 데이터 분석 전문가입니다. 다음 데이터셋을 분석해주세요.

## 데이터셋 이름
{}

## 데이터
{}

## 분석 결과 (JSON 형식):
{{
    "summary": "데이터셋에 대한 전반적인 설명 (2-3문장)",
    "insights": [
        "인사이트 1: 데이터에서 발견한 중요한 패턴이나 특징",
        "인사이트 2: 주목할만한 통계적 특성",
        "인사이트 3: 활용 가능한 분석 방향",
        "인사이트 4: 데이터 품질 관련 관찰",
        "인사이트 5: 추가 분석 제안"
    ],
    "statistics": [
        ["총 행 수", "{}"],
        ["컬럼 수", "{}"],
        ["주요 컬럼", "가장 중요해 보이는 컬럼명"],
        ["데이터 유형", "수치/텍스트/날짜 등"],
        ["특이사항", "발견된 특이사항"]
    ],
    "chart_data": {{
        "chart_type": "bar",
        "title": "차트 제목",
        "labels": ["라벨1", "라벨2", "라벨3"],
        "values": [10, 20, 30]
    }}
}}

요구사항:
1. 데이터의 특성을 정확히 파악하여 분석
2. 실용적이고 actionable한 인사이트 제공
3. chart_data는 데이터에서 시각화할 수 있는 적절한 정보 선택
4. chart_type은 "bar", "line", "pie" 중 하나
5. 마크다운 기호(#, *, -, 등) 사용하지 않기
6. 한국어로 작성"#,
        dataset_name,
        data_preview,
        rows.len(),
        columns.len()
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, gemini_api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    #[derive(Deserialize)]
    struct AnalysisResponse {
        summary: String,
        insights: Vec<String>,
        statistics: Vec<Vec<String>>,
        chart_data: Option<ChartDataResult>,
    }

    let json_text = extract_json(&text);
    let analysis: AnalysisResponse = serde_json::from_str(&json_text)
        .map_err(|e| format!("분석 JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    let statistics: Vec<(String, String)> = analysis.statistics
        .into_iter()
        .filter(|s| s.len() >= 2)
        .map(|s| (s[0].clone(), s[1].clone()))
        .collect();

    Ok((
        DatasetAnalysisResult {
            summary: analysis.summary,
            insights: analysis.insights,
            statistics,
            chart_data: analysis.chart_data,
        },
        input_tokens,
        output_tokens,
        cost,
    ))
}

/// 데이터셋 질문 답변
pub async fn query_dataset_data(
    gemini_api_key: &str,
    model: &str,
    dataset_name: &str,
    columns: &[String],
    rows: &[Vec<String>],
    question: &str,
) -> Result<(String, Vec<usize>, i64, i64, f64), String> {
    let client = Client::new();
    let model = if model.is_empty() { "gemini-2.0-flash" } else { model };

    // 데이터 전체 (최대 300행)
    let data_rows: Vec<String> = rows.iter()
        .take(300)
        .enumerate()
        .map(|(i, r)| format!("[{}] {}", i, r.join(" | ")))
        .collect();

    let data_content = format!(
        "컬럼: {}\n\n데이터 ({}행):\n{}",
        columns.join(" | "),
        rows.len().min(300),
        data_rows.join("\n")
    );

    let prompt = format!(r#"당신은 데이터 분석 전문가입니다. 사용자의 질문에 데이터를 기반으로 답변해주세요.

## 데이터셋: {}

## 데이터
{}

## 사용자 질문
{}

## 응답 형식 (JSON):
{{
    "answer": "질문에 대한 상세하고 친절한 답변 (데이터 기반)",
    "relevant_row_indices": [0, 1, 2]
}}

요구사항:
1. 데이터에서 찾은 정보를 기반으로 정확하게 답변
2. 수치가 있다면 정확한 수치 제공
3. 관련된 행의 인덱스(0부터 시작)를 relevant_row_indices에 포함
4. 답변은 친절하고 이해하기 쉽게
5. 마크다운 기호(#, *, -, 등) 사용하지 않기
6. 한국어로 작성"#,
        dataset_name,
        data_content,
        question
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, gemini_api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    #[derive(Deserialize)]
    struct QueryResponse {
        answer: String,
        relevant_row_indices: Vec<usize>,
    }

    let json_text = extract_json(&text);
    let query_resp: QueryResponse = serde_json::from_str(&json_text)
        .map_err(|e| format!("응답 JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    Ok((
        query_resp.answer,
        query_resp.relevant_row_indices,
        input_tokens,
        output_tokens,
        cost,
    ))
}

// ===== AI 기반 데이터 추출 (Extract) =====

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtractResult {
    pub url: String,
    pub data: serde_json::Value,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

/// URL에서 스키마에 맞는 데이터 추출
pub async fn extract_data_from_url(
    gemini_api_key: &str,
    model: &str,
    url: &str,
    schema: &str,  // 사용자가 정의한 추출 스키마 (자연어 또는 JSON 형식)
) -> Result<ExtractResult, String> {
    // 1. 페이지 내용 가져오기
    let content = fetch_page_content(url).await?;

    if content.is_empty() {
        return Err("페이지 내용을 가져올 수 없습니다".to_string());
    }

    // 2. AI로 데이터 추출
    let client = Client::new();
    let model = if model.is_empty() { "gemini-2.0-flash" } else { model };

    let prompt = format!(
        r#"당신은 웹페이지에서 구조화된 데이터를 추출하는 전문가입니다.

다음 웹페이지 내용에서 사용자가 요청한 정보를 추출해주세요.

## 웹페이지 내용:
{}

## 추출 요청:
{}

## 지침:
1. 요청된 정보만 정확하게 추출
2. 페이지에 없는 정보는 null로 표시
3. 가능한 한 구조화된 형태로 반환
4. 리스트 형태의 데이터는 배열로 반환
5. 숫자는 숫자 타입으로, 날짜는 ISO 형식으로 반환

응답은 반드시 JSON 형식으로만 답변하세요.
JSON 외의 텍스트는 포함하지 마세요."#,
        content.chars().take(15000).collect::<String>(),
        schema
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, gemini_api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    // JSON 파싱
    let json_text = extract_json(&text);
    let data: serde_json::Value = serde_json::from_str(&json_text)
        .unwrap_or(serde_json::json!({"raw_text": text}));

    Ok(ExtractResult {
        url: url.to_string(),
        data,
        input_tokens,
        output_tokens,
        cost_usd: cost,
    })
}

/// 여러 URL에서 데이터 일괄 추출
pub async fn extract_data_batch(
    gemini_api_key: &str,
    model: &str,
    urls: &[String],
    schema: &str,
) -> Result<Vec<ExtractResult>, String> {
    let mut results = Vec::new();

    for url in urls {
        match extract_data_from_url(gemini_api_key, model, url, schema).await {
            Ok(result) => results.push(result),
            Err(e) => {
                // 실패해도 계속 진행, 에러는 로그만
                results.push(ExtractResult {
                    url: url.clone(),
                    data: serde_json::json!({"error": e}),
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: 0.0,
                });
            }
        }
    }

    Ok(results)
}

// ===== AI 브라우저 에이전트 =====

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum AgentActionType {
    Navigate,   // URL로 이동
    Click,      // 요소 클릭
    Type,       // 텍스트 입력
    Scroll,     // 스크롤
    Wait,       // 대기
    Extract,    // 데이터 추출
    Done,       // 작업 완료
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentAction {
    pub action_type: AgentActionType,
    pub selector: Option<String>,     // CSS 선택자 또는 텍스트
    pub value: Option<String>,        // 입력할 값 또는 URL
    pub reason: String,               // 이 액션을 선택한 이유
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentStep {
    pub step_number: usize,
    pub action: AgentAction,
    pub result: String,
    pub screenshot_base64: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentResult {
    pub goal: String,
    pub success: bool,
    pub steps: Vec<AgentStep>,
    pub final_data: Option<serde_json::Value>,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
}

/// AI가 다음 액션 결정
async fn decide_next_action(
    api_key: &str,
    model: &str,
    goal: &str,
    current_url: &str,
    page_elements: &str,
    page_text: &str,
    previous_steps: &[AgentStep],
) -> Result<(AgentAction, i64, i64, f64), String> {
    let client = Client::new();
    let model = if model.is_empty() { "gemini-2.0-flash" } else { model };

    let steps_summary: String = previous_steps
        .iter()
        .map(|s| format!("Step {}: {:?} - {}", s.step_number, s.action.action_type, s.result))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        r#"당신은 웹 브라우저를 조작하는 AI 에이전트입니다.
사용자의 목표를 달성하기 위해 다음에 수행할 액션을 결정하세요.

## 사용자 목표
{goal}

## 현재 상태
- URL: {current_url}
- 페이지 요소들: {page_elements}
- 페이지 내용 (일부): {page_text}

## 이전 단계들
{steps}

## 가능한 액션
1. Navigate: 새 URL로 이동 (value에 URL 지정)
2. Click: 요소 클릭 (selector에 CSS 선택자 또는 텍스트, value는 선택사항)
3. Type: 텍스트 입력 (selector에 입력 필드, value에 입력할 텍스트)
4. Scroll: 페이지 스크롤 (value에 "up" 또는 "down")
5. Wait: 잠시 대기 (value에 초 단위 숫자)
6. Extract: 현재 페이지에서 데이터 추출 (value에 추출할 정보 설명)
7. Done: 목표 달성 완료 (value에 결과 요약)

## 응답 형식 (JSON)
{{
    "action_type": "Navigate|Click|Type|Scroll|Wait|Extract|Done",
    "selector": "CSS 선택자 또는 클릭할 텍스트 (선택사항)",
    "value": "URL, 입력 텍스트, 또는 결과 (선택사항)",
    "reason": "이 액션을 선택한 이유"
}}

주의사항:
- 목표를 달성했으면 반드시 Done 액션을 선택하세요
- 로그인이 필요한 경우 사용자에게 알리고 Done으로 종료하세요
- 무한 루프를 피하세요 (같은 액션 반복 금지)
- 최대 15단계 내에 완료하세요"#,
        goal = goal,
        current_url = current_url,
        page_elements = page_elements.chars().take(3000).collect::<String>(),
        page_text = page_text.chars().take(2000).collect::<String>(),
        steps = if steps_summary.is_empty() { "없음".to_string() } else { steps_summary }
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "responseMimeType": "application/json"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("API 요청 실패: {}", e))?;

    let gemini_resp: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = gemini_resp
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or("응답 없음")?;

    let (input_tokens, output_tokens) = gemini_resp
        .usage_metadata
        .map(|u| (u.prompt_token_count, u.candidates_token_count))
        .unwrap_or((0, 0));

    let (input_price, output_price) = get_model_price(model);
    let cost = (input_tokens as f64 * input_price / 1_000_000.0)
        + (output_tokens as f64 * output_price / 1_000_000.0);

    #[derive(Deserialize)]
    struct ActionResponse {
        action_type: String,
        selector: Option<String>,
        value: Option<String>,
        reason: String,
    }

    let json_text = extract_json(&text);
    let action_resp: ActionResponse = serde_json::from_str(&json_text)
        .map_err(|e| format!("액션 JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    let action_type = match action_resp.action_type.to_lowercase().as_str() {
        "navigate" => AgentActionType::Navigate,
        "click" => AgentActionType::Click,
        "type" => AgentActionType::Type,
        "scroll" => AgentActionType::Scroll,
        "wait" => AgentActionType::Wait,
        "extract" => AgentActionType::Extract,
        "done" => AgentActionType::Done,
        _ => AgentActionType::Done,
    };

    Ok((
        AgentAction {
            action_type,
            selector: action_resp.selector,
            value: action_resp.value,
            reason: action_resp.reason,
        },
        input_tokens,
        output_tokens,
        cost,
    ))
}

/// 브라우저에서 액션 실행
use chromiumoxide::Page;

/// 단일 페이지에서 액션 실행 (페이지를 재사용)
async fn execute_action_on_page(
    page: &Page,
    current_url: &mut String,
    action: &AgentAction,
) -> Result<String, String> {
    use tokio::time::{sleep, Duration};

    match action.action_type {
        AgentActionType::Navigate => {
            let url = action.value.as_ref().ok_or("URL이 필요합니다")?;

            // 실제로 페이지 이동
            page.goto(url)
                .await
                .map_err(|e| format!("페이지 이동 실패: {}", e))?;

            // 페이지 로드 대기
            sleep(Duration::from_millis(2000)).await;

            *current_url = url.clone();
            Ok(format!("{}로 이동함", url))
        }

        AgentActionType::Click => {
            let selector = action.selector.as_ref().ok_or("선택자가 필요합니다")?;

            // 이전 하이라이트 제거
            let _ = page.evaluate(r#"
                document.querySelectorAll('.agent-highlight').forEach(el => {
                    el.style.outline = '';
                    el.classList.remove('agent-highlight');
                });
            "#).await;

            // 요소 찾기 및 하이라이트 (빨간 테두리) - 더 정확하게 찾기
            let find_js = format!(
                r#"
                (function() {{
                    const searchText = '{}';

                    // 이미 시도한 요소 제외
                    const triedElements = document.querySelectorAll('.agent-tried');

                    // 헬퍼 함수: 요소가 적합한지 확인
                    function isValidElement(el) {{
                        const rect = el.getBoundingClientRect();
                        // 너무 큰 요소 제외 (컨테이너일 가능성)
                        if (rect.width > 500 || rect.height > 200) return false;
                        // 보이지 않는 요소 제외
                        if (rect.width < 5 || rect.height < 5) return false;
                        // 이미 시도한 요소 제외
                        if (el.classList.contains('agent-tried')) return false;
                        return true;
                    }}

                    // 헬퍼 함수: 요소의 직접 텍스트 (자식 요소 텍스트 제외)
                    function getDirectText(el) {{
                        let text = '';
                        for (let node of el.childNodes) {{
                            if (node.nodeType === Node.TEXT_NODE) {{
                                text += node.textContent;
                            }}
                        }}
                        return text.trim();
                    }}

                    // 헬퍼 함수: 요소 하이라이트 및 결과 반환
                    function highlightAndReturn(el, method) {{
                        el.style.outline = '3px solid red';
                        el.style.outlineOffset = '2px';
                        el.classList.add('agent-highlight');
                        el.classList.add('agent-tried');
                        el.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                        const rect = el.getBoundingClientRect();
                        return JSON.stringify({{
                            found: true,
                            method: method,
                            tag: el.tagName,
                            text: (el.innerText || el.value || '').substring(0, 50),
                            id: el.id || '',
                            class: el.className || '',
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        }});
                    }}

                    // 1. CSS 선택자로 찾기 (가장 정확)
                    try {{
                        let el = document.querySelector('{}');
                        if (el && isValidElement(el)) {{
                            return highlightAndReturn(el, 'CSS 선택자');
                        }}
                    }} catch(e) {{}}

                    // 2. 버튼/링크에서 정확한 텍스트 매칭 (우선순위 높음)
                    const priorityElements = document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]');
                    for (let e of priorityElements) {{
                        if (!isValidElement(e)) continue;
                        const text = (e.innerText || e.value || '').trim().toLowerCase();
                        // 정확히 일치하거나 매우 유사
                        if (text === searchText.toLowerCase() || text.includes(searchText.toLowerCase())) {{
                            return highlightAndReturn(e, '버튼/링크 텍스트');
                        }}
                    }}

                    // 3. aria-label로 찾기
                    const ariaElements = document.querySelectorAll('[aria-label]');
                    for (let e of ariaElements) {{
                        if (!isValidElement(e)) continue;
                        const label = e.getAttribute('aria-label').toLowerCase();
                        if (label.includes(searchText.toLowerCase())) {{
                            return highlightAndReturn(e, 'aria-label');
                        }}
                    }}

                    // 4. title 속성으로 찾기
                    const titleElements = document.querySelectorAll('[title]');
                    for (let e of titleElements) {{
                        if (!isValidElement(e)) continue;
                        const title = e.getAttribute('title').toLowerCase();
                        if (title.includes(searchText.toLowerCase())) {{
                            return highlightAndReturn(e, 'title 속성');
                        }}
                    }}

                    // 5. 작은 요소에서 텍스트 찾기 (span, label 등)
                    const smallElements = document.querySelectorAll('span, label, li, td, th, h1, h2, h3, h4, h5, h6, p');
                    for (let e of smallElements) {{
                        if (!isValidElement(e)) continue;
                        const directText = getDirectText(e);
                        if (directText.toLowerCase().includes(searchText.toLowerCase())) {{
                            return highlightAndReturn(e, '텍스트 (small)');
                        }}
                    }}

                    // 6. 마지막으로 div에서 찾기 (작은 것만)
                    const divs = document.querySelectorAll('div');
                    for (let e of divs) {{
                        const rect = e.getBoundingClientRect();
                        // div는 더 엄격하게 필터링
                        if (rect.width > 300 || rect.height > 100) continue;
                        if (!isValidElement(e)) continue;
                        const directText = getDirectText(e);
                        if (directText.toLowerCase().includes(searchText.toLowerCase())) {{
                            return highlightAndReturn(e, '텍스트 (div)');
                        }}
                    }}

                    return JSON.stringify({{ found: false, method: 'none', searched: searchText }});
                }})()
                "#,
                selector.replace("'", "\\'").replace("\"", "\\\"").replace("\n", " "),
                selector.replace("'", "\\'").replace("\"", "\\\"").replace("\n", " ")
            );

            let find_result = page
                .evaluate(find_js.as_str())
                .await
                .map_err(|e| format!("요소 찾기 실패: {}", e))?;

            let result_str = find_result.into_value::<String>().unwrap_or_default();
            let result_json: serde_json::Value = serde_json::from_str(&result_str)
                .unwrap_or(serde_json::json!({"found": false}));

            if !result_json["found"].as_bool().unwrap_or(false) {
                return Err(format!("'{}' 요소를 찾을 수 없음 (CSS/텍스트/aria-label 검색 실패)", selector));
            }

            let element_info = format!(
                "[{}] <{}> '{}' (id={}, class={})",
                result_json["method"].as_str().unwrap_or(""),
                result_json["tag"].as_str().unwrap_or(""),
                result_json["text"].as_str().unwrap_or(""),
                result_json["id"].as_str().unwrap_or("없음"),
                result_json["class"].as_str().unwrap_or("없음").chars().take(30).collect::<String>()
            );

            // 하이라이트 후 잠시 대기 (사용자가 볼 수 있도록)
            sleep(Duration::from_millis(1000)).await;

            // 클릭 실행
            let do_click_js = r#"
                (function() {
                    const el = document.querySelector('.agent-highlight');
                    if (el) {
                        el.click();
                        return 'clicked';
                    }
                    return 'no highlighted element';
                })()
            "#;

            let click_result = page
                .evaluate(do_click_js)
                .await
                .map_err(|e| format!("클릭 실패: {}", e))?;

            // 클릭 후 페이지 로드 대기
            sleep(Duration::from_millis(1500)).await;

            // URL 업데이트
            if let Ok(Some(new_url)) = page.url().await {
                *current_url = new_url.to_string();
            }

            Ok(format!("발견: {} → {}", element_info, click_result.into_value::<String>().unwrap_or_default()))
        }

        AgentActionType::Type => {
            let selector = action.selector.as_ref().ok_or("입력 필드 선택자가 필요합니다")?;
            let text = action.value.as_ref().ok_or("입력할 텍스트가 필요합니다")?;

            // 이전 하이라이트 제거
            let _ = page.evaluate(r#"
                document.querySelectorAll('.agent-highlight').forEach(el => {
                    el.style.outline = '';
                    el.classList.remove('agent-highlight');
                });
            "#).await;

            // 입력 필드 찾아서 하이라이트 및 포커스
            let focus_js = format!(
                r#"
                (function() {{
                    // CSS 선택자로 찾기
                    let el = document.querySelector('{}');
                    if (el) {{
                        el.style.outline = '3px solid red';
                        el.style.outlineOffset = '2px';
                        el.classList.add('agent-highlight');
                        el.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                        el.focus();
                        el.value = '';
                        return JSON.stringify({{
                            found: true,
                            method: 'CSS 선택자',
                            tag: el.tagName,
                            placeholder: el.placeholder || '',
                            id: el.id || '',
                            name: el.name || ''
                        }});
                    }}

                    // 검색어로 input 찾기
                    const searchText = '{}';
                    const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"]');
                    for (let e of inputs) {{
                        const placeholder = (e.placeholder || '').toLowerCase();
                        const name = (e.name || '').toLowerCase();
                        const ariaLabel = (e.getAttribute('aria-label') || '').toLowerCase();

                        if (placeholder.includes(searchText.toLowerCase()) ||
                            name.includes(searchText.toLowerCase()) ||
                            ariaLabel.includes(searchText.toLowerCase())) {{
                            e.style.outline = '3px solid red';
                            e.style.outlineOffset = '2px';
                            e.classList.add('agent-highlight');
                            e.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                            e.focus();
                            e.value = '';
                            return JSON.stringify({{
                                found: true,
                                method: '속성 검색',
                                tag: e.tagName,
                                placeholder: e.placeholder || '',
                                id: e.id || '',
                                name: e.name || ''
                            }});
                        }}
                    }}

                    // 첫 번째 보이는 input 필드 찾기 (폴백)
                    for (let e of inputs) {{
                        const rect = e.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {{
                            e.style.outline = '3px solid orange';
                            e.style.outlineOffset = '2px';
                            e.classList.add('agent-highlight');
                            e.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                            e.focus();
                            e.value = '';
                            return JSON.stringify({{
                                found: true,
                                method: '폴백 (첫번째 입력필드)',
                                tag: e.tagName,
                                placeholder: e.placeholder || '',
                                id: e.id || '',
                                name: e.name || ''
                            }});
                        }}
                    }}

                    return JSON.stringify({{ found: false }});
                }})()
                "#,
                selector.replace("'", "\\'").replace("\"", "\\\"").replace("\n", " "),
                selector.replace("'", "\\'").replace("\"", "\\\"").replace("\n", " ")
            );

            let focus_result = page
                .evaluate(focus_js.as_str())
                .await
                .map_err(|e| format!("입력 필드 찾기 실패: {}", e))?;

            let result_str = focus_result.into_value::<String>().unwrap_or_default();
            let result_json: serde_json::Value = serde_json::from_str(&result_str)
                .unwrap_or(serde_json::json!({"found": false}));

            if !result_json["found"].as_bool().unwrap_or(false) {
                return Err(format!("'{}' 입력 필드를 찾을 수 없음", selector));
            }

            let field_info = format!(
                "[{}] <{}> placeholder='{}' (id={}, name={})",
                result_json["method"].as_str().unwrap_or(""),
                result_json["tag"].as_str().unwrap_or(""),
                result_json["placeholder"].as_str().unwrap_or(""),
                result_json["id"].as_str().unwrap_or("없음"),
                result_json["name"].as_str().unwrap_or("없음")
            );

            // 하이라이트 후 대기
            sleep(Duration::from_millis(800)).await;

            // 텍스트 입력
            let type_js = format!(
                r#"
                (function() {{
                    let el = document.activeElement;
                    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {{
                        el.value = '{}';
                        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                        return 'typed';
                    }}
                    // contenteditable 처리
                    if (el && el.getAttribute('contenteditable') === 'true') {{
                        el.innerText = '{}';
                        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        return 'typed (contenteditable)';
                    }}
                    return 'no active input';
                }})()
                "#,
                text.replace("'", "\\'").replace("\"", "\\\"").replace("\n", "\\n"),
                text.replace("'", "\\'").replace("\"", "\\\"").replace("\n", "\\n")
            );

            let result = page
                .evaluate(type_js.as_str())
                .await
                .map_err(|e| format!("입력 실패: {}", e))?;

            sleep(Duration::from_millis(500)).await;

            Ok(format!("발견: {} → '{}' 입력 완료 ({})", field_info, text, result.into_value::<String>().unwrap_or_default()))
        }

        AgentActionType::Scroll => {
            let direction = action.value.as_deref().unwrap_or("down");

            let scroll_js = format!(
                r#"
                (function() {{
                    const amount = {};
                    window.scrollBy({{ top: amount, behavior: 'smooth' }});
                    return 'scrolled';
                }})()
                "#,
                if direction == "up" { -500 } else { 500 }
            );

            page.evaluate(scroll_js.as_str())
                .await
                .map_err(|e| format!("스크롤 실패: {}", e))?;

            sleep(Duration::from_millis(800)).await;

            Ok(format!("{}로 스크롤함", direction))
        }

        AgentActionType::Wait => {
            let seconds: u64 = action.value
                .as_ref()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2);
            sleep(Duration::from_secs(seconds.min(10))).await;
            Ok(format!("{}초 대기함", seconds))
        }

        AgentActionType::Extract => {
            let extract_js = r#"
                (function() {
                    return document.body.innerText.substring(0, 3000);
                })()
            "#;

            let result = page
                .evaluate(extract_js)
                .await
                .map_err(|e| format!("추출 실패: {}", e))?;

            let text = result.into_value::<String>().unwrap_or_default();
            Ok(format!("페이지에서 데이터 추출: {}", text.chars().take(500).collect::<String>()))
        }

        AgentActionType::Done => {
            Ok(action.value.clone().unwrap_or_else(|| "작업 완료".to_string()))
        }
    }
}

/// 페이지에서 요소 정보 가져오기 (기존 페이지 재사용)
async fn get_page_elements_from_page(page: &Page) -> Result<String, String> {
    let js = r#"
        (function() {
            const elements = [];
            const interactiveElements = document.querySelectorAll('a, button, input, textarea, select, [onclick], [role="button"]');

            for (let i = 0; i < Math.min(interactiveElements.length, 50); i++) {
                const el = interactiveElements[i];
                const rect = el.getBoundingClientRect();

                // 화면에 보이는 요소만
                if (rect.width > 0 && rect.height > 0) {
                    elements.push({
                        tag: el.tagName.toLowerCase(),
                        id: el.id || null,
                        class: el.className || null,
                        text: (el.innerText || el.value || '').substring(0, 100),
                        placeholder: el.placeholder || null,
                        type: el.type || null,
                        href: el.href || null,
                        name: el.name || null
                    });
                }
            }
            return JSON.stringify(elements);
        })()
    "#;

    let result = page
        .evaluate(js)
        .await
        .map_err(|e| format!("요소 가져오기 실패: {}", e))?;

    Ok(result.into_value::<String>().unwrap_or_else(|_| "[]".to_string()))
}

/// 페이지에서 텍스트 가져오기 (기존 페이지 재사용)
async fn get_page_text_from_page(page: &Page) -> Result<String, String> {
    let js = r#"
        (function() {
            return document.body.innerText.substring(0, 5000);
        })()
    "#;

    let result = page
        .evaluate(js)
        .await
        .map_err(|e| format!("텍스트 가져오기 실패: {}", e))?;

    Ok(result.into_value::<String>().unwrap_or_else(|_| "".to_string()))
}

/// AI 에이전트 실행 (메인 루프) - 진행 상황 콜백 포함
pub async fn run_agent<F>(
    gemini_api_key: &str,
    model: &str,
    goal: &str,
    start_url: &str,
    max_steps: usize,
    mut on_progress: F,
) -> Result<AgentResult, String>
where
    F: FnMut(&AgentStep) + Send,
{
    use tokio::time::{sleep, Duration};

    let browser = get_browser().await?;
    let mut current_url = start_url.to_string();
    let mut steps: Vec<AgentStep> = Vec::new();
    let mut total_input_tokens: i64 = 0;
    let mut total_output_tokens: i64 = 0;
    let mut total_cost: f64 = 0.0;
    let max_steps = max_steps.min(15); // 최대 15단계로 제한

    // 단일 페이지 생성 및 시작 URL로 이동
    let page = browser
        .new_page(start_url)
        .await
        .map_err(|e| format!("페이지 열기 실패: {}", e))?;

    // 페이지 로드 대기
    sleep(Duration::from_millis(3000)).await;

    for step_num in 1..=max_steps {
        // 각 단계 시작 전 잠시 대기 (안정성을 위해)
        sleep(Duration::from_millis(1500)).await;

        // 1. 현재 페이지 상태 가져오기 (동일한 페이지에서)
        let page_elements = get_page_elements_from_page(&page)
            .await
            .unwrap_or_else(|_| "[]".to_string());

        let page_text = get_page_text_from_page(&page)
            .await
            .unwrap_or_else(|_| "페이지 로드 실패".to_string());

        // 현재 URL 업데이트
        if let Ok(Some(url)) = page.url().await {
            current_url = url.to_string();
        }

        // 2. AI가 다음 액션 결정
        let (action, input_tokens, output_tokens, cost) = decide_next_action(
            gemini_api_key,
            model,
            goal,
            &current_url,
            &page_elements,
            &page_text,
            &steps,
        )
        .await?;

        total_input_tokens += input_tokens;
        total_output_tokens += output_tokens;
        total_cost += cost;

        // 3. 액션 실행 (동일한 페이지에서)
        let result = execute_action_on_page(&page, &mut current_url, &action)
            .await
            .unwrap_or_else(|e| format!("액션 실행 실패: {}", e));

        // 액션 실행 후 대기 (페이지 로딩 및 렌더링 대기)
        sleep(Duration::from_millis(1500)).await;

        // 4. 단계 기록
        let step = AgentStep {
            step_number: step_num,
            action: action.clone(),
            result: result.clone(),
            screenshot_base64: None,
        };

        // 진행 상황 콜백 호출
        on_progress(&step);

        steps.push(step);

        // 5. Done 액션이면 종료
        if matches!(action.action_type, AgentActionType::Done) {
            // 페이지 닫기
            let _ = page.close().await;

            return Ok(AgentResult {
                goal: goal.to_string(),
                success: true,
                steps,
                final_data: action.value.as_ref().map(|v| serde_json::json!({"result": v})),
                total_input_tokens,
                total_output_tokens,
                total_cost_usd: total_cost,
            });
        }
    }

    // 페이지 닫기
    let _ = page.close().await;

    // 최대 단계 초과
    Ok(AgentResult {
        goal: goal.to_string(),
        success: false,
        steps,
        final_data: Some(serde_json::json!({"error": "최대 단계 수 초과"})),
        total_input_tokens,
        total_output_tokens,
        total_cost_usd: total_cost,
    })
}

// ===== Google Slides API =====

/// Google OAuth2 토큰 저장소
static GOOGLE_TOKENS: Lazy<Mutex<Option<GoogleTokens>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SlideContent {
    pub title: String,
    pub content: Vec<String>,
}

/// Google OAuth2 인증 URL 생성
pub fn get_google_auth_url(client_id: &str) -> String {
    let redirect_uri = "http://localhost:8585/callback";
    let scope = "https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive.file";

    format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(scope)
    )
}

/// OAuth2 코드를 토큰으로 교환
pub async fn exchange_google_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> Result<GoogleTokens, String> {
    let client = Client::new();

    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", "http://localhost:8585/callback"),
        ])
        .send()
        .await
        .map_err(|e| format!("토큰 교환 요청 실패: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("토큰 교환 실패: {}", error_text));
    }

    let token_response: serde_json::Value = response.json().await
        .map_err(|e| format!("토큰 응답 파싱 실패: {}", e))?;

    let access_token = token_response["access_token"]
        .as_str()
        .ok_or("access_token 없음")?
        .to_string();

    let refresh_token = token_response["refresh_token"]
        .as_str()
        .map(|s| s.to_string());

    let expires_in = token_response["expires_in"]
        .as_i64()
        .unwrap_or(3600);

    let tokens = GoogleTokens {
        access_token,
        refresh_token,
        expires_at: chrono::Utc::now().timestamp() + expires_in,
    };

    // 토큰 저장
    let mut token_lock = GOOGLE_TOKENS.lock().await;
    *token_lock = Some(tokens.clone());

    Ok(tokens)
}

/// 토큰 새로고침
pub async fn refresh_google_token(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<GoogleTokens, String> {
    let client = Client::new();

    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("토큰 새로고침 요청 실패: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("토큰 새로고침 실패: {}", error_text));
    }

    let token_response: serde_json::Value = response.json().await
        .map_err(|e| format!("토큰 응답 파싱 실패: {}", e))?;

    let access_token = token_response["access_token"]
        .as_str()
        .ok_or("access_token 없음")?
        .to_string();

    let expires_in = token_response["expires_in"]
        .as_i64()
        .unwrap_or(3600);

    let tokens = GoogleTokens {
        access_token,
        refresh_token: Some(refresh_token.to_string()),
        expires_at: chrono::Utc::now().timestamp() + expires_in,
    };

    let mut token_lock = GOOGLE_TOKENS.lock().await;
    *token_lock = Some(tokens.clone());

    Ok(tokens)
}

/// 리서치 결과를 Google Slides로 생성
pub async fn create_slides_from_research(
    access_token: &str,
    title: &str,
    slides: &[SlideContent],
) -> Result<(String, String), String> {
    let client = Client::new();

    // 1. 빈 프레젠테이션 생성
    let create_response = client
        .post("https://slides.googleapis.com/v1/presentations")
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&json!({
            "title": title
        }))
        .send()
        .await
        .map_err(|e| format!("프레젠테이션 생성 실패: {}", e))?;

    if !create_response.status().is_success() {
        let error_text = create_response.text().await.unwrap_or_default();
        return Err(format!("프레젠테이션 생성 실패: {}", error_text));
    }

    let presentation: serde_json::Value = create_response.json().await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let presentation_id = presentation["presentationId"]
        .as_str()
        .ok_or("presentationId 없음")?;

    // 2. 슬라이드 추가 요청 생성
    let mut requests: Vec<serde_json::Value> = Vec::new();

    for (idx, slide) in slides.iter().enumerate() {
        let slide_id = format!("slide_{}", idx);
        let title_id = format!("title_{}", idx);
        let body_id = format!("body_{}", idx);

        // 슬라이드 생성
        requests.push(json!({
            "createSlide": {
                "objectId": slide_id,
                "insertionIndex": idx + 1,
                "slideLayoutReference": {
                    "predefinedLayout": "TITLE_AND_BODY"
                },
                "placeholderIdMappings": [
                    {
                        "layoutPlaceholder": { "type": "TITLE" },
                        "objectId": title_id
                    },
                    {
                        "layoutPlaceholder": { "type": "BODY" },
                        "objectId": body_id
                    }
                ]
            }
        }));

        // 제목 텍스트 삽입
        requests.push(json!({
            "insertText": {
                "objectId": title_id,
                "text": slide.title
            }
        }));

        // 본문 텍스트 삽입
        let body_text = slide.content.iter()
            .map(|s| format!("• {}", s))
            .collect::<Vec<_>>()
            .join("\n");

        requests.push(json!({
            "insertText": {
                "objectId": body_id,
                "text": body_text
            }
        }));
    }

    // 3. 배치 업데이트 실행
    let update_response = client
        .post(format!(
            "https://slides.googleapis.com/v1/presentations/{}:batchUpdate",
            presentation_id
        ))
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&json!({
            "requests": requests
        }))
        .send()
        .await
        .map_err(|e| format!("슬라이드 업데이트 실패: {}", e))?;

    if !update_response.status().is_success() {
        let error_text = update_response.text().await.unwrap_or_default();
        return Err(format!("슬라이드 업데이트 실패: {}", error_text));
    }

    // 프레젠테이션 ID와 URL 반환
    let presentation_url = format!("https://docs.google.com/presentation/d/{}/edit", presentation_id);
    Ok((presentation_id.to_string(), presentation_url))
}

/// 저장된 Google 토큰 가져오기
pub async fn get_google_tokens() -> Option<GoogleTokens> {
    let token_lock = GOOGLE_TOKENS.lock().await;
    token_lock.clone()
}

/// Google 토큰 저장
pub async fn set_google_tokens(tokens: GoogleTokens) {
    let mut token_lock = GOOGLE_TOKENS.lock().await;
    *token_lock = Some(tokens);
}

// ===== 데이터 수집 기능 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectedData {
    pub url: String,
    pub title: String,
    pub tables: Vec<TableData>,
    pub numbers: Vec<NumberData>,
    pub lists: Vec<Vec<String>>,
    pub raw_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableData {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NumberData {
    pub label: String,
    pub value: String,
    pub unit: Option<String>,
}

/// 웹 페이지에서 데이터 수집
pub async fn collect_web_data(url: &str) -> Result<CollectedData, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {}", e))?;

    let response = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .send()
        .await
        .map_err(|e| format!("페이지 요청 실패: {}", e))?;

    let html = response.text().await
        .map_err(|e| format!("HTML 읽기 실패: {}", e))?;

    // HTML 파싱
    let document = scraper::Html::parse_document(&html);

    // 제목 추출
    let title_selector = scraper::Selector::parse("title").unwrap();
    let title = document.select(&title_selector)
        .next()
        .map(|el| el.text().collect::<String>())
        .unwrap_or_default();

    // 테이블 추출
    let table_selector = scraper::Selector::parse("table").unwrap();
    let tr_selector = scraper::Selector::parse("tr").unwrap();
    let th_selector = scraper::Selector::parse("th").unwrap();
    let td_selector = scraper::Selector::parse("td").unwrap();

    let mut tables: Vec<TableData> = Vec::new();
    for table in document.select(&table_selector) {
        let mut headers: Vec<String> = Vec::new();
        let mut rows: Vec<Vec<String>> = Vec::new();

        for (idx, row) in table.select(&tr_selector).enumerate() {
            let ths: Vec<String> = row.select(&th_selector)
                .map(|th| th.text().collect::<String>().trim().to_string())
                .collect();

            if !ths.is_empty() && headers.is_empty() {
                headers = ths;
                continue;
            }

            let tds: Vec<String> = row.select(&td_selector)
                .map(|td| td.text().collect::<String>().trim().to_string())
                .collect();

            if !tds.is_empty() {
                if headers.is_empty() && idx == 0 {
                    headers = tds;
                } else {
                    rows.push(tds);
                }
            }
        }

        if !headers.is_empty() || !rows.is_empty() {
            tables.push(TableData { headers, rows });
        }
    }

    // 숫자 데이터 추출 (라벨: 숫자 패턴)
    let mut numbers: Vec<NumberData> = Vec::new();
    let number_regex = regex::Regex::new(r"([가-힣a-zA-Z\s]+)[:\s]+([0-9,]+\.?[0-9]*)\s*(%|원|달러|USD|KRW|명|개|건)?").unwrap();
    let body_selector = scraper::Selector::parse("body").unwrap();

    if let Some(body) = document.select(&body_selector).next() {
        let text = body.text().collect::<String>();
        for cap in number_regex.captures_iter(&text) {
            let label = cap.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
            let value = cap.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
            let unit = cap.get(3).map(|m| m.as_str().to_string());

            if !label.is_empty() && label.len() < 50 && !value.is_empty() {
                numbers.push(NumberData { label, value, unit });
            }
        }
    }

    // 리스트 추출
    let mut lists: Vec<Vec<String>> = Vec::new();
    let ul_selector = scraper::Selector::parse("ul, ol").unwrap();
    let li_selector = scraper::Selector::parse("li").unwrap();

    for list in document.select(&ul_selector) {
        let items: Vec<String> = list.select(&li_selector)
            .map(|li| li.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty() && s.len() < 500)
            .collect();

        if items.len() >= 2 && items.len() <= 50 {
            lists.push(items);
        }
    }

    // Raw text 추출
    let raw_text = document.select(&body_selector)
        .next()
        .map(|b| b.text().collect::<String>())
        .unwrap_or_default()
        .split_whitespace()
        .take(1000)
        .collect::<Vec<_>>()
        .join(" ");

    Ok(CollectedData {
        url: url.to_string(),
        title,
        tables,
        numbers,
        lists,
        raw_text,
    })
}

/// Google Sheets로 데이터 내보내기
pub async fn export_to_google_sheets(
    access_token: &str,
    title: &str,
    data: &[CollectedData],
) -> Result<String, String> {
    let client = Client::new();

    // 1. 새 스프레드시트 생성
    let create_response = client
        .post("https://sheets.googleapis.com/v4/spreadsheets")
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&json!({
            "properties": {
                "title": title
            }
        }))
        .send()
        .await
        .map_err(|e| format!("스프레드시트 생성 실패: {}", e))?;

    if !create_response.status().is_success() {
        let error = create_response.text().await.unwrap_or_default();
        return Err(format!("스프레드시트 생성 실패: {}", error));
    }

    let spreadsheet: serde_json::Value = create_response.json().await
        .map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let spreadsheet_id = spreadsheet["spreadsheetId"]
        .as_str()
        .ok_or("spreadsheetId 없음")?;

    // 2. 데이터 준비
    let mut all_rows: Vec<Vec<serde_json::Value>> = Vec::new();

    for collected in data {
        // 출처 헤더
        all_rows.push(vec![json!(format!("=== {} ===", collected.title)), json!(""), json!("")]);
        all_rows.push(vec![json!(collected.url), json!(""), json!("")]);
        all_rows.push(vec![json!(""), json!(""), json!("")]);

        // 테이블 데이터
        for table in &collected.tables {
            if !table.headers.is_empty() {
                all_rows.push(table.headers.iter().map(|h| json!(h)).collect());
            }
            for row in &table.rows {
                all_rows.push(row.iter().map(|c| json!(c)).collect());
            }
            all_rows.push(vec![json!(""), json!(""), json!("")]);
        }

        // 숫자 데이터
        if !collected.numbers.is_empty() {
            all_rows.push(vec![json!("항목"), json!("값"), json!("단위")]);
            for num in &collected.numbers {
                all_rows.push(vec![
                    json!(&num.label),
                    json!(&num.value),
                    json!(num.unit.as_deref().unwrap_or(""))
                ]);
            }
            all_rows.push(vec![json!(""), json!(""), json!("")]);
        }
    }

    // 3. 데이터 쓰기
    let _write_response = client
        .put(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{}/values/A1?valueInputOption=RAW",
            spreadsheet_id
        ))
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&json!({
            "values": all_rows
        }))
        .send()
        .await
        .map_err(|e| format!("데이터 쓰기 실패: {}", e))?;

    Ok(format!("https://docs.google.com/spreadsheets/d/{}/edit", spreadsheet_id))
}

// ===== 파일 컨설팅 기능 =====

/// 파일 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub file_type: String,
    pub extension: String,
    pub modified: String,
}

/// 폴더 분석 결과
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderAnalysis {
    pub path: String,
    pub name: String,
    pub total_size: u64,
    pub file_count: u64,
    pub folder_count: u64,
    pub largest_files: Vec<FileInfo>,
    pub file_type_breakdown: std::collections::HashMap<String, TypeStats>,
}

/// 파일 유형별 통계
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeStats {
    pub count: u64,
    pub total_size: u64,
    pub percentage: f64,
}

/// 의심스러운 파일 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuspiciousFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub reason: String,
    pub risk_level: String, // "low", "medium", "high"
}

/// 파일 컨설팅 전체 결과
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileConsultingResult {
    pub total_scanned: u64,
    pub total_size: u64,
    pub total_folders: u64,
    pub folders: Vec<FolderAnalysis>,
    pub recommendations: Vec<String>,
    pub duplicates: Vec<DuplicateGroup>,
    pub large_files: Vec<FileInfo>,
    pub old_files: Vec<FileInfo>,
    pub type_summary: std::collections::HashMap<String, TypeStats>,
    pub videos: Vec<FileInfo>,
    pub suspicious_files: Vec<SuspiciousFile>,
}

/// 중복 파일 그룹
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateGroup {
    pub size: u64,
    pub files: Vec<String>,
}

/// 파일 확장자로 유형 분류
fn get_file_type(extension: &str) -> String {
    let ext = extension.to_lowercase();
    match ext.as_str() {
        // 이미지
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "svg" | "ico" | "heic" | "heif" | "tiff" | "raw" => "🖼️ 이미지".to_string(),
        // 동영상
        "mp4" | "avi" | "mov" | "mkv" | "wmv" | "flv" | "webm" | "m4v" => "🎬 동영상".to_string(),
        // 오디오
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" => "🎵 오디오".to_string(),
        // 문서
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "odt" | "ods" | "odp" => "📄 문서".to_string(),
        // 압축
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" => "📦 압축파일".to_string(),
        // 코드
        "js" | "ts" | "py" | "java" | "cpp" | "c" | "h" | "rs" | "go" | "rb" | "php" | "html" | "css" | "json" | "xml" | "yaml" | "yml" => "💻 코드".to_string(),
        // 실행파일
        "exe" | "app" | "dmg" | "pkg" | "msi" | "deb" | "rpm" => "⚙️ 실행파일".to_string(),
        // 데이터
        "db" | "sqlite" | "sql" | "csv" => "🗃️ 데이터".to_string(),
        _ => "📎 기타".to_string(),
    }
}

/// 파일 크기를 읽기 좋은 형식으로 변환
pub fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    const TB: u64 = GB * 1024;

    if bytes >= TB {
        format!("{:.2} TB", bytes as f64 / TB as f64)
    } else if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// 디렉토리 스캔 및 분석 (상세 콜백 버전 - 취소 가능)
pub async fn scan_directory_with_details_cancellable<F, C>(
    path: &str,
    mut on_file: F,
    is_cancelled: C,
) -> Result<FileConsultingResult, String>
where
    F: FnMut(String, u64, bool) + Send + 'static, // (path, size, is_folder)
    C: Fn() -> bool + Send + 'static, // 취소 체크 함수
{
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;

    let root_path = Path::new(path);
    if !root_path.exists() {
        return Err(format!("경로가 존재하지 않습니다: {}", path));
    }

    let mut all_files: Vec<FileInfo> = Vec::new();
    let mut total_folders: u64 = 0;
    let mut type_summary: HashMap<String, TypeStats> = HashMap::new();
    let mut size_map: HashMap<u64, Vec<String>> = HashMap::new();

    // 스택 기반 반복 (콜백 호출 가능)
    let mut stack = vec![(root_path.to_path_buf(), 0usize)];
    let mut cancelled = false;

    while let Some((dir, depth)) = stack.pop() {
        // 취소 체크
        if is_cancelled() {
            cancelled = true;
            break;
        }

        if depth > 10 {
            continue;
        }

        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                // 취소 체크 (파일 단위)
                if is_cancelled() {
                    cancelled = true;
                    break;
                }

                let path = entry.path();

                if let Some(name) = path.file_name() {
                    if name.to_string_lossy().starts_with('.') {
                        continue;
                    }
                }

                if path.is_dir() {
                    total_folders += 1;
                    on_file(path.to_string_lossy().to_string(), 0, true);
                    stack.push((path, depth + 1));
                } else if path.is_file() {
                    if let Ok(metadata) = fs::metadata(&path) {
                        let size = metadata.len();
                        let extension = path
                            .extension()
                            .map(|e| e.to_string_lossy().to_string())
                            .unwrap_or_default();

                        let modified = metadata
                            .modified()
                            .ok()
                            .and_then(|t| {
                                let datetime: chrono::DateTime<chrono::Local> = t.into();
                                Some(datetime.format("%Y-%m-%d").to_string())
                            })
                            .unwrap_or_else(|| "알 수 없음".to_string());

                        let file_info = FileInfo {
                            path: path.to_string_lossy().to_string(),
                            name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                            size,
                            file_type: get_file_type(&extension),
                            extension,
                            modified,
                        };

                        on_file(file_info.path.clone(), size, false);

                        if size > 1024 * 1024 {
                            size_map
                                .entry(size)
                                .or_insert_with(Vec::new)
                                .push(file_info.path.clone());
                        }

                        all_files.push(file_info);
                    }
                }
            }
        }
    }

    let total_files = all_files.len() as u64;
    let total_size: u64 = all_files.iter().map(|f| f.size).sum();

    // 유형별 통계 계산
    for file in &all_files {
        let entry = type_summary
            .entry(file.file_type.clone())
            .or_insert(TypeStats {
                count: 0,
                total_size: 0,
                percentage: 0.0,
            });
        entry.count += 1;
        entry.total_size += file.size;
    }

    for stats in type_summary.values_mut() {
        if total_size > 0 {
            stats.percentage = (stats.total_size as f64 / total_size as f64) * 100.0;
        }
    }

    let duplicates: Vec<DuplicateGroup> = size_map
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .map(|(size, files)| DuplicateGroup { size, files })
        .collect();

    let mut large_files = all_files.clone();
    large_files.sort_by(|a, b| b.size.cmp(&a.size));
    large_files.truncate(20);

    let one_year_ago = chrono::Local::now() - chrono::Duration::days(365);
    let one_year_ago_str = one_year_ago.format("%Y-%m-%d").to_string();
    let old_files: Vec<FileInfo> = all_files
        .iter()
        .filter(|f| f.modified < one_year_ago_str && f.size > 10 * 1024 * 1024)
        .cloned()
        .take(20)
        .collect();

    let mut recommendations: Vec<String> = Vec::new();

    recommendations.push(format!(
        "📊 전체 분석: {} 파일, {} 폴더, 총 {}",
        total_files,
        total_folders,
        format_size(total_size)
    ));

    if let Some((file_type, stats)) = type_summary.iter().max_by_key(|(_, s)| s.total_size) {
        recommendations.push(format!(
            "💾 가장 많은 용량: {} - {} ({:.1}%)",
            file_type,
            format_size(stats.total_size),
            stats.percentage
        ));
    }

    if !duplicates.is_empty() {
        let dup_total: u64 = duplicates.iter().map(|d| d.size * (d.files.len() as u64 - 1)).sum();
        recommendations.push(format!(
            "⚠️ 중복 의심 파일 {} 그룹 발견 - 정리 시 약 {} 절약 가능",
            duplicates.len(),
            format_size(dup_total)
        ));
    }

    let very_large: Vec<&FileInfo> = large_files.iter().filter(|f| f.size > 500 * 1024 * 1024).collect();
    if !very_large.is_empty() {
        recommendations.push(format!(
            "📁 500MB 이상 대용량 파일 {} 개 - 외장 드라이브나 클라우드 이동 권장",
            very_large.len()
        ));
    }

    if !old_files.is_empty() {
        let old_total: u64 = old_files.iter().map(|f| f.size).sum();
        recommendations.push(format!(
            "🕐 1년 이상 된 대용량 파일 {} 개 ({}) - 백업 후 삭제 고려",
            old_files.len(),
            format_size(old_total)
        ));
    }

    if let Some(stats) = type_summary.get("🎬 동영상") {
        if stats.percentage > 30.0 {
            recommendations.push(format!(
                "🎬 동영상이 전체의 {:.1}% 차지 - 시청 완료한 영상 정리 권장",
                stats.percentage
            ));
        }
    }

    if let Some(stats) = type_summary.get("📦 압축파일") {
        if stats.count > 10 {
            recommendations.push(format!(
                "📦 압축파일 {} 개 - 이미 해제한 파일이라면 원본 삭제 권장",
                stats.count
            ));
        }
    }

    if let Some(stats) = type_summary.get("⚙️ 실행파일") {
        if stats.count > 5 {
            recommendations.push(format!(
                "⚙️ 실행파일/설치파일 {} 개 ({}) - 설치 완료 후 삭제 권장",
                stats.count,
                format_size(stats.total_size)
            ));
        }
    }

    // 취소된 경우 메시지 추가
    if cancelled {
        recommendations.insert(0, "⚠️ 스캔이 중단되었습니다. 부분적인 결과만 표시됩니다.".to_string());
    }

    // 비디오 파일 수집
    let mut videos: Vec<FileInfo> = all_files
        .iter()
        .filter(|f| f.file_type.contains("동영상"))
        .cloned()
        .collect();
    videos.sort_by(|a, b| b.size.cmp(&a.size));
    videos.truncate(50); // 최대 50개

    Ok(FileConsultingResult {
        total_scanned: total_files,
        total_size,
        total_folders,
        folders: vec![],
        recommendations,
        duplicates,
        large_files,
        old_files,
        type_summary,
        videos,
        suspicious_files: vec![],
    })
}

/// AI를 사용한 상세 컨설팅
pub async fn get_ai_consulting(
    api_key: &str,
    result: &FileConsultingResult,
) -> Result<String, String> {
    let type_summary_str: String = result
        .type_summary
        .iter()
        .map(|(k, v)| format!("- {}: {} 파일, {}", k, v.count, format_size(v.total_size)))
        .collect::<Vec<_>>()
        .join("\n");

    let large_files_str: String = result
        .large_files
        .iter()
        .take(10)
        .map(|f| format!("- {} ({})", f.name, format_size(f.size)))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        r#"당신은 파일 관리 전문 컨설턴트입니다. 다음 분석 결과를 바탕으로 사용자에게 친절하고 구체적인 컨설팅을 제공해주세요.

## 분석 결과
- 총 파일 수: {} 개
- 총 용량: {}
- 총 폴더 수: {} 개

## 파일 유형별 현황
{}

## 대용량 파일 TOP 10
{}

## 현재 권고사항
{}

---

위 정보를 바탕으로:
1. 현재 파일 구조의 장단점
2. 용량 절약을 위한 구체적인 조언 (우선순위 순)
3. 효율적인 파일 관리 팁
4. 주의해야 할 점

을 친절한 한국어로 설명해주세요. 마크다운 형식으로 작성하되, 이모지를 활용해 읽기 쉽게 해주세요."#,
        result.total_scanned,
        format_size(result.total_size),
        result.total_folders,
        type_summary_str,
        large_files_str,
        result.recommendations.join("\n")
    );

    let client = Client::new();
    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}",
            api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "maxOutputTokens": 2000,
                "temperature": 0.7
            }
        }))
        .send()
        .await
        .map_err(|e| format!("AI 요청 실패: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("AI 오류: {}", response.status()));
    }

    let body: serde_json::Value = response.json().await.map_err(|e| format!("응답 파싱 실패: {}", e))?;

    body["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "AI 응답을 파싱할 수 없습니다".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRenameSuggestion {
    pub original_path: String,
    pub original_name: String,
    pub suggested_name: String,
    pub reason: String,
}

/// 폴더명 변경 제안 (AI 기반)
pub async fn get_folder_rename_suggestions(
    api_key: &str,
    folder_names: &[String],
) -> Result<Vec<FolderRenameSuggestion>, String> {
    if folder_names.is_empty() {
        return Ok(vec![]);
    }

    // 폴더명 목록 생성 (경로에서 폴더명과 경로 분리)
    let folders_info: Vec<(&str, &str)> = folder_names
        .iter()
        .map(|path| {
            let name = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_str().unwrap_or(path))
                .unwrap_or(path);
            (path.as_str(), name)
        })
        .collect();

    let folder_list = folders_info
        .iter()
        .enumerate()
        .map(|(i, (_, name))| format!("{}. {}", i + 1, name))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        r#"다음 폴더명들을 분석하고, 더 인식하기 쉽고 정리된 이름으로 변경을 제안해주세요.

## 폴더명 목록:
{}

## 요구사항:
1. 한글과 영어를 적절히 혼합하여 가독성 있게
2. 날짜가 포함된 경우 YYYY-MM-DD 형식으로 통일
3. 불필요한 특수문자, 공백 정리
4. 내용을 유추할 수 있는 명확한 이름
5. 이미 좋은 이름인 경우 그대로 유지

## 응답 형식 (JSON):
[
  {{
    "index": 1,
    "suggested_name": "제안된_폴더명",
    "reason": "변경 이유 (한 줄)"
  }}
]

이미 좋은 이름인 폴더는 응답에서 제외하세요."#,
        folder_list
    );

    let client = Client::new();
    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            DEFAULT_MODEL, api_key
        ))
        .json(&json!({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "maxOutputTokens": 2000,
                "temperature": 0.5
            }
        }))
        .send()
        .await
        .map_err(|e| format!("AI 요청 실패: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("AI 오류: {}", response.status()));
    }

    let body: serde_json::Value = response.json().await.map_err(|e| format!("응답 파싱 실패: {}", e))?;

    let text = body["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .ok_or_else(|| "AI 응답을 파싱할 수 없습니다".to_string())?;

    // JSON 추출 및 파싱
    let json_text = extract_json(text);
    let suggestions: Vec<serde_json::Value> = serde_json::from_str(&json_text)
        .map_err(|e| format!("응답 JSON 파싱 실패: {} - 원본: {}", e, json_text))?;

    let result: Vec<FolderRenameSuggestion> = suggestions
        .iter()
        .filter_map(|s| {
            let index = s["index"].as_i64()? as usize;
            if index == 0 || index > folders_info.len() {
                return None;
            }
            let (original_path, original_name) = folders_info.get(index - 1)?;
            let suggested_name = s["suggested_name"].as_str()?;

            // 같은 이름이면 제외
            if *original_name == suggested_name {
                return None;
            }

            Some(FolderRenameSuggestion {
                original_path: original_path.to_string(),
                original_name: original_name.to_string(),
                suggested_name: suggested_name.to_string(),
                reason: s["reason"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect();

    Ok(result)
}

// ===== 시크릿 키 감지/파싱 =====

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DetectedSecretKey {
    pub key_name: String,
    pub key_value: String,
    pub key_type: String,       // API_KEY, TOKEN, SECRET, CREDENTIAL, PASSWORD, ENV_VAR, etc.
    pub provider: String,       // OpenAI, AWS, Google, GitHub, Custom, etc.
    pub provider_url: Option<String>,
    pub description: Option<String>,
    pub issued_date: String,
    pub expires_at: Option<String>,
}
