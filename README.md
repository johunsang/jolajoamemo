# JolaJoa Memo

**AI가 알아서 정리하는 스마트 메모장**

메모만 던지면 AI가 자동으로 제목, 카테고리, 태그를 생성합니다.

![License](https://img.shields.io/badge/license-MIT-black)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black)
![Tauri](https://img.shields.io/badge/Tauri-2.0-blue)
![React](https://img.shields.io/badge/React-18-61dafb)

---

## 주요 기능

### AI 자동 정리
- 메모 입력 시 Gemini AI가 자동으로 제목 생성
- 카테고리 자동 분류 (중첩 카테고리 지원: `work/project/frontend`)
- 관련 태그 자동 추출
- 유사한 메모가 있으면 자동 병합 제안

### 자연어 검색
- "지난주 회의에서 뭐라고 했지?" 처럼 자연어로 질문
- AI가 저장된 메모를 분석해서 답변 생성

### 실시간 자동저장
- 편집 중 자동 저장 (800ms 디바운스)
- 저장 버튼 없이 바로 수정

### 드래그 앤 드롭
- 메모를 드래그해서 다른 카테고리로 이동

### 다크 모드
- 라이트/다크 테마 전환
- 설정 자동 저장

### 다국어 지원
- 한국어, English, 日本語, 中文, Français

---

## 스크린샷

```
┌─────────────────────────────────────────────────────────┐
│  JOLAJOA                [INPUT] [SEARCH] [SETTINGS]     │
├──────────────┬──────────────────────────────────────────┤
│ // CATEGORIES│                                          │
│              │  ┌────────────────────────────────────┐  │
│ [+] work     │  │ // DROP YOUR DATA                  │  │
│ [+] personal │  │                                    │  │
│ [-] ideas    │  │ 연락처, 회의록, 아이디어...        │  │
│   ├ app idea │  │ AI가 자동으로 정리합니다.          │  │
│   └ startup  │  │                                    │  │
│              │  │ [____________________________]     │  │
│              │  │                                    │  │
│              │  │ [SAVE]                             │  │
│              │  └────────────────────────────────────┘  │
├──────────────┴──────────────────────────────────────────┤
│ TOKENS: 1,234                              $0.0012      │
└─────────────────────────────────────────────────────────┘
```

---

## 설치

### 다운로드

- [macOS (Apple Silicon)](https://github.com/user/jolajoamemo/releases/latest)
- [macOS (Intel)](https://github.com/user/jolajoamemo/releases/latest)
- [Windows](https://github.com/user/jolajoamemo/releases/latest)

### 요구사항

- Gemini API Key ([여기서 발급](https://aistudio.google.com/apikey))

---

## 개발

### 요구사항
- Node.js 18+
- Rust 1.70+

### 설치 및 실행

```bash
# 의존성 설치
npm install

# 개발 모드 실행
npm run tauri dev

# 프로덕션 빌드
npm run tauri build
```

---

## 사용 방법

### 1. API 키 설정
1. [Google AI Studio](https://aistudio.google.com/apikey)에서 Gemini API 키 발급
2. Settings 탭에서 API 키 입력
3. Save 클릭

### 2. 메모 입력
- Input 탭에서 아무 텍스트나 입력
- AI가 자동으로 정리해서 저장

### 3. 검색
- Search 탭에서 자연어로 질문
- 예: "프로젝트 마감일이 언제야?"

### 4. 편집
- 왼쪽 카테고리에서 메모 클릭
- 제목, 카테고리, 태그, 내용 직접 수정 (자동 저장)

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| Framework | Tauri 2.0 |
| Frontend | React 18, TypeScript, Tailwind CSS |
| Backend | Rust |
| Database | SQLite (rusqlite) |
| AI | Google Gemini API |
| i18n | react-i18next |

---

## 프로젝트 구조

```
jolajoamemo/
├── src/                    # React 프론트엔드
│   ├── App.tsx            # 메인 컴포넌트
│   ├── index.css          # 브루탈리스트 테마
│   └── i18n/              # 다국어 번역 파일
├── src-tauri/             # Rust 백엔드
│   └── src/
│       ├── lib.rs         # Tauri 커맨드
│       ├── ai.rs          # Gemini AI 연동
│       └── db/            # SQLite 데이터베이스
└── package.json
```

---

## API 사용량

Gemini API 무료 티어:
- 분당 15 요청
- 일일 1,500 요청

앱 하단에서 오늘 사용한 토큰 수와 예상 비용을 확인할 수 있습니다.

---

## 라이선스

MIT License

---

## 기여

이슈와 PR 환영합니다!
