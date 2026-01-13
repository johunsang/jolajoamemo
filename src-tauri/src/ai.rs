use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;

const GEMINI_MODEL: &str = "gemini-2.0-flash";
const EMBEDDING_MODEL: &str = "text-embedding-004";

// Gemini API 가격 (USD per 1M tokens)
const INPUT_PRICE_PER_M: f64 = 0.10;
const OUTPUT_PRICE_PER_M: f64 = 0.40;

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub title: String,
    pub formatted_content: String,
    pub summary: String,
    pub category: String,
    pub tags: Vec<String>,
    pub should_merge_with: Option<i64>,
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

pub fn calculate_cost(input_tokens: i64, output_tokens: i64) -> f64 {
    (input_tokens as f64 * INPUT_PRICE_PER_M / 1_000_000.0)
        + (output_tokens as f64 * OUTPUT_PRICE_PER_M / 1_000_000.0)
}

// 메모 분석 (제목, 포맷팅, 요약, 카테고리, 태그 추출)
pub async fn analyze_memo(
    api_key: &str,
    content: &str,
    existing_memos: &[(i64, String, String)],
) -> Result<(AnalysisResult, TokenUsage), String> {
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
4. 카테고리를 지정하세요 (연락처, 회의, 아이디어, 할일, 메모, 코드, 기타 중 선택)
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
            GEMINI_MODEL, api_key
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
        cost_usd: calculate_cost(usage.prompt_token_count, usage.candidates_token_count),
    };

    Ok((analysis, token_usage))
}

// RAG 질의응답
pub async fn ask_question(
    api_key: &str,
    question: &str,
    context_memos: &[(String, String)],
) -> Result<(String, TokenUsage), String> {
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
            GEMINI_MODEL, api_key
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
        cost_usd: calculate_cost(usage.prompt_token_count, usage.candidates_token_count),
    };

    Ok((text, token_usage))
}

// 여러 개 메모 자동 분리 분석
pub async fn analyze_multi_memo(
    api_key: &str,
    content: &str,
    existing_memos: &[(i64, String, String)],
) -> Result<(Vec<AnalysisResult>, TokenUsage), String> {
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

    let prompt = format!(
        r#"당신은 메모 정리 AI입니다. 사용자가 입력한 텍스트를 분석하세요.

## 입력된 텍스트:
{}

## 기존 메모 목록:
{}

## 중요 작업:
1. 입력 텍스트에 여러 개의 다른 주제/항목이 있으면 각각 분리하세요
2. 각 항목을 깔끔하게 포맷팅하세요
3. 각 항목에 적절한 제목, 요약, 카테고리, 태그를 부여하세요
4. 기존 메모와 매우 유사한 내용이면 병합 대상 ID를 지정하세요

카테고리: 연락처, 회의, 아이디어, 할일, 메모, 코드, 기타

## 응답 형식 (JSON 배열):
{{
  "items": [
    {{
      "title": "제목1",
      "formatted_content": "정리된 내용1",
      "summary": "한줄요약1",
      "category": "카테고리1",
      "tags": ["태그"],
      "should_merge_with": null
    }},
    {{
      "title": "제목2",
      "formatted_content": "정리된 내용2",
      "summary": "한줄요약2",
      "category": "카테고리2",
      "tags": ["태그"],
      "should_merge_with": null
    }}
  ]
}}

하나의 주제만 있으면 items에 1개만 넣으세요."#,
        content, existing_info
    );

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            GEMINI_MODEL, api_key
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
        cost_usd: calculate_cost(usage.prompt_token_count, usage.candidates_token_count),
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
