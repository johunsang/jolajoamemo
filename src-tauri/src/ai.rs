use chrono::Datelike;
use regex::Regex;
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

    let multi_result: MultiAnalysisResult = serde_json::from_str(&text)
        .map_err(|e| format!("JSON 파싱 실패: {} - 원본: {}", e, text))?;

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
