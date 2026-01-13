use chrono::Datelike;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;

const DEFAULT_MODEL: &str = "gemini-3-flash-preview";
const EMBEDDING_MODEL: &str = "text-embedding-004";

// 지원하는 모델 목록 (저렴한 순)
pub const AVAILABLE_MODELS: &[(&str, &str)] = &[
    // Gemini 2.0 (기본/저렴)
    ("gemini-2.0-flash-lite", "Gemini 2.0 Flash Lite (기본/최저가)"),
    ("gemini-2.0-flash", "Gemini 2.0 Flash"),
    // Gemini 2.5
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash (균형)"),
    ("gemini-2.5-pro", "Gemini 2.5 Pro (고성능)"),
    // Gemini 3.0 (최신!)
    ("gemini-3-flash-preview", "Gemini 3 Flash (속도+성능)"),
    ("gemini-3-pro-preview", "Gemini 3 Pro (최강)"),
];

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

// 메모 분석 (제목, 포맷팅, 요약, 카테고리, 태그 추출)
pub async fn analyze_memo(
    api_key: &str,
    model: &str,
    content: &str,
    existing_memos: &[(i64, String, String)],
) -> Result<(AnalysisResult, TokenUsage), String> {
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };
    let client = Client::new();

    let existing_info = if existing_memos.is_empty() {
        "없음".to_string()
    } else {
        existing_memos
            .iter()
            .map(|(id, title, summary)| format!("ID:{} - {} ({})", id, title, summary))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let prompt = format!(
        r#"당신은 메모 정리 AI입니다. 사용자가 입력한 텍스트를 분석하세요.

## 입력된 텍스트:
{}

## 기존 메모 목록:
{}

## 작업:
1. 입력 텍스트를 분석해서 깔끔하게 포맷팅하세요
2. 적절한 제목을 생성하세요
3. 한 줄 요약을 만드세요
4. 카테고리를 자유롭게 생성하세요 (2~4글자 한국어, 예: 연락처, 회의록, 아이디어, 여행, 요리 등)
5. 관련 태그를 추출하세요
6. 기존 메모 중 내용이 매우 유사한 것이 있다면 병합 대상 ID를 지정하세요

## 응답 형식 (JSON만 출력):
{{
  "title": "제목",
  "formatted_content": "깔끔하게 정리된 내용",
  "summary": "한 줄 요약",
  "category": "카테고리",
  "tags": ["태그1", "태그2"],
  "should_merge_with": null 또는 메모ID숫자
}}"#,
        content, existing_info
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

    let analysis: AnalysisResult = serde_json::from_str(&text)
        .map_err(|e| format!("JSON 파싱 실패: {} - 원본: {}", e, text))?;

    let token_usage = TokenUsage {
        input_tokens: usage.prompt_token_count,
        output_tokens: usage.candidates_token_count,
        cost_usd: calculate_cost(model, usage.prompt_token_count, usage.candidates_token_count),
    };

    Ok((analysis, token_usage))
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
) -> Result<(Vec<AnalysisResult>, TokenUsage), String> {
    let model = if model.is_empty() { DEFAULT_MODEL } else { model };
    let client = Client::new();

    let existing_info = if existing_memos.is_empty() {
        "없음".to_string()
    } else {
        existing_memos
            .iter()
            .take(20)
            .map(|(id, title, summary)| format!("ID:{} - {} ({})", id, title, summary))
            .collect::<Vec<_>>()
            .join("\n")
    };

    // 현재 날짜/시간 가져오기
    let now = chrono::Local::now();
    let current_datetime = now.format("%Y-%m-%d %H:%M").to_string();
    let current_weekday = match now.weekday() {
        chrono::Weekday::Mon => "월요일",
        chrono::Weekday::Tue => "화요일",
        chrono::Weekday::Wed => "수요일",
        chrono::Weekday::Thu => "목요일",
        chrono::Weekday::Fri => "금요일",
        chrono::Weekday::Sat => "토요일",
        chrono::Weekday::Sun => "일요일",
    };

    let prompt = format!(
        r#"당신은 메모 정리 AI입니다. 사용자가 입력한 텍스트를 분석하세요.

## 현재 시간: {} ({})

## 입력된 텍스트:
{}

## 기존 메모 목록:
{}

## 중요 작업:

### 1. 텍스트 분리 (너무 잘게 쪼개지 마!)
- 같은 맥락/상황의 내용은 **하나의 메모**로 유지
- 예: 엄마 카톡 내용 → 전체를 "엄마 심부름" 1개 메모로 저장 (할일만 여러 개 추출)
- 예: 회의 내용 → 전체를 "회의록" 1개 메모로 저장 (할일/일정만 추출)
- **완전히 다른 주제**일 때만 분리 (예: 연락처 + 아이디어 = 2개)
- 관련된 내용은 절대 쪼개지 말고 하나로!

### 2. 스마트 분류 (AI 자율 판단)
- 카테고리를 너가 내용을 보고 직접 만들어
- 간결하고 직관적인 한국어 카테고리명 사용 (2~4글자)
- 예: 연락처, 회의록, 아이디어, 코드, 요리, 여행, 건강, 쇼핑, 공부, 일기 등
- 내용에 가장 적합한 카테고리를 자유롭게 생성해

### 3. 병합 규칙 (중요!)
- 같은 사람의 연락처가 있으면 → 병합 (정보 추가)
- 같은 주제의 회의록이 있으면 → 병합 (내용 추가)
- 같은 프로젝트/아이디어면 → 병합
- **다른 주제면 절대 병합하지 마세요!**

### 4. 일정 추출 (실제 날짜로 변환 필수!)
- "내일" → 현재시간+1일 계산해서 "2026-01-15T09:00" 형식으로
- "다음주 월요일" → 실제 날짜 계산해서 "2026-01-20" 형식으로
- "7일 후" → 실제 날짜 계산해서 "2026-01-21" 형식으로
- **절대로 "내일", "7일 후" 같은 상대적 표현 사용 금지!**
- **반드시 YYYY-MM-DD 또는 YYYY-MM-DDTHH:MM 형식의 실제 날짜로 변환!**
- 시간 언급 없으면 시간 부분 생략 (예: "2026-01-15")

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
      ]
    }}
  ]
}}

일정/할일이 없으면 각각 빈 배열 []로 두세요.
하나의 주제만 있으면 items에 1개만 넣으세요."#,
        current_datetime, current_weekday, content, existing_info
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

    let multi_result: MultiAnalysisResult = serde_json::from_str(&text)
        .map_err(|e| format!("JSON 파싱 실패: {} - 원본: {}", e, text))?;

    let token_usage = TokenUsage {
        input_tokens: usage.prompt_token_count,
        output_tokens: usage.candidates_token_count,
        cost_usd: calculate_cost(model, usage.prompt_token_count, usage.candidates_token_count),
    };

    Ok((multi_result.items, token_usage))
}

// 임베딩 생성
pub async fn create_embedding(api_key: &str, text: &str) -> Result<Vec<f32>, String> {
    let client = Client::new();

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:embedContent?key={}",
            EMBEDDING_MODEL, api_key
        ))
        .json(&json!({
            "model": format!("models/{}", EMBEDDING_MODEL),
            "content": {"parts": [{"text": text}]}
        }))
        .send()
        .await
        .map_err(|e| format!("임베딩 요청 실패: {}", e))?;

    let embed_resp: EmbeddingResponse = response
        .json()
        .await
        .map_err(|e| format!("임베딩 응답 파싱 실패: {}", e))?;

    Ok(embed_resp.embedding.values)
}

// 코사인 유사도 계산
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }

    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a * norm_b)
}
