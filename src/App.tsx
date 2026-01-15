import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useTranslation } from "react-i18next";
import { languages } from "./i18n";
// import DataCollection from "./components/DataCollection";
import FileConsulting from "./components/FileConsulting";

interface Memo {
  id: number;
  title: string;
  content: string;
  formatted_content: string;
  summary: string;
  category: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

interface UsageStats {
  today_input_tokens: number;
  today_output_tokens: number;
  today_cost_usd: number;
}

interface Schedule {
  id: number;
  memo_id: number | null;
  title: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  description: string | null;
  google_event_id: string | null;
  created_at: string;
}

interface Todo {
  id: number;
  memo_id: number | null;
  title: string;
  completed: boolean;
  priority: string | null;
  due_date: string | null;
  created_at: string;
}

interface InputResult {
  success: boolean;
  message: string;
  memo_id: number | null;
  merged: boolean;
  title: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface SearchResult {
  answer: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

type Tab = "input" | "search" | "schedule" | "todo" | "ledger" | "organize" | "research" | "collect" | "extract" | "agent" | "data" | "consulting" | "settings";

interface SearchItem {
  title: string;
  link: string;
  description: string;
  source: string;
}

interface SourceSummary {
  title: string;
  url: string;
  source: string;
  summary: string;
}

interface ResearchResult {
  query: string;
  summary: string;
  key_points: string[];
  sources: SearchItem[];
  source_summaries: SourceSummary[];  // 별첨: 출처별 요약
  full_report: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  search_engines_used: string[];
  memo_id: number | null;
}

// Agent (AI 브라우저 에이전트) 인터페이스
interface AgentStep {
  step_number: number;
  action_type: string;
  selector: string | null;
  value: string | null;
  reason: string;
  result: string;
}

interface AgentResult {
  goal: string;
  success: boolean;
  steps: AgentStep[];
  final_data: Record<string, unknown> | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

// 데이터셋 관련 인터페이스
interface Dataset {
  id: number;
  name: string;
  description: string;
  columns: string[];
  row_count: number;
  created_at: string;
}

interface DatasetRow {
  id: number;
  dataset_id: number;
  row_index: number;
  data: string[];
}

interface ChartData {
  chart_type: string;
  title: string;
  labels: string[];
  values: number[];
}

interface StatItem {
  label: string;
  value: string;
}

interface DatasetAnalysis {
  summary: string;
  insights: string[];
  statistics: StatItem[];
  chart_data: ChartData | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface DatasetQAResult {
  answer: string;
  relevant_rows: string[][];
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface ResearchTaskInfo {
  id: number;
  task_type: string;
  description: string;
  status: string;
}

interface ResearchProgress {
  step: number;
  total_steps: number;
  task_type: string;
  description: string;
  status: string;
  tasks: ResearchTaskInfo[];
}

interface FileInfo {
  name: string;
  path: string;
  size: number;
  extension: string;
  modified: string;
  is_dir: boolean;
}

interface OrganizePlan {
  file_path: string;
  file_name: string;
  suggested_folder: string;
  reason: string;
  selected: boolean;
}

interface Transaction {
  id: number;
  memo_id: number | null;
  tx_type: string;
  amount: number;
  description: string;
  category: string | null;
  tx_date: string | null;
  created_at: string;
}

interface Attachment {
  id: number;
  memo_id: number;
  file_name: string;
  file_path: string;
  original_path: string;
  is_copy: boolean;
  file_size: number;
  created_at: string;
}

function App() {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<Tab>("input");
  const [inputText, setInputText] = useState("");
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [language, setLanguage] = useState("ko");
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [editTxType, setEditTxType] = useState<string>('expense');
  const [editTxAmount, setEditTxAmount] = useState<string>('');
  const [editTxDesc, setEditTxDesc] = useState<string>('');
  const [editTxCategory, setEditTxCategory] = useState<string>('');
  const [editTxDate, setEditTxDate] = useState<string>('');
  const [selectedMemo, setSelectedMemo] = useState<Memo | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editTags, setEditTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [savedWindowSize, setSavedWindowSize] = useState<{ width: number; height: number } | null>(null);

  const [draggedMemo, setDraggedMemo] = useState<Memo | null>(null);
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [attachmentCopyMode, setAttachmentCopyMode] = useState<string>("link");
  const [pendingFiles, setPendingFiles] = useState<string[]>([]); // 메모 저장 전 대기 중인 파일들
  const [memoFilter, setMemoFilter] = useState(""); // 메모 목록 실시간 검색 필터
  const [memoViewTab, setMemoViewTab] = useState<"formatted" | "original" | "attachments">("formatted"); // 메모 보기 탭
  const [isEditing, setIsEditing] = useState(false); // 편집 모드
  const [editOriginal, setEditOriginal] = useState(""); // 원본 편집용
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]); // Tauri에서 드롭된 파일 경로
  const [searchedAttachments, setSearchedAttachments] = useState<Attachment[]>([]); // 검색된 첨부 파일
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body: string; showDetails?: boolean } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [selectedMemoIds, setSelectedMemoIds] = useState<Set<number>>(new Set()); // 다중 선택
  const [lastSelectedMemoId, setLastSelectedMemoId] = useState<number | null>(null); // Shift 선택용 마지막 선택 ID
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null); // 이름 변경 중인 카테고리
  const [newCategoryName, setNewCategoryName] = useState(""); // 새 카테고리 이름
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [_opacity, setOpacity] = useState(100);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(208); // 기본 너비 208px (w-52)
  const [isResizing, setIsResizing] = useState(false);
  const [aiModel, setAiModel] = useState("gemini-3-flash-preview");
  const [appVersion, setAppVersion] = useState("");
  const [toast, setToast] = useState<string | null>(null); // 토스트 알림

  // 폴더 정리 관련 상태
  const [organizeBasePath, setOrganizeBasePath] = useState<string>(""); // 선택된 폴더 경로
  const [organizeFiles, setOrganizeFiles] = useState<FileInfo[]>([]); // 스캔된 파일 목록
  const [organizePlans, setOrganizePlans] = useState<OrganizePlan[]>([]); // AI 분석 결과
  const [organizeLoading, setOrganizeLoading] = useState(false); // 분석 중
  const [organizeExecuting, setOrganizeExecuting] = useState(false); // 실행 중
  const [organizeResult, setOrganizeResult] = useState<string | null>(null); // 결과 메시지
  const [organizeStep, setOrganizeStep] = useState<string>(""); // 현재 진행 단계
  const [organizeMovedFiles, setOrganizeMovedFiles] = useState<Array<{
    file_name: string;
    from_path: string;
    to_path: string;
    to_folder: string;
  }>>([]); // 이동된 파일 상세 정보
  const [organizePhase, setOrganizePhase] = useState<'select-folder' | 'select-method' | 'preview' | 'done'>('select-folder'); // 현재 단계
  const [organizeMethod, setOrganizeMethod] = useState<string>(""); // 선택된 정리 방식

  // 리서치 관련 상태
  const [researchQuery, setResearchQuery] = useState<string>("");
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);
  const [researchProgress, setResearchProgress] = useState<ResearchProgress | null>(null);
  const [naverClientId, setNaverClientId] = useState<string>("");
  const [naverClientSecret, setNaverClientSecret] = useState<string>("");
  const [googleSearchApiKey, setGoogleSearchApiKey] = useState<string>("");
  const [googleSearchCx, setGoogleSearchCx] = useState<string>("");

  // Extract (AI 데이터 추출) 관련 상태
  const [extractUrl, setExtractUrl] = useState<string>("");
  const [extractSchema, setExtractSchema] = useState<string>("");
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractResult, setExtractResult] = useState<{url: string; data: unknown; input_tokens: number; output_tokens: number; cost_usd: number} | null>(null);

  // Agent (AI 브라우저 에이전트) 관련 상태
  const [agentGoal, setAgentGoal] = useState<string>("");
  const [agentStartUrl, setAgentStartUrl] = useState<string>("https://www.naver.com");
  const [agentMaxSteps, setAgentMaxSteps] = useState<number>(10);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [agentLiveSteps, setAgentLiveSteps] = useState<AgentStep[]>([]);

  // 데이터셋(엑셀) 관련 상태
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<Dataset | null>(null);
  const [datasetRows, setDatasetRows] = useState<DatasetRow[]>([]);
  const [datasetLoading, setDatasetLoading] = useState(false);
  const [datasetAnalysis, setDatasetAnalysis] = useState<DatasetAnalysis | null>(null);
  const [datasetQuestion, setDatasetQuestion] = useState<string>("");
  const [datasetQAResult, setDatasetQAResult] = useState<DatasetQAResult | null>(null);
  const [datasetQALoading, setDatasetQALoading] = useState(false);
  const [datasetSearchQuery, setDatasetSearchQuery] = useState<string>("");
  const [isDraggingExcel, setIsDraggingExcel] = useState(false);

  // 무한 스크롤 관련 상태
  const [memoOffset, setMemoOffset] = useState(0);
  const [hasMoreMemos, setHasMoreMemos] = useState(true);
  const [loadingMoreMemos, setLoadingMoreMemos] = useState(false);
  const [totalMemoCount, setTotalMemoCount] = useState(0);
  const MEMO_PAGE_SIZE = 30;
  const memoListRef = useRef<HTMLDivElement>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

  // 사용 가능한 AI 모델 목록
  const availableModels = [
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (기본/추천)" },
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro (최강)" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (고성능)" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (균형)" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
    { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite (최저가)" },
  ];

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentStepsRef = useRef<HTMLDivElement>(null);

  // Agent 진행상황 자동 스크롤
  useEffect(() => {
    if (agentStepsRef.current && agentLiveSteps.length > 0) {
      agentStepsRef.current.scrollTop = agentStepsRef.current.scrollHeight;
    }
  }, [agentLiveSteps]);

  useEffect(() => {
    const initApp = async () => {
      // 버전 먼저 가져오기
      try {
        const v = await getVersion();
        setAppVersion(v);
      } catch (e) {
        console.error("Failed to get version:", e);
      }

      // 업데이트 체크 (배너만 표시, 자동 업데이트 안함)
      try {
        const update = await check();
        if (update) {
          setUpdateAvailable({ version: update.version, body: update.body || "" });
        }
      } catch (e) {
        console.log("Update check failed:", e);
      }

      // 데이터 로드
      await Promise.all([
        loadSettings(),
        loadUsage(),
        loadMemos(),
        loadSchedules(),
        loadTodos(),
        loadTransactions(),
        loadDatasets()
      ]);

      // 스플래시 화면 페이드 아웃 (최소 1.5초 유지)
      setTimeout(() => {
        setSplashFading(true);
        setTimeout(() => {
          setShowSplash(false);
        }, 500); // 페이드 아웃 애니메이션 시간
      }, 1500);
    };

    initApp();
  }, []);

  // Agent 진행상황 이벤트 리스너
  useEffect(() => {
    const unlisten = listen<AgentStep>('agent-progress', (event) => {
      setAgentLiveSteps(prev => [...prev, event.payload]);
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  const loadTransactions = async () => {
    try {
      const list = await invoke<Transaction[]>("get_transactions");
      setTransactions(list);
    } catch (e) { console.error(e); }
  };

  const startEditTx = (tx: Transaction) => {
    setEditingTx(tx);
    setEditTxType(tx.tx_type);
    setEditTxAmount(tx.amount.toString());
    setEditTxDesc(tx.description);
    setEditTxCategory(tx.category || '');
    setEditTxDate(tx.tx_date || '');
  };

  const saveEditTx = async () => {
    if (!editingTx) return;
    try {
      await invoke("update_transaction", {
        id: editingTx.id,
        txType: editTxType,
        amount: parseInt(editTxAmount) || 0,
        description: editTxDesc,
        category: editTxCategory || null,
        txDate: editTxDate || null,
      });
      await loadTransactions();
      setEditingTx(null);
    } catch (e) { console.error(e); }
  };

  const deleteTx = async (id: number) => {
    try {
      await invoke("delete_transaction", { id });
      await loadTransactions();
    } catch (e) { console.error(e); }
  };

  // ===== 데이터셋(엑셀) 관련 함수 =====

  const loadDatasets = async () => {
    try {
      const list = await invoke<Dataset[]>("get_datasets");
      setDatasets(list);
    } catch (e) { console.error("Failed to load datasets:", e); }
  };

  const loadDatasetRows = async (datasetId: number, offset = 0, limit = 100) => {
    try {
      const rows = await invoke<DatasetRow[]>("get_dataset_rows", { datasetId, offset, limit });
      setDatasetRows(rows);
    } catch (e) { console.error("Failed to load dataset rows:", e); }
  };

  const handleExcelDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingExcel(false);

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const file = files[0];
    const validExtensions = ['.xlsx', '.xls', '.csv'];
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    if (!validExtensions.includes(ext)) {
      showToast("지원되지 않는 파일 형식입니다. (xlsx, xls, csv만 가능)");
      return;
    }

    setDatasetLoading(true);
    try {
      // 파일을 Base64로 변환
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1];
        try {
          const result = await invoke<{ success: boolean; dataset_id: number; name: string; columns: string[]; row_count: number; message: string }>(
            "import_excel",
            { fileData: base64, fileName: file.name }
          );

          showToast(`✅ ${result.message}`);
          await loadDatasets();

          // 새로 추가된 데이터셋 자동 선택
          const newDataset = await invoke<Dataset>("get_dataset_detail", { id: result.dataset_id });
          setSelectedDataset(newDataset);
          await loadDatasetRows(result.dataset_id);
        } catch (err) {
          showToast(`❌ 임포트 실패: ${err}`);
        } finally {
          setDatasetLoading(false);
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      showToast(`❌ 파일 읽기 실패: ${err}`);
      setDatasetLoading(false);
    }
  };

  const selectDataset = async (dataset: Dataset) => {
    setSelectedDataset(dataset);
    setDatasetAnalysis(null);
    setDatasetQAResult(null);
    setDatasetSearchQuery("");
    await loadDatasetRows(dataset.id);
  };

  const analyzeDataset = async () => {
    if (!selectedDataset) return;

    setDatasetLoading(true);
    try {
      const result = await invoke<DatasetAnalysis>("analyze_dataset", { id: selectedDataset.id });
      setDatasetAnalysis(result);
    } catch (e) {
      showToast(`❌ 분석 실패: ${e}`);
    } finally {
      setDatasetLoading(false);
    }
  };

  const askDatasetQuestion = async () => {
    if (!selectedDataset || !datasetQuestion.trim()) return;

    setDatasetQALoading(true);
    try {
      const result = await invoke<DatasetQAResult>("query_dataset", {
        id: selectedDataset.id,
        question: datasetQuestion
      });
      setDatasetQAResult(result);
    } catch (e) {
      showToast(`❌ 질문 처리 실패: ${e}`);
    } finally {
      setDatasetQALoading(false);
    }
  };

  const searchDataset = async () => {
    if (!selectedDataset || !datasetSearchQuery.trim()) {
      if (selectedDataset) {
        await loadDatasetRows(selectedDataset.id);
      }
      return;
    }

    try {
      const rows = await invoke<DatasetRow[]>("search_dataset", {
        datasetId: selectedDataset.id,
        query: datasetSearchQuery
      });
      setDatasetRows(rows);
    } catch (e) {
      console.error("Search failed:", e);
    }
  };

  const deleteDataset = async (id: number) => {
    if (!confirm("이 데이터셋을 삭제하시겠습니까?")) return;

    try {
      await invoke("delete_dataset", { id });
      showToast("데이터셋이 삭제되었습니다");
      setSelectedDataset(null);
      setDatasetRows([]);
      await loadDatasets();
    } catch (e) {
      showToast(`❌ 삭제 실패: ${e}`);
    }
  };

  const installUpdate = async () => {
    if (!updateAvailable) return;

    // 개발 모드 체크 (localhost에서 실행 중이면 개발 모드)
    const isDev = window.location.hostname === 'localhost';
    if (isDev) {
      showToast(`⚠️ 개발 모드 - 프로덕션 빌드에서 업데이트 테스트하세요`, 3000);
      return;
    }

    setUpdating(true);
    try {
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
        await relaunch();
      }
    } catch (e) {
      console.error("Update failed:", e);
      showToast(`❌ 업데이트 실패`, 3000);
      setUpdating(false);
    }
  };

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  // Tauri v2 파일 드롭 이벤트 리스너 (여러 방식 시도)
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    const setupDragDrop = async () => {
      // 방법 1: Webview의 onDragDropEvent
      try {
        const webview = getCurrentWebview();
        const unlisten1 = await webview.onDragDropEvent(async (event) => {
          console.log("Webview drag-drop event:", event);
          const evt = (event as any).payload || event;
          if (evt.type === 'drop' && evt.paths?.length > 0) {
            let paths = evt.paths as string[];

            // macOS file:// URL을 일반 경로로 변환
            paths = paths.map((p: string) => {
              if (p.startsWith('file://')) {
                try {
                  // URL 디코딩
                  const url = new URL(p);
                  return decodeURIComponent(url.pathname);
                } catch {
                  return p.replace('file://', '');
                }
              }
              return p;
            });

            console.log("[Webview] 파일 드롭됨:", paths);

            // 직접 pendingFiles에 추가 (useEffect 대신)
            setPendingFiles(prev => {
              const newFiles = paths.filter((path: string) => {
                const fileName = path.split('/').pop() || path;
                return !prev.some(p => p.endsWith(fileName));
              });
              return [...prev, ...newFiles];
            });
            setResult(`파일 ${paths.length}개 추가됨`);
          }
          setIsDraggingFile(evt.type === 'over' || evt.type === 'enter');
        });
        cleanups.push(unlisten1);
        console.log("Webview drag-drop listener OK");
      } catch (e) {
        console.error("Webview drag-drop failed:", e);
        console.error("Webview 드래그 설정 실패:", e);
      }

      // 방법 2: listen으로 tauri://drag-drop 이벤트
      try {
        const unlisten2 = await listen<any>("tauri://drag-drop", (event) => {
          console.log("Listen drag-drop event:", event);
          const paths = event.payload?.paths || event.payload;
          if (Array.isArray(paths) && paths.length > 0) {
            console.log("[Listen] 파일 드롭됨:", paths);
            setDroppedFiles(paths);
            setResult(`파일 ${paths.length}개 감지됨 (listen)`);
          }
          setIsDraggingFile(false);
        });
        cleanups.push(unlisten2);
        console.log("Listen drag-drop listener OK");
      } catch (e) {
        console.error("Listen drag-drop failed:", e);
      }

      // 방법 3: tauri://file-drop 이벤트 (구버전 호환)
      try {
        const unlisten3 = await listen<string[]>("tauri://file-drop", (event) => {
          console.log("File-drop event:", event);
          const paths = event.payload;
          if (Array.isArray(paths) && paths.length > 0) {
            console.log("[File-drop] 파일 드롭됨:", paths);
            setDroppedFiles(paths);
            setResult(`파일 ${paths.length}개 감지됨 (file-drop)`);
          }
          setIsDraggingFile(false);
        });
        cleanups.push(unlisten3);
        console.log("File-drop listener OK");
      } catch (e) {
        console.error("File-drop failed:", e);
      }

      // 드래그 진입/이탈 이벤트
      try {
        const unlisten4 = await listen("tauri://drag-enter", () => setIsDraggingFile(true));
        const unlisten5 = await listen("tauri://drag-leave", () => setIsDraggingFile(false));
        const unlisten6 = await listen("tauri://file-drop-hover", () => setIsDraggingFile(true));
        const unlisten7 = await listen("tauri://file-drop-cancelled", () => setIsDraggingFile(false));
        cleanups.push(unlisten4, unlisten5, unlisten6, unlisten7);
      } catch (e) {
        console.error("Drag enter/leave failed:", e);
      }
    };

    setupDragDrop();

    return () => {
      cleanups.forEach(fn => fn());
    };
  }, []);

  // 드롭된 파일 처리
  useEffect(() => {
    if (droppedFiles.length === 0) return;

    // 디버깅: 드롭된 파일 즉시 표시
    console.log("드롭 이벤트 발생!", { files: droppedFiles, tab, selectedMemo: selectedMemo?.id });

    console.log("Processing dropped files:", droppedFiles);
    console.log("Current state - tab:", tab, "selectedMemo:", selectedMemo?.id, "memoViewTab:", memoViewTab);

    const handleDroppedFiles = async () => {
      if (selectedMemo && memoViewTab === "attachments") {
        // 기존 메모의 첨부 탭에서 드롭 -> 바로 첨부
        console.log("Adding to existing memo attachments");
        for (const filePath of droppedFiles) {
          await addAttachment(filePath);
        }
      } else if (tab === "input" && !selectedMemo) {
        // 새 메모 입력 화면에서 드롭 -> 대기열에 추가
        console.log("Adding to pending files for new memo");
        console.log("파일 감지됨!", droppedFiles);
        setPendingFiles(prev => {
          const newFiles = droppedFiles.filter(path => {
            const fileName = path.split('/').pop() || path;
            return !prev.some(p => p.endsWith(fileName));
          });
          console.log("New pending files:", [...prev, ...newFiles]);
          return [...prev, ...newFiles];
        });
      } else if (selectedMemo) {
        // 다른 탭에서 드롭해도 첨부
        console.log("Adding to selected memo from other tab");
        for (const filePath of droppedFiles) {
          await addAttachment(filePath);
        }
      }
      setDroppedFiles([]);
    };

    handleDroppedFiles();
  }, [droppedFiles, selectedMemo, memoViewTab, tab]);

  // 메모 선택 시 편집 필드 초기화 및 첨부파일 로드
  useEffect(() => {
    if (selectedMemo) {
      setEditTitle(selectedMemo.title);
      setEditContent(selectedMemo.formatted_content);
      setEditCategory(selectedMemo.category);
      setEditTags(selectedMemo.tags);
      setEditOriginal(selectedMemo.content);
      setIsEditing(false);
      loadAttachments(selectedMemo.id);
    } else {
      setAttachments([]);
      setIsEditing(false);
    }
  }, [selectedMemo]);

  // 첨부파일 로드
  const loadAttachments = async (memoId: number) => {
    try {
      console.log("Loading attachments for memo:", memoId);
      const list = await invoke<Attachment[]>("get_attachments", { memoId });
      console.log("Loaded attachments:", list);
      setAttachments(list);
      if (list.length === 0) {
        console.log("No attachments found for memo", memoId);
      }
    } catch (e) {
      console.error("Failed to load attachments:", e);
      setError(`첨부파일 로드 실패: ${e}`);
    }
  };

  // 첨부파일 추가 (중복 체크)
  const addAttachment = async (filePath: string) => {
    if (!selectedMemo) return;

    // 파일명 추출
    const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;

    // 중복 체크: 같은 파일명이 이미 첨부되어 있으면 건너뜀
    const isDuplicate = attachments.some(att => att.file_name === fileName);
    if (isDuplicate) {
      console.log(`File already attached: ${fileName}`);
      return; // 중복이면 추가 안함
    }

    try {
      const attachment = await invoke<Attachment>("add_attachment", {
        memoId: selectedMemo.id,
        filePath
      });
      setAttachments(prev => [attachment, ...prev]);
    } catch (e) {
      console.error("Failed to add attachment:", e);
      setError(String(e));
    }
  };

  // 첨부파일 삭제
  const removeAttachment = async (id: number) => {
    try {
      await invoke("remove_attachment", { id });
      setAttachments(prev => prev.filter(a => a.id !== id));
    } catch (e) {
      console.error("Failed to remove attachment:", e);
    }
  };

  // 첨부파일 열기
  const openAttachment = async (filePath: string) => {
    try {
      await invoke("open_attachment", { filePath });
    } catch (e) {
      console.error("Failed to open attachment:", e);
      setError(`파일을 열 수 없습니다: ${e}`);
    }
  };

  // 파일 드롭 핸들러 (기존 메모 편집용)
  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);

    if (!selectedMemo) return;

    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Tauri에서는 file.path가 실제 파일 경로
      const filePath = (file as any).path;
      if (filePath) {
        await addAttachment(filePath);
      }
    }
  };

  // 파일 드롭 핸들러 (새 메모 입력용 - 대기열에 추가)
  const handleInputFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);

    const files = e.dataTransfer.files;
    const newPaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = (file as any).path;
      if (filePath) {
        // 중복 체크
        const fileName = filePath.split('/').pop() || filePath;
        if (!pendingFiles.some(p => p.endsWith(fileName))) {
          newPaths.push(filePath);
        }
      }
    }
    if (newPaths.length > 0) {
      setPendingFiles(prev => [...prev, ...newPaths]);
    }
  };

  // 대기 중인 파일 제거
  const removePendingFile = (filePath: string) => {
    setPendingFiles(prev => prev.filter(p => p !== filePath));
  };

  // 파일 크기 포맷
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // 토스트 알림 표시 (에러는 더 오래 표시)
  const showToast = (message: string, duration?: number) => {
    // 에러 메시지는 8초, 일반 메시지는 2초
    const isError = message.includes('❌') || message.includes('실패') || message.includes('에러') || message.includes('Error');
    const actualDuration = duration ?? (isError ? 8000 : 2000);
    setToast(message);
    setTimeout(() => setToast(null), actualDuration);
  };

  // 자동 저장 함수 (debounce)
  const autoSave = useCallback(async () => {
    if (!selectedMemo) return;

    setSaving(true);
    try {
      await invoke("update_memo", {
        id: selectedMemo.id,
        title: editTitle,
        formattedContent: editContent,
        category: editCategory,
        tags: editTags,
        content: editOriginal !== selectedMemo.content ? editOriginal : null
      });
      // 사이드바의 메모 목록 업데이트
      setMemos(prev => prev.map(m =>
        m.id === selectedMemo.id
          ? { ...m, title: editTitle, formatted_content: editContent, category: editCategory, tags: editTags, content: editOriginal }
          : m
      ));
      setSelectedMemo(prev => prev ? { ...prev, title: editTitle, formatted_content: editContent, category: editCategory, tags: editTags, content: editOriginal } : null);
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  }, [selectedMemo, editTitle, editContent, editCategory, editTags, editOriginal]);

  // 메모 재분석 (AI로 일정/할일/거래 재추출)
  const reanalyzeMemo = useCallback(async () => {
    if (!selectedMemo) return;

    setReanalyzing(true);
    try {
      const result = await invoke<InputResult>("reanalyze_memo", {
        id: selectedMemo.id,
        newContent: editContent
      });

      if (result.success) {
        // 관련 데이터 새로고침
        const [newSchedules, newTodos, newTransactions] = await Promise.all([
          invoke<Schedule[]>("get_schedules"),
          invoke<Todo[]>("get_todos"),
          invoke<Transaction[]>("get_transactions")
        ]);
        setSchedules(newSchedules);
        setTodos(newTodos);
        setTransactions(newTransactions);
        setResult(`재분석 완료: ${result.message}`);
      } else {
        setError(result.message);
      }
    } catch (e) {
      console.error(e);
      setError(String(e));
    }
    setReanalyzing(false);
  }, [selectedMemo, editContent]);

  // 편집 필드 변경 시 자동 저장 트리거 (1초 debounce)
  useEffect(() => {
    if (!selectedMemo) return;
    if (
      editTitle === selectedMemo.title &&
      editContent === selectedMemo.formatted_content &&
      editCategory === selectedMemo.category &&
      editTags === selectedMemo.tags
    ) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(autoSave, 800);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [editTitle, editContent, editCategory, editTags, autoSave, selectedMemo]);

  const loadSettings = async () => {
    try {
      const key = await invoke<string>("get_setting", { key: "gemini_api_key" });
      const lang = await invoke<string>("get_setting", { key: "language" });
      const dark = await invoke<string>("get_setting", { key: "dark_mode" });
      const aot = await invoke<string>("get_setting", { key: "always_on_top" });
      const op = await invoke<string>("get_setting", { key: "opacity" });
      setApiKey(key);
      // API 키가 없으면 설정 탭으로 이동
      if (!key || key.trim() === "") {
        setTab("settings");
      }
      if (lang) { setLanguage(lang); i18n.changeLanguage(lang); }
      if (dark === "true") setDarkMode(true);
      if (aot === "true") {
        setAlwaysOnTop(true);
        const win = getCurrentWindow();
        win.setAlwaysOnTop(true);
      }
      if (op) {
        const opVal = parseInt(op);
        setOpacity(opVal);
        document.body.style.opacity = `${opVal / 100}`;
      }
      const zoom = await invoke<string>("get_setting", { key: "zoom_level" });
      if (zoom) {
        const zoomVal = parseInt(zoom);
        setZoomLevel(zoomVal);
        document.documentElement.style.fontSize = `${zoomVal}%`;
      }
      const model = await invoke<string>("get_setting", { key: "gemini_model" });
      if (model) setAiModel(model);
      const copyMode = await invoke<string>("get_setting", { key: "attachment_copy_mode" });
      if (copyMode) setAttachmentCopyMode(copyMode);
      // 검색 API 키 로드
      const naverId = await invoke<string>("get_setting", { key: "naver_client_id" });
      const naverSecret = await invoke<string>("get_setting", { key: "naver_client_secret" });
      const googleKey = await invoke<string>("get_setting", { key: "google_search_api_key" });
      const googleCx = await invoke<string>("get_setting", { key: "google_search_cx" });
      if (naverId) setNaverClientId(naverId);
      if (naverSecret) setNaverClientSecret(naverSecret);
      if (googleKey) setGoogleSearchApiKey(googleKey);
      if (googleCx) setGoogleSearchCx(googleCx);
    } catch (e) { console.error(e); }
  };

  const toggleDarkMode = async () => {
    const newMode = !darkMode;
    setDarkMode(newMode);
    try {
      await invoke("save_setting", { key: "dark_mode", value: newMode.toString() });
    } catch (e) { console.error(e); }
  };

  const toggleAlwaysOnTop = async () => {
    const newVal = !alwaysOnTop;
    setAlwaysOnTop(newVal);
    try {
      const win = getCurrentWindow();
      await win.setAlwaysOnTop(newVal);
      await invoke("save_setting", { key: "always_on_top", value: newVal.toString() });
    } catch (e) { console.error(e); }
  };

  const toggleMinimized = async () => {
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const size = await win.innerSize();
      const currentWidth = Math.round(size.width / factor);
      const currentHeight = Math.round(size.height / factor);

      if (!minimized) {
        // 현재 크기 저장 후 높이만 헤더로 줄임
        setSavedWindowSize({ width: currentWidth, height: currentHeight });
        setMinimized(true);
        await win.setSize(new LogicalSize(Math.round(currentWidth / 3), 80));
      } else {
        // 원래 크기로 복원
        setMinimized(false);
        if (savedWindowSize) {
          await win.setSize(new LogicalSize(savedWindowSize.width, savedWindowSize.height));
        } else {
          await win.setSize(new LogicalSize(700, 500));
        }
      }
    } catch (e) { console.error("toggleMinimized error:", e); }
  };

  const toggleMaximize = async () => {
    try {
      const win = getCurrentWindow();
      const maximized = await win.isMaximized();
      if (maximized) {
        await win.unmaximize();
        setIsMaximized(false);
      } else {
        await win.maximize();
        setIsMaximized(true);
      }
    } catch (e) { console.error("toggleMaximize error:", e); }
  };

  // 리서치 실행
  const handleResearch = async () => {
    if (!researchQuery.trim()) return;
    setResearchLoading(true);
    setResearchResult(null);
    setResearchProgress(null);

    // 진행 상황 이벤트 리스너 등록
    const unlisten = await listen<ResearchProgress>("research-progress", (event) => {
      setResearchProgress(event.payload);
    });

    try {
      const result = await invoke<ResearchResult>("run_research", { query: researchQuery });
      setResearchResult(result);
      if (result.memo_id) {
        setToast("리서치 결과가 메모에 자동 저장되었습니다");
        loadMemos(); // 메모 목록 새로고침
      }
    } catch (e) {
      console.error("Research error:", e);
      setToast(`리서치 실패: ${e}`);
    } finally {
      unlisten(); // 리스너 해제
      setResearchLoading(false);
      setResearchProgress(null);
    }
  };

  // 사이드바 리사이즈 핸들러
  const handleSidebarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = Math.max(150, Math.min(400, e.clientX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const loadUsage = async () => {
    try { setUsage(await invoke<UsageStats>("get_usage")); } catch (e) { console.error(e); }
  };

  const loadMemos = async (reset = true) => {
    try {
      if (reset) {
        // 처음부터 로드
        const list = await invoke<Memo[]>("get_memos_paginated", { offset: 0, limit: MEMO_PAGE_SIZE });
        const count = await invoke<number>("get_memo_count");
        setMemos(list);
        setTotalMemoCount(count);
        setMemoOffset(MEMO_PAGE_SIZE);
        setHasMoreMemos(list.length < count);
        setExpandedCategories(new Set());
      }
    } catch (e) { console.error(e); }
  };

  // 더 많은 메모 로드 (무한 스크롤)
  const loadMoreMemos = useCallback(async () => {
    if (loadingMoreMemos || !hasMoreMemos) return;

    setLoadingMoreMemos(true);
    try {
      const list = await invoke<Memo[]>("get_memos_paginated", { offset: memoOffset, limit: MEMO_PAGE_SIZE });
      if (list.length > 0) {
        setMemos(prev => [...prev, ...list]);
        setMemoOffset(prev => prev + MEMO_PAGE_SIZE);
        setHasMoreMemos(memoOffset + list.length < totalMemoCount);
      } else {
        setHasMoreMemos(false);
      }
    } catch (e) { console.error(e); }
    setLoadingMoreMemos(false);
  }, [loadingMoreMemos, hasMoreMemos, memoOffset, totalMemoCount]);

  // 무한 스크롤 IntersectionObserver
  useEffect(() => {
    if (!loadMoreTriggerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMoreMemos && !loadingMoreMemos) {
          loadMoreMemos();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(loadMoreTriggerRef.current);

    return () => observer.disconnect();
  }, [hasMoreMemos, loadingMoreMemos, loadMoreMemos]);

  const loadSchedules = async () => {
    try {
      const list = await invoke<Schedule[]>("get_schedules");
      setSchedules(list);
    } catch (e) { console.error(e); }
  };

  const deleteSchedule = async (id: number) => {
    try {
      await invoke("delete_schedule", { id });
      loadSchedules();
      loadMemos(); // 원본 메모도 삭제되므로 새로고침
    } catch (e) { setError(String(e)); }
  };

  const deleteCategory = async (category: string) => {
    if (!confirm(`"${category}" 카테고리를 삭제하시겠습니까?\n(해당 카테고리의 메모들은 카테고리가 비워집니다)`)) return;
    try {
      await invoke("delete_category", { category });
      loadMemos();
    } catch (e) { setError(String(e)); }
  };

  const renameCategory = async (oldName: string, newName: string) => {
    if (!newName.trim()) return;
    try {
      await invoke("rename_category", { oldName, newName: newName.trim() });
      loadMemos();
      setRenamingCategory(null);
      setNewCategoryName("");
    } catch (e) { setError(String(e)); }
  };

  // 메모 클릭 처리 (Ctrl/Cmd, Shift 지원)
  const handleMemoClick = (memo: Memo, e: React.MouseEvent) => {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (isCtrlOrCmd) {
      // Ctrl/Cmd+클릭: 개별 선택 토글
      setSelectedMemoIds(prev => {
        const newSet = new Set(prev);
        if (newSet.has(memo.id)) {
          newSet.delete(memo.id);
        } else {
          newSet.add(memo.id);
        }
        return newSet;
      });
      setLastSelectedMemoId(memo.id);
    } else if (isShift && lastSelectedMemoId !== null) {
      // Shift+클릭: 범위 선택
      const memoIds = filteredMemos.map(m => m.id);
      const startIdx = memoIds.indexOf(lastSelectedMemoId);
      const endIdx = memoIds.indexOf(memo.id);
      if (startIdx !== -1 && endIdx !== -1) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const rangeIds = memoIds.slice(from, to + 1);
        setSelectedMemoIds(prev => {
          const newSet = new Set(prev);
          rangeIds.forEach(id => newSet.add(id));
          return newSet;
        });
      }
    } else {
      // 일반 클릭: 단일 선택
      setSelectedMemoIds(new Set());
      setSelectedMemo(memo);
      setLastSelectedMemoId(memo.id);
    }
  };

  // 선택된 메모 모두 삭제
  const deleteSelectedMemos = async () => {
    if (selectedMemoIds.size === 0) return;
    if (!confirm(`선택된 ${selectedMemoIds.size}개의 메모를 삭제하시겠습니까?`)) return;
    try {
      for (const id of selectedMemoIds) {
        await invoke("delete_memo", { id });
      }
      setSelectedMemoIds(new Set());
      loadMemos();
    } catch (e) { setError(String(e)); }
  };

  // 선택된 메모 카테고리 이동
  const moveSelectedMemos = async (newCategory: string) => {
    if (selectedMemoIds.size === 0) return;
    try {
      for (const id of selectedMemoIds) {
        const memo = memos.find(m => m.id === id);
        if (memo) {
          await invoke("update_memo", {
            id,
            title: memo.title,
            formattedContent: memo.formatted_content,
            category: newCategory,
            tags: memo.tags,
            content: null
          });
        }
      }
      setSelectedMemoIds(new Set());
      loadMemos();
    } catch (e) { setError(String(e)); }
  };

  // 선택 해제
  const clearSelection = () => {
    setSelectedMemoIds(new Set());
  };

  const loadTodos = async () => {
    try {
      const list = await invoke<Todo[]>("get_todos");
      setTodos(list);
    } catch (e) { console.error(e); }
  };

  const toggleTodo = async (id: number) => {
    try {
      await invoke("toggle_todo", { id });
      loadTodos();
    } catch (e) { setError(String(e)); }
  };

  const deleteTodo = async (id: number) => {
    try {
      await invoke("delete_todo", { id });
      loadTodos();
      loadMemos(); // 원본 메모도 삭제되므로 새로고침
    } catch (e) { setError(String(e)); }
  };

  const handleInput = async () => {
    console.log("저장 시작!", { inputText, pendingFilesCount: pendingFiles.length, pendingFiles });
    if (!inputText.trim() && pendingFiles.length === 0) return;
    const savedText = inputText;
    const filesToAttach = [...pendingFiles];
    setLoading(true); setError(null); setResult(null);
    try {
      console.log("Calling input_memo with:", { content: savedText || "첨부파일" });
      const res = await invoke<InputResult>("input_memo", { content: savedText || "첨부파일" });
      console.log("input_memo result:", res);
      setResult(res.message);

      // 대기 중인 파일들 첨부
      console.log("Checking attachment condition:", { filesToAttachLength: filesToAttach.length, memoId: res.memo_id });
      if (filesToAttach.length > 0 && res.memo_id) {
        let attachedCount = 0;
        const errors: string[] = [];

        // 디버깅: 어떤 파일들이 첨부 대기중인지 표시
        console.log("Files to attach:", filesToAttach);

        for (const filePath of filesToAttach) {
          try {
            console.log("Calling add_attachment with:", { memoId: res.memo_id, filePath });
            await invoke("add_attachment", { memoId: res.memo_id, filePath });
            attachedCount++;
            console.log("Successfully attached:", filePath);
          } catch (e) {
            console.error("Failed to attach file:", filePath, e);
            errors.push(`${filePath.split('/').pop()}: ${e}`);
          }
        }
        setPendingFiles([]);
        if (errors.length > 0) {
          setError(`첨부 실패: ${errors.join(', ')}`);
        } else if (attachedCount > 0) {
          setResult(`${res.message} (첨부파일 ${attachedCount}개 저장됨)`);
        }
      }

      // 저장 후 입력 내용 초기화
      setInputText("");
      loadUsage(); loadMemos(); loadSchedules(); loadTodos(); loadTransactions();
    } catch (e) {
      setError(String(e));
    }
    finally { setLoading(false); }
  };

  const handleSearch = async () => {
    if (!searchText.trim()) return;
    setLoading(true); setError(null); setResult(null); setSearchedAttachments([]);
    try {
      // AI 검색과 첨부 파일 검색 동시 실행
      const [res, attachmentResults] = await Promise.all([
        invoke<SearchResult>("search_memo", { question: searchText }),
        invoke<Attachment[]>("search_attachments", { query: searchText })
      ]);
      setResult(res.answer);
      setSearchedAttachments(attachmentResults);
      loadUsage();
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };

  const handleSaveSettings = async () => {
    try {
      await invoke("save_setting", { key: "gemini_api_key", value: apiKey });
      await invoke("save_setting", { key: "gemini_model", value: aiModel });
      await invoke("save_setting", { key: "language", value: language });
      await invoke("save_setting", { key: "zoom_level", value: zoomLevel.toString() });
      i18n.changeLanguage(language);
      setResult(t("settings.saved"));
      setTimeout(() => setResult(null), 2000);
    } catch (e) { setError(String(e)); }
  };

  const deleteMemo = async () => {
    if (!selectedMemo) return;
    // confirm 제거 - Tauri webview에서 작동 안함
    try {
      await invoke("delete_memo", { id: selectedMemo.id });
      setSelectedMemo(null);
      loadMemos();
    } catch (e) { setError(String(e)); }
  };

  const deleteAllMemos = async () => {
    // confirm 제거 - Tauri webview에서 작동 안함
    try {
      const count = await invoke<number>("delete_all_memos");
      setResult(`${count}개의 메모가 삭제되었습니다.`);
      setSelectedMemo(null);
      loadMemos();
    } catch (e) { setError(String(e)); }
  };

  const handleDrop = async (e: React.DragEvent, targetCategory: string) => {
    e.preventDefault();
    if (draggedMemo && draggedMemo.category !== targetCategory) {
      try {
        await invoke("update_memo", { id: draggedMemo.id, title: draggedMemo.title, formattedContent: draggedMemo.formatted_content, category: targetCategory, tags: draggedMemo.tags });
        loadMemos();
      } catch (e) { setError(String(e)); }
    }
    setDraggedMemo(null); setDragOverCategory(null);
  };

  // 중첩 카테고리 트리 구조
  interface CategoryNode {
    name: string;
    path: string;
    memos: Memo[];
    children: Record<string, CategoryNode>;
  }

  const buildCategoryTree = (memoList: Memo[]): CategoryNode => {
    const root: CategoryNode = { name: "", path: "", memos: [], children: {} };
    const MAX_DEPTH = 2; // 최대 2뎁스로 제한

    memoList.forEach(memo => {
      const category = memo.category || "etc";
      const parts = category.split("/").filter(p => p.trim()).slice(0, MAX_DEPTH); // 2뎁스까지만

      let current = root;
      let currentPath = "";

      parts.forEach((part, index) => {
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        if (!current.children[part]) {
          current.children[part] = {
            name: part,
            path: currentPath,
            memos: [],
            children: {}
          };
        }
        current = current.children[part];

        // 마지막 레벨에 메모 추가
        if (index === parts.length - 1) {
          current.memos.push(memo);
        }
      });
    });

    return root;
  };

  // 필터링된 메모 목록
  const filteredMemos = memoFilter.trim()
    ? memos.filter(m =>
        m.title.toLowerCase().includes(memoFilter.toLowerCase()) ||
        m.content.toLowerCase().includes(memoFilter.toLowerCase()) ||
        m.formatted_content.toLowerCase().includes(memoFilter.toLowerCase())
      )
    : memos;

  const categoryTree = buildCategoryTree(filteredMemos);
  const allCategories = [...new Set(memos.map((m) => m.category || "etc"))];

  // 카테고리 노드 렌더링 (재귀)
  const renderCategoryNode = (node: CategoryNode, depth: number = 0): React.ReactElement[] => {
    const elements: React.ReactElement[] = [];
    const indent = depth * 12;

    Object.values(node.children).forEach(child => {
      const isExpanded = expandedCategories.has(child.path);
      const hasChildren = Object.keys(child.children).length > 0;
      const totalMemos = countMemosInCategory(child);

      elements.push(
        <div
          key={child.path}
          className={`${dragOverCategory === child.path ? 'ring-2 ring-blue-500' : ''}`}
          style={{ marginLeft: `${indent}px` }}
          onDragOver={(e) => { e.preventDefault(); setDragOverCategory(child.path); }}
          onDrop={(e) => handleDrop(e, child.path)}
          onDragLeave={() => setDragOverCategory(null)}
        >
          <div className="flex items-center gap-1 mb-1 group">
            {renamingCategory === child.path ? (
              <div className="flex-1 flex items-center gap-1">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') renameCategory(child.path, newCategoryName);
                    if (e.key === 'Escape') { setRenamingCategory(null); setNewCategoryName(""); }
                  }}
                  className="input flex-1"
                  style={{ fontSize: '10px', padding: '2px 4px' }}
                  autoFocus
                />
                <button onClick={() => renameCategory(child.path, newCategoryName)} style={{ fontSize: '10px' }}>✓</button>
                <button onClick={() => { setRenamingCategory(null); setNewCategoryName(""); }} style={{ fontSize: '10px' }}>✕</button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => {
                    const newSet = new Set(expandedCategories);
                    newSet.has(child.path) ? newSet.delete(child.path) : newSet.add(child.path);
                    setExpandedCategories(newSet);
                  }}
                  className="category flex-1 flex items-center gap-1 cursor-pointer"
                  style={{ fontSize: `${Math.max(10, 11 - depth)}px` }}
                >
                  <span>{isExpanded ? '[-]' : '[+]'}</span>
                  <span className="flex-1 text-left">{child.name === 'etc' ? '미분류' : child.name}</span>
                  <span className="tag">{totalMemos}</span>
                </button>
                {child.path !== 'etc' && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingCategory(child.path); setNewCategoryName(child.name); }}
                      className="opacity-0 group-hover:opacity-100 hover:text-blue-500 px-1"
                      style={{ fontSize: '10px' }}
                      title="카테고리 이름 변경"
                    >✎</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteCategory(child.path); }}
                      className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-700 px-1"
                      style={{ fontSize: '10px' }}
                      title="카테고리 삭제"
                    >✕</button>
                  </>
                )}
              </>
            )}
          </div>

          {isExpanded && (
            <>
              {/* 자식 카테고리 */}
              {hasChildren && renderCategoryNode(child, depth + 1)}

              {/* 이 카테고리의 메모들 */}
              {child.memos.length > 0 && (
                <div className="space-y-1 mb-2" style={{ marginLeft: `${indent + 8}px` }}>
                  {child.memos.map((memo) => (
                    <button
                      key={memo.id}
                      onClick={(e) => handleMemoClick(memo, e)}
                      draggable
                      onDragStart={() => setDraggedMemo(memo)}
                      onDragEnd={() => { setDraggedMemo(null); setDragOverCategory(null); }}
                      className={`w-full text-left px-2 py-1 text-xs cursor-pointer ${draggedMemo?.id === memo.id ? 'opacity-50' : ''}`}
                      style={{
                        border: `1px solid ${selectedMemoIds.has(memo.id) || selectedMemo?.id === memo.id ? 'var(--accent)' : 'var(--border)'}`,
                        background: selectedMemoIds.has(memo.id) ? 'var(--accent-light)' : selectedMemo?.id === memo.id ? 'var(--accent)' : 'var(--bg)',
                        color: selectedMemo?.id === memo.id && selectedMemoIds.size === 0 ? 'var(--accent-text)' : 'var(--text)'
                      }}
                    >
                      <div className="font-bold truncate uppercase">{memo.title}</div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      );
    });

    return elements;
  };

  // 카테고리 내 총 메모 수 계산
  const countMemosInCategory = (node: CategoryNode): number => {
    let count = node.memos.length;
    Object.values(node.children).forEach(child => {
      count += countMemosInCategory(child);
    });
    return count;
  };

  const renderMarkdown = (text: string) => {
    return text.split('\n').map((line, i) => {
      if (line.startsWith('### ')) return <h4 key={i} className="text-sm font-bold mt-4 mb-1 uppercase">{line.slice(4)}</h4>;
      if (line.startsWith('## ')) return <h3 key={i} className="text-base font-bold mt-5 mb-2 uppercase">{line.slice(3)}</h3>;
      if (line.startsWith('# ')) return <h2 key={i} className="text-lg font-bold mt-6 mb-2 uppercase">{line.slice(2)}</h2>;
      if (line.startsWith('- ') || line.startsWith('* ')) return <li key={i} className="ml-5 mb-1 list-disc">{line.slice(2)}</li>;
      if (/^\d+\.\s/.test(line)) return <li key={i} className="ml-5 mb-1 list-decimal">{line.replace(/^\d+\.\s/, '')}</li>;
      if (!line.trim()) return <br key={i} />;
      const parts = line.split(/\*\*(.*?)\*\*/g);
      if (parts.length > 1) return <p key={i} className="mb-1">{parts.map((part, j) => j % 2 === 1 ? <strong key={j}>{part}</strong> : part)}</p>;
      return <p key={i} className="mb-1">{line}</p>;
    });
  };

  // 스플래시 화면
  if (showSplash) {
    return (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
          zIndex: 9999,
          opacity: splashFading ? 0 : 1,
          transition: 'opacity 0.5s ease-out'
        }}
      >
        {/* 로고 애니메이션 */}
        <img
          src="/logo.png"
          alt="JolaJoa Memo"
          style={{
            width: '120px',
            height: '120px',
            marginBottom: '24px',
            animation: 'logoAnim 1.2s ease-out',
            filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.4))',
          }}
        />
        <h1
          style={{
            fontSize: '24px',
            fontWeight: 700,
            color: '#ffffff',
            letterSpacing: '3px',
            marginBottom: '8px',
            animation: 'fadeInUp 0.8s ease-out 0.4s both',
          }}
        >
          JOLAJOA MEMO
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: 'rgba(255,255,255,0.7)',
            animation: 'fadeInUp 0.8s ease-out 0.6s both',
          }}
        >
          {appVersion ? `v${appVersion}` : '로딩중...'}
        </p>
        {updating && (
          <div
            style={{
              marginTop: '24px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: '#4ade80',
              fontSize: '13px',
              animation: 'fadeInUp 0.8s ease-out 0.8s both',
            }}
          >
            <span className="loading-spinner" style={{ width: '16px', height: '16px' }} />
            업데이트 중...
          </div>
        )}
        <style>{`
          @keyframes logoAnim {
            0% {
              opacity: 0;
              transform: scale(0.3) translateY(40px);
            }
            50% {
              opacity: 1;
              transform: scale(1.1) translateY(-10px);
            }
            100% {
              transform: scale(1) translateY(0);
            }
          }
          @keyframes fadeInUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg)' }}>
      {/* ===== TOP NAV BAR - macOS Native Style ===== */}
      <div
        className="flex flex-col select-none"
        style={{
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-light)',
        } as React.CSSProperties}
      >
      {/* 첫 번째 줄 - 기본 네비게이션 */}
      <div
        className="h-10 flex items-center justify-between px-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {!minimized && (
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="btn"
              style={{ padding: '4px 8px' }}
            >
              {sidebarOpen ? '◁' : '▷'}
            </button>
          )}
          {minimized && (
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>📝 JolaJoa Memo</span>
          )}
        </div>

        {!minimized && <nav className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* 그룹 1: 메모, 검색 */}
          <div className="flex gap-1 px-2 py-1" style={{ background: 'var(--bg-secondary)', borderRadius: '6px', marginRight: '12px', border: '1px solid var(--border-light)' }}>
            {[
              { id: "input" as Tab, label: "AI 메모" },
              { id: "search" as Tab, label: "AI 검색" },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => { setTab(item.id); setSelectedMemo(null); setResult(null); }}
                className="btn"
                style={{
                  background: tab === item.id && !selectedMemo ? 'var(--bg-active)' : 'transparent',
                  fontWeight: tab === item.id && !selectedMemo ? 600 : 400,
                  padding: '4px 10px',
                  fontSize: '13px'
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* 그룹 2: 일정, 할일, 가계부 */}
          <div className="flex gap-1 px-2 py-1" style={{ background: 'var(--bg-secondary)', borderRadius: '6px', marginRight: '12px', border: '1px solid var(--border-light)' }}>
            {[
              { id: "schedule" as Tab, label: schedules.length > 0 ? `일정 (${schedules.length})` : '일정' },
              { id: "todo" as Tab, label: todos.filter(t => !t.completed).length > 0 ? `할일 (${todos.filter(t => !t.completed).length})` : '할일' },
              { id: "ledger" as Tab, label: transactions.length > 0 ? `가계부 (${transactions.length})` : '가계부' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => { setTab(item.id); setSelectedMemo(null); setResult(null); }}
                className="btn"
                style={{
                  background: tab === item.id && !selectedMemo ? 'var(--bg-active)' : 'transparent',
                  fontWeight: tab === item.id && !selectedMemo ? 600 : 400,
                  padding: '4px 10px',
                  fontSize: '13px'
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* 설정 */}
          <div className="flex gap-1 px-2 py-1" style={{ background: 'var(--bg-secondary)', borderRadius: '6px', border: '1px solid var(--border-light)' }}>
            <button
              onClick={() => { setTab("settings"); setSelectedMemo(null); setResult(null); }}
              className="btn"
              style={{
                background: tab === "settings" && !selectedMemo ? 'var(--bg-active)' : 'transparent',
                fontWeight: tab === "settings" && !selectedMemo ? 600 : 400,
                padding: '4px 10px',
                fontSize: '13px'
              }}
            >
              설정
            </button>
          </div>
        </nav>}

        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {!minimized && saving && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>저장중...</span>}
          {!minimized && (
            <>
              <button
                onClick={toggleAlwaysOnTop}
                className="btn"
                style={{ padding: '4px 8px', background: alwaysOnTop ? 'var(--bg-active)' : 'transparent' }}
                title="항상 위에"
              >
                📌
              </button>
              <button
                onClick={toggleDarkMode}
                className="btn"
                style={{ padding: '4px 8px' }}
              >
                {darkMode ? '☀️' : '🌙'}
              </button>
            </>
          )}
          {!minimized && (
            <button
              onClick={toggleMaximize}
              className="btn"
              style={{
                padding: '4px 8px',
                background: isMaximized ? 'var(--accent)' : 'transparent',
                color: isMaximized ? 'var(--accent-text)' : 'var(--text)',
                fontWeight: 500,
                fontSize: '12px',
                borderRadius: '4px'
              }}
              title={isMaximized ? "창 복원" : "전체 화면"}
            >
              {isMaximized ? '⊡' : '⬜'}
            </button>
          )}
          <button
            onClick={toggleMinimized}
            className="btn"
            style={{
              padding: minimized ? '4px 12px' : '4px 8px',
              background: minimized ? 'var(--accent)' : 'transparent',
              color: minimized ? 'var(--accent-text)' : 'var(--text)',
              fontWeight: 500,
              fontSize: '12px',
              borderRadius: '4px'
            }}
            title={minimized ? "확대" : "축소"}
          >
            {minimized ? '↗' : '↙'}
          </button>
        </div>
      </div>

      {/* 두 번째 줄 - 도구 (폴더 정리, 리서치) */}
      {!minimized && (
        <div
          className="h-8 flex items-center px-3 gap-2"
          style={{ background: 'var(--bg-tertiary)', borderTop: '1px solid var(--border-light)' }}
        >
          <span style={{ fontSize: '10px', color: 'var(--text-secondary)', marginRight: '4px' }}>도구:</span>
          <div className="flex gap-1">
            {[
              { id: "organize" as Tab, label: '📁 폴더 정리' },
              { id: "consulting" as Tab, label: '🗂️ 파일 컨설팅' },
              { id: "research" as Tab, label: '🔬 리서치' },
              // { id: "collect" as Tab, label: '🗃️ 데이터수집' },
              // { id: "extract" as Tab, label: '🧲 추출' },
              // { id: "agent" as Tab, label: '🤖 에이전트' },
              // { id: "data" as Tab, label: '📊 데이터' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => { setTab(item.id); setSelectedMemo(null); setResult(null); }}
                className="btn"
                style={{
                  background: tab === item.id && !selectedMemo ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: tab === item.id && !selectedMemo ? 'var(--accent-text)' : 'var(--text)',
                  fontWeight: tab === item.id && !selectedMemo ? 600 : 400,
                  padding: '2px 10px',
                  fontSize: '12px',
                  borderRadius: '4px',
                  border: '1px solid var(--border-light)'
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
      </div>

      {/* ===== UPDATE BANNER ===== */}
      {!minimized && updateAvailable && (
        <div style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center justify-center gap-4 px-6 py-2">
            <span style={{ fontSize: '12px', color: 'var(--text)' }}>
              새 버전 {updateAvailable.version} 사용 가능
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setUpdateAvailable(prev => prev ? { ...prev, showDetails: !prev.showDetails } : null)}
                className="px-2 py-1 font-medium"
                style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', fontSize: '10px' }}
              >
                {updateAvailable.showDetails ? '숨기기' : '변경사항'}
              </button>
              <button
                onClick={installUpdate}
                disabled={updating}
                className="px-2 py-1 font-medium"
                style={{ background: 'var(--text)', color: 'var(--bg)', border: 'none', fontSize: '10px' }}
              >
                {updating ? '업데이트 중...' : '업데이트'}
              </button>
            </div>
          </div>
          {updateAvailable.showDetails && updateAvailable.body && (
            <div className="px-6 pb-3">
              <div className="p-3 text-sm" style={{ background: 'var(--bg)', maxHeight: '150px', overflowY: 'auto', color: 'var(--text-secondary)', borderRadius: '4px' }}>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '11px' }}>{updateAvailable.body}</pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== MAIN LAYOUT ===== */}
      {!minimized && <div className="flex-1 flex overflow-hidden">
        {/* ===== LEFT SIDEBAR ===== */}
        {sidebarOpen && (
        <div className="flex flex-col overflow-hidden" style={{ width: `${sidebarWidth}px`, minWidth: '150px', maxWidth: '400px', background: 'var(--bg-secondary)' }}>
          <div className="px-3 py-2 flex justify-between items-center">
            <span className="section-label">메모 ({memos.length}/{totalMemoCount})</span>
            <button
              onClick={() => {
                if (expandedCategories.size > 0) {
                  setExpandedCategories(new Set());
                } else {
                  setExpandedCategories(new Set(allCategories));
                }
              }}
              className="btn"
              style={{ padding: '2px 6px', fontSize: '11px' }}
            >
              {expandedCategories.size > 0 ? '접기' : '펼치기'}
            </button>
          </div>

          {/* 실시간 검색 필터 */}
          <div className="px-2 pb-2">
            <input
              type="text"
              value={memoFilter}
              onChange={(e) => setMemoFilter(e.target.value)}
              placeholder="🔍 제목/내용 검색..."
              className="input w-full"
              style={{ padding: '4px 8px', fontSize: '11px' }}
            />
          </div>

          {/* 다중 선택 시 액션 바 */}
          {selectedMemoIds.size > 0 && (
            <div className="px-2 pb-2 flex items-center gap-2 flex-wrap" style={{ background: 'var(--bg-secondary)', borderRadius: '4px', margin: '0 8px 8px', padding: '6px' }}>
              <span style={{ fontSize: '10px', fontWeight: 'bold' }}>{selectedMemoIds.size}개 선택</span>
              <button
                onClick={clearSelection}
                className="btn"
                style={{ fontSize: '10px', padding: '2px 6px' }}
              >
                선택 해제
              </button>
              <button
                onClick={deleteSelectedMemos}
                className="btn"
                style={{ fontSize: '10px', padding: '2px 6px', color: 'var(--error)' }}
              >
                삭제
              </button>
              <select
                onChange={(e) => { if (e.target.value) moveSelectedMemos(e.target.value); e.target.value = ''; }}
                className="input"
                style={{ fontSize: '10px', padding: '2px 4px' }}
                defaultValue=""
              >
                <option value="">카테고리 이동...</option>
                {allCategories.filter(c => c !== 'etc').map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
                <option value="">미분류로</option>
              </select>
              <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Ctrl+클릭: 개별선택 | Shift+클릭: 범위선택</span>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-2" ref={memoListRef}>
            {Object.keys(categoryTree.children).length === 0 ? (
              <div className="empty-state">
                <p style={{ fontSize: '12px' }}>메모가 없습니다</p>
              </div>
            ) : (
              <>
                {renderCategoryNode(categoryTree)}
                <div ref={loadMoreTriggerRef} className="py-3 text-center">
                  {hasMoreMemos ? (
                    loadingMoreMemos ? (
                      <span className="loading-spinner" />
                    ) : (
                      <button onClick={loadMoreMemos} className="btn" style={{ fontSize: '11px' }}>
                        더 보기
                      </button>
                    )
                  ) : null}
                </div>
              </>
            )}
          </div>

          {usage && (
            <div className="px-3 py-2" style={{ borderTop: '1px solid var(--border-light)', fontSize: '11px', color: 'var(--text-muted)' }}>
              <div className="flex justify-between">
                <span>{usage.today_input_tokens + usage.today_output_tokens} 토큰</span>
                <span>${usage.today_cost_usd.toFixed(4)}</span>
              </div>
            </div>
          )}
        </div>
        )}

        {/* ===== SIDEBAR RESIZE HANDLE ===== */}
        {sidebarOpen && (
          <div
            onMouseDown={handleSidebarMouseDown}
            style={{
              width: '4px',
              cursor: 'col-resize',
              background: isResizing ? 'var(--accent)' : 'var(--border-light)',
              transition: 'background 0.15s',
              flexShrink: 0
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent)')}
            onMouseLeave={(e) => !isResizing && (e.currentTarget.style.background = 'var(--border-light)')}
          />
        )}

        {/* ===== MAIN CONTENT ===== */}
        <div className="flex-1 overflow-auto p-4 flex flex-col" style={{ background: 'var(--bg)' }}>
          {/* ===== HOME DASHBOARD + MEMO INPUT ===== */}
          {tab === "input" && !selectedMemo && (() => {
            // 오늘/내일 일정 (로컬 시간 사용)
            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const tomorrow = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;
            const upcomingSchedules = schedules.filter(s => {
              const date = s.start_time?.split('T')[0];
              return date && date >= today;
            }).slice(0, 3);

            // 미완료 할일
            const pendingTodos = todos.filter(t => !t.completed).slice(0, 3);

            // 이번달 가계부
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const monthTxs = transactions.filter(tx => {
              const date = tx.tx_date || tx.created_at;
              return date?.startsWith(currentMonth);
            });
            const monthIncome = monthTxs.filter(t => t.tx_type === 'income').reduce((s, t) => s + t.amount, 0);
            const monthExpense = monthTxs.filter(t => t.tx_type === 'expense').reduce((s, t) => s + t.amount, 0);

            return (
              <div className="flex flex-col gap-3 flex-1">
                {/* ===== DASHBOARD CARDS ===== */}
                <div className="grid grid-cols-3 gap-3">
                  {/* 일정 카드 */}
                  <div
                    onClick={() => setTab("schedule")}
                    className="card cursor-pointer transition-all hover:shadow-md"
                    style={{ padding: '12px' }}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>📅 일정</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{schedules.length}개</span>
                    </div>
                    {upcomingSchedules.length === 0 ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>예정된 일정 없음</div>
                    ) : (
                      <div className="space-y-1">
                        {upcomingSchedules.map(s => (
                          <div key={s.id} style={{ fontSize: '11px' }} className="truncate">
                            <span style={{ color: 'var(--accent)', marginRight: '4px' }}>
                              {s.start_time?.split('T')[0] === today ? '오늘' :
                               s.start_time?.split('T')[0] === tomorrow ? '내일' :
                               s.start_time?.substring(5, 10)}
                            </span>
                            {s.title}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 할일 카드 */}
                  <div
                    onClick={() => setTab("todo")}
                    className="card cursor-pointer transition-all hover:shadow-md"
                    style={{ padding: '12px' }}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>✓ 할일</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{todos.filter(t => !t.completed).length}개</span>
                    </div>
                    {pendingTodos.length === 0 ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>할일 없음</div>
                    ) : (
                      <div className="space-y-1">
                        {pendingTodos.map(t => (
                          <div key={t.id} style={{ fontSize: '11px' }} className="truncate flex items-center gap-1">
                            {t.priority === 'high' && <span style={{ color: 'var(--error)' }}>●</span>}
                            {t.title}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 가계부 카드 */}
                  <div
                    onClick={() => setTab("ledger")}
                    className="card cursor-pointer transition-all hover:shadow-md"
                    style={{ padding: '12px' }}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>💰 이번달</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{monthTxs.length}건</span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between" style={{ fontSize: '11px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>수입</span>
                        <span style={{ color: 'var(--success)', fontWeight: 500 }}>+{monthIncome.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: '11px' }}>
                        <span style={{ color: 'var(--text-muted)' }}>지출</span>
                        <span style={{ color: 'var(--error)', fontWeight: 500 }}>-{monthExpense.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: '11px', borderTop: '1px solid var(--border-light)', paddingTop: '4px', marginTop: '4px' }}>
                        <span style={{ fontWeight: 500 }}>잔액</span>
                        <span style={{ fontWeight: 600, color: monthIncome - monthExpense >= 0 ? 'var(--success)' : 'var(--error)' }}>
                          {(monthIncome - monthExpense).toLocaleString()}원
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ===== MEMO INPUT ===== */}
                <div
                  className="card flex-1 flex flex-col"
                  style={{
                    padding: '8px',
                    border: isDraggingFile ? '2px dashed var(--accent)' : undefined,
                    background: isDraggingFile ? 'rgba(59, 130, 246, 0.05)' : undefined
                  }}
                  onDragOver={(e) => { e.preventDefault(); setIsDraggingFile(true); }}
                  onDragLeave={() => setIsDraggingFile(false)}
                  onDrop={handleInputFileDrop}
                >
                  <div className="card-header flex justify-between items-center" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>
                    <span>
                      {t("input.title")}
                      {loading && <span style={{ marginLeft: '8px', color: 'var(--text-muted)' }}>저장중...</span>}
                      {!loading && result && <span style={{ marginLeft: '8px', color: 'var(--success)' }}>✓ {result}</span>}
                    </span>
                    <div className="flex gap-2">
                      {(inputText.trim() || pendingFiles.length > 0) && (
                        <button
                          onClick={() => { setInputText(""); setPendingFiles([]); setResult(null); setError(null); }}
                          disabled={loading}
                          className="btn"
                          style={{ padding: '4px 10px', fontSize: '11px' }}
                        >
                          새로 작성
                        </button>
                      )}
                      <button
                        onClick={handleInput}
                        disabled={loading || (!inputText.trim() && pendingFiles.length === 0)}
                        className="btn btn-primary"
                        style={{ padding: '4px 12px', fontSize: '11px' }}
                      >
                        {loading ? 'AI 저장중...' : 'AI 저장'}
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && (inputText.trim() || pendingFiles.length > 0) && !loading) {
                        handleInput();
                      }
                    }}
                    placeholder={isDraggingFile ? '여기에 파일을 놓으세요!' : t("input.placeholder")}
                    className="input resize-none flex-1"
                    style={{ fontSize: '12px' }}
                    disabled={loading}
                  />

                  {/* 대기 중인 파일 목록 */}
                  {pendingFiles.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {pendingFiles.map((filePath, idx) => {
                        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
                        return (
                          <div
                            key={idx}
                            className="flex items-center gap-1 px-2 py-1"
                            style={{ background: 'var(--bg-secondary)', borderRadius: '4px', fontSize: '10px' }}
                          >
                            <span>📎 {fileName}</span>
                            <button
                              onClick={() => removePendingFile(filePath)}
                              style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px' }}
                            >✕</button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center justify-between" style={{ marginTop: '4px' }}>
                    <div className="flex items-center gap-2">
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        ⌘/Ctrl+Enter로 저장
                      </span>
                      <button
                        onClick={async () => {
                          try {
                            console.log("Opening file dialog...");
                            const selected = await open({
                              multiple: true,
                              title: "첨부할 파일 선택"
                            });
                            console.log("Dialog result:", selected);
                            if (selected) {
                              const paths = Array.isArray(selected) ? selected : [selected];
                              console.log("Paths to add:", paths);
                              setPendingFiles(prev => {
                                const newFiles = paths.filter(path => {
                                  if (!path) return false;
                                  const fileName = path.split('/').pop() || path;
                                  return !prev.some(p => p.endsWith(fileName));
                                });
                                console.log("New pending files:", [...prev, ...newFiles]);
                                return [...prev, ...newFiles.filter(Boolean) as string[]];
                              });
                            }
                          } catch (e) {
                            console.error("File dialog error:", e);
                            setError(`파일 선택 오류: ${e}`);
                          }
                        }}
                        className="btn"
                        style={{ fontSize: '10px', padding: '2px 6px' }}
                      >
                        📁 파일 선택
                      </button>
                    </div>
                    {error && <span style={{ fontSize: '10px', color: 'var(--error)' }}>{error}</span>}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ===== SEARCH ===== */}
          {tab === "search" && !selectedMemo && (
            <div>
              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>{t("search.title")}</div>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder={t("search.placeholder")}
                    className="input flex-1"
                    style={{ fontSize: '14px', padding: '10px 12px' }}
                    disabled={loading}
                  />
                  <button onClick={handleSearch} disabled={loading || !searchText.trim()} className="btn btn-primary" style={{ padding: '4px 12px', fontSize: '11px' }}>
                    {loading && <span className="loading-spinner mr-1" style={{ width: '10px', height: '10px' }} />}
                    AI 검색
                  </button>
                </div>
                {result && (
                  <div className="code-block mt-2" style={{ padding: '8px', fontSize: '12px' }}>
                    <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>AI_RESPONSE</div>
                    <div>{renderMarkdown(result)}</div>
                  </div>
                )}
                {/* 첨부 파일 검색 결과 */}
                {searchedAttachments.length > 0 && (
                  <div className="code-block mt-2" style={{ padding: '8px', fontSize: '12px' }}>
                    <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>
                      첨부 파일 ({searchedAttachments.length}개)
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {searchedAttachments.map((att) => {
                        const relatedMemo = memos.find(m => m.id === att.memo_id);
                        return (
                          <div
                            key={att.id}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '4px',
                              padding: '6px 8px',
                              background: 'var(--bg-secondary)',
                              borderRadius: '4px',
                              fontSize: '11px'
                            }}
                          >
                            {/* 첨부 파일 정보 */}
                            <div
                              onClick={async () => {
                                try {
                                  await invoke("open_attachment", { id: att.id });
                                } catch (e) {
                                  setError(String(e));
                                }
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                cursor: 'pointer'
                              }}
                              className="hover-highlight"
                            >
                              <span style={{ fontSize: '14px' }}>📎</span>
                              <div style={{ flex: 1, overflow: 'hidden' }}>
                                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {att.file_name}
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-tertiary)' }}>
                                  {(att.file_size / 1024).toFixed(1)} KB
                                </div>
                              </div>
                              <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>파일 열기</span>
                            </div>
                            {/* 연관 메모 */}
                            {relatedMemo && (
                              <div
                                onClick={() => {
                                  setSelectedMemo(relatedMemo);
                                  setEditTitle(relatedMemo.title);
                                  setEditContent(relatedMemo.formatted_content);
                                  setEditCategory(relatedMemo.category);
                                  setEditTags(relatedMemo.tags);
                                  setEditOriginal(relatedMemo.content);
                                  setMemoViewTab("formatted");
                                  setIsEditing(false);
                                }}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                  padding: '4px 6px',
                                  marginLeft: '22px',
                                  background: 'var(--bg-tertiary)',
                                  borderRadius: '3px',
                                  cursor: 'pointer',
                                  fontSize: '10px',
                                  color: 'var(--text-secondary)'
                                }}
                                className="hover-highlight"
                              >
                                <span>📝</span>
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {relatedMemo.title}
                                </span>
                                <span style={{ fontSize: '9px', color: 'var(--text-tertiary)' }}>메모 보기</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {error && <p className="status status-error mt-2" style={{ fontSize: '10px' }}>{error}</p>}
              </div>
            </div>
          )}

          {/* ===== SCHEDULE (Linear Style) ===== */}
          {tab === "schedule" && !selectedMemo && (
            <div className="space-y-1">
              {/* 섹션 헤더 */}
              <div className="section-header">
                일정 ({schedules.length})
              </div>
              {schedules.length === 0 ? (
                <div className="empty-state">
                  <p>아직 일정이 없습니다.</p>
                  <p style={{ fontSize: '12px', marginTop: '4px' }}>메모에 날짜/시간이 포함되면 자동으로 추출됩니다.</p>
                </div>
              ) : (
                <div>
                  {schedules.map((schedule) => {
                    // 오늘/내일 체크 (로컬 시간 사용)
                    const now = new Date();
                    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                    const tomorrow = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;
                    const scheduleDate = schedule.start_time?.split('T')[0];
                    const isToday = scheduleDate === today;
                    const isTomorrow = scheduleDate === tomorrow;
                    const isPast = scheduleDate && scheduleDate < today;

                    return (
                      <div
                        key={schedule.id}
                        className="list-item"
                        style={{
                          opacity: isPast ? 0.5 : 1,
                          background: isToday ? 'var(--bg-selected)' : 'transparent'
                        }}
                      >
                        {/* 날짜 아이콘 */}
                        <div
                          className="list-item-avatar"
                          style={{
                            background: isToday ? 'var(--accent)' : isTomorrow ? 'var(--accent-light)' : 'var(--bg-secondary)',
                            color: isToday ? 'var(--accent-text)' : 'var(--text-secondary)',
                            width: '36px',
                            height: '36px',
                            fontSize: '10px',
                            flexDirection: 'column',
                            lineHeight: 1.2
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>{scheduleDate?.substring(8, 10) || '??'}</span>
                          <span style={{ fontSize: '8px' }}>{scheduleDate?.substring(5, 7)}월</span>
                        </div>

                        {/* 내용 */}
                        <div className="list-item-content">
                          <div className="list-item-title">{schedule.title}</div>
                          <div className="list-item-meta">
                            {schedule.start_time && (
                              <span style={{ color: isToday ? 'var(--accent-text)' : 'var(--text-muted)' }}>
                                {isToday ? '오늘' : isTomorrow ? '내일' : ''} {schedule.start_time?.substring(11, 16)}
                                {schedule.end_time && ` - ${schedule.end_time?.substring(11, 16)}`}
                              </span>
                            )}
                            {schedule.location && (
                              <span>📍 {schedule.location}</span>
                            )}
                          </div>
                        </div>

                        {/* 삭제 버튼 */}
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteSchedule(schedule.id); }}
                          className="icon-btn"
                          style={{ width: '24px', height: '24px', fontSize: '12px', color: 'var(--text-muted)' }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ===== TODO (Linear Style) ===== */}
          {tab === "todo" && !selectedMemo && (
            <div className="space-y-1">
              {/* 미완료 섹션 */}
              <div className="section-header">
                할일 ({todos.filter(t => !t.completed).length})
              </div>
              {todos.length === 0 ? (
                <div className="empty-state">
                  <p>아직 할일이 없습니다.</p>
                  <p style={{ fontSize: '12px', marginTop: '4px' }}>메모에 "~해야 한다" 같은 내용이 있으면 자동으로 추출됩니다.</p>
                </div>
              ) : (
                <>
                  {/* 미완료 할일 */}
                  <div>
                    {todos.filter(t => !t.completed).map((todo) => (
                      <div
                        key={todo.id}
                        className="list-item"
                        style={{ background: todo.priority === 'high' ? 'rgba(239, 68, 68, 0.05)' : 'transparent' }}
                      >
                        {/* 체크박스 */}
                        <button
                          onClick={() => toggleTodo(todo.id)}
                          className="flex-shrink-0"
                          style={{
                            width: '18px',
                            height: '18px',
                            borderRadius: '4px',
                            border: `2px solid ${todo.priority === 'high' ? 'var(--error)' : 'var(--border)'}`,
                            background: 'transparent',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            padding: 0
                          }}
                        />

                        {/* 내용 */}
                        <div className="list-item-content">
                          <div className="list-item-title">{todo.title}</div>
                          <div className="list-item-meta">
                            {todo.priority && (
                              <span className="priority">
                                {todo.priority === 'high' ? '★★★' : todo.priority === 'medium' ? '★★' : '★'}
                              </span>
                            )}
                            {todo.due_date && <span>{todo.due_date.substring(5)}</span>}
                          </div>
                        </div>

                        {/* 삭제 버튼 */}
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteTodo(todo.id); }}
                          className="icon-btn"
                          style={{ width: '24px', height: '24px', fontSize: '12px', color: 'var(--text-muted)' }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* 완료된 할일 */}
                  {todos.filter(t => t.completed).length > 0 && (
                    <>
                      <div className="section-header" style={{ marginTop: '16px' }}>
                        완료 ({todos.filter(t => t.completed).length})
                      </div>
                      <div>
                        {todos.filter(t => t.completed).map((todo) => (
                          <div
                            key={todo.id}
                            className="list-item"
                            style={{ opacity: 0.5 }}
                          >
                            {/* 체크박스 */}
                            <button
                              onClick={() => toggleTodo(todo.id)}
                              className="flex-shrink-0"
                              style={{
                                width: '18px',
                                height: '18px',
                                borderRadius: '4px',
                                border: '2px solid var(--success)',
                                background: 'var(--success)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                padding: 0,
                                color: '#fff',
                                fontSize: '10px'
                              }}
                            >
                              ✓
                            </button>

                            {/* 내용 */}
                            <div className="list-item-content">
                              <div className="list-item-title" style={{ textDecoration: 'line-through' }}>{todo.title}</div>
                            </div>

                            {/* 삭제 버튼 */}
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteTodo(todo.id); }}
                              className="icon-btn"
                              style={{ width: '24px', height: '24px', fontSize: '12px', color: 'var(--text-muted)' }}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* ===== LEDGER (Linear Style) ===== */}
          {tab === "ledger" && !selectedMemo && (() => {
            // 월별로 그룹화
            const groupByMonth = (txList: Transaction[]) => {
              const groups: Record<string, Transaction[]> = {};
              txList.forEach(tx => {
                const dateStr = tx.tx_date || tx.created_at;
                const month = dateStr ? dateStr.substring(0, 7) : 'unknown';
                if (!groups[month]) groups[month] = [];
                groups[month].push(tx);
              });
              return groups;
            };

            const monthlyGroups = groupByMonth(transactions);
            const sortedMonths = Object.keys(monthlyGroups).sort().reverse();
            const now = new Date();
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

            // 전체 요약
            const totalIncome = transactions.filter(t => t.tx_type === 'income').reduce((s, t) => s + t.amount, 0);
            const totalExpense = transactions.filter(t => t.tx_type === 'expense').reduce((s, t) => s + t.amount, 0);

            return (
              <div className="space-y-1">
                {transactions.length === 0 ? (
                  <div className="empty-state">
                    <p>아직 거래 내역이 없습니다.</p>
                    <p style={{ fontSize: '12px', marginTop: '4px' }}>메모에 금액이 포함되면 자동으로 추출됩니다.</p>
                    <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--text-muted)' }}>예: "커피 5000원", "월급 300만원 입금"</p>
                  </div>
                ) : (
                  <>
                    {/* 전체 요약 헤더 */}
                    <div style={{
                      display: 'flex',
                      gap: '16px',
                      padding: '12px 16px',
                      background: 'var(--bg-secondary)',
                      borderRadius: 'var(--radius-lg)',
                      marginBottom: '8px'
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>총 수입</div>
                        <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--success)' }}>+{totalIncome.toLocaleString()}</div>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>총 지출</div>
                        <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--error)' }}>-{totalExpense.toLocaleString()}</div>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>잔액</div>
                        <div style={{ fontSize: '16px', fontWeight: 600, color: totalIncome - totalExpense >= 0 ? 'var(--success)' : 'var(--error)' }}>
                          {(totalIncome - totalExpense).toLocaleString()}원
                        </div>
                      </div>
                    </div>

                    {/* 월별 섹션 */}
                    {sortedMonths.map(month => {
                      const monthTxs = monthlyGroups[month];
                      const income = monthTxs.filter(t => t.tx_type === 'income').reduce((sum, t) => sum + t.amount, 0);
                      const expense = monthTxs.filter(t => t.tx_type === 'expense').reduce((sum, t) => sum + t.amount, 0);

                      const [, mon] = month.split('-');
                      const monthLabel = month === 'unknown' ? '날짜 미상' : `${parseInt(mon)}월`;
                      const isCurrentMonth = month === currentMonth;

                      return (
                        <div key={month}>
                          {/* 월 섹션 헤더 */}
                          <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>
                              {monthLabel} {isCurrentMonth && <span style={{ color: 'var(--accent)', fontWeight: 500 }}>이번달</span>}
                              <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>{monthTxs.length}건</span>
                            </span>
                            <span style={{ fontSize: '11px' }}>
                              <span style={{ color: 'var(--success)' }}>+{income.toLocaleString()}</span>
                              <span style={{ margin: '0 4px' }}>/</span>
                              <span style={{ color: 'var(--error)' }}>-{expense.toLocaleString()}</span>
                            </span>
                          </div>

                          {/* 거래 목록 */}
                          <div>
                            {monthTxs.map((tx) => (
                              <div
                                key={tx.id}
                                className="list-item"
                                style={{ background: editingTx?.id === tx.id ? 'var(--bg-secondary)' : 'transparent' }}
                              >
                                {editingTx?.id === tx.id ? (
                                  // 수정 모드
                                  <div className="flex-1 space-y-2" style={{ padding: '8px 0' }}>
                                    <div className="flex gap-2">
                                      <select
                                        value={editTxType}
                                        onChange={(e) => setEditTxType(e.target.value)}
                                        className="input"
                                        style={{ padding: '6px 8px', fontSize: '12px', width: '80px' }}
                                      >
                                        <option value="income">수입</option>
                                        <option value="expense">지출</option>
                                      </select>
                                      <input
                                        type="number"
                                        value={editTxAmount}
                                        onChange={(e) => setEditTxAmount(e.target.value)}
                                        className="input flex-1"
                                        placeholder="금액"
                                        style={{ padding: '6px 8px', fontSize: '12px' }}
                                      />
                                    </div>
                                    <input
                                      type="text"
                                      value={editTxDesc}
                                      onChange={(e) => setEditTxDesc(e.target.value)}
                                      className="input w-full"
                                      placeholder="설명"
                                      style={{ padding: '6px 8px', fontSize: '12px' }}
                                    />
                                    <div className="flex gap-2">
                                      <input
                                        type="text"
                                        value={editTxCategory}
                                        onChange={(e) => setEditTxCategory(e.target.value)}
                                        className="input flex-1"
                                        placeholder="카테고리"
                                        style={{ padding: '6px 8px', fontSize: '12px' }}
                                      />
                                      <input
                                        type="date"
                                        value={editTxDate}
                                        onChange={(e) => setEditTxDate(e.target.value)}
                                        className="input"
                                        style={{ padding: '6px 8px', fontSize: '12px' }}
                                      />
                                    </div>
                                    <div className="flex gap-2">
                                      <button onClick={saveEditTx} className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px' }}>저장</button>
                                      <button onClick={() => setEditingTx(null)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>취소</button>
                                    </div>
                                  </div>
                                ) : (
                                  // 일반 모드
                                  <>
                                    {/* 아이콘 */}
                                    <div
                                      className="list-item-avatar"
                                      style={{
                                        background: tx.tx_type === 'income' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                        color: tx.tx_type === 'income' ? 'var(--success)' : 'var(--error)',
                                        fontSize: '14px'
                                      }}
                                    >
                                      {tx.tx_type === 'income' ? '↑' : '↓'}
                                    </div>

                                    {/* 내용 */}
                                    <div className="list-item-content">
                                      <div className="list-item-title">{tx.description}</div>
                                      <div className="list-item-meta">
                                        {tx.category && <span className="tag">{tx.category}</span>}
                                        <span>{tx.tx_date?.substring(5) || tx.created_at.substring(5, 10)}</span>
                                      </div>
                                    </div>

                                    {/* 금액 */}
                                    <div style={{
                                      fontSize: '14px',
                                      fontWeight: 600,
                                      color: tx.tx_type === 'income' ? 'var(--success)' : 'var(--error)',
                                      marginRight: '8px'
                                    }}>
                                      {tx.tx_type === 'income' ? '+' : '-'}{tx.amount.toLocaleString()}
                                    </div>

                                    {/* 액션 버튼 */}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); startEditTx(tx); }}
                                      className="icon-btn"
                                      style={{ width: '24px', height: '24px', fontSize: '12px', color: 'var(--text-muted)' }}
                                    >
                                      ✎
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); deleteTx(tx.id); }}
                                      className="icon-btn"
                                      style={{ width: '24px', height: '24px', fontSize: '12px', color: 'var(--text-muted)' }}
                                    >
                                      ✕
                                    </button>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            );
          })()}

          {/* ===== ORGANIZE (폴더 정리) ===== */}
          {tab === "organize" && !selectedMemo && (
            <div className="space-y-4">
              {/* 단계 표시 */}
              <div className="card" style={{ padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  {['폴더 선택', '정리 방식', '미리보기', '완료'].map((step, idx) => {
                    const phases = ['select-folder', 'select-method', 'preview', 'done'];
                    const currentIdx = phases.indexOf(organizePhase);
                    const isActive = idx === currentIdx;
                    const isDone = idx < currentIdx;
                    return (
                      <React.Fragment key={step}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          color: isActive ? 'var(--accent)' : isDone ? 'var(--success)' : 'var(--text-secondary)',
                          fontWeight: isActive ? 600 : 400,
                          fontSize: '12px'
                        }}>
                          <span style={{
                            width: '20px',
                            height: '20px',
                            borderRadius: '50%',
                            background: isActive ? 'var(--accent)' : isDone ? 'var(--success)' : 'var(--bg-secondary)',
                            color: isActive || isDone ? 'white' : 'var(--text-secondary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '11px',
                            fontWeight: 600
                          }}>
                            {isDone ? '✓' : idx + 1}
                          </span>
                          {step}
                        </div>
                        {idx < 3 && <span style={{ color: 'var(--border-light)' }}>→</span>}
                      </React.Fragment>
                    );
                  })}
                </div>
                {organizeBasePath && (
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                    📂 {organizeBasePath}
                  </div>
                )}
              </div>

              {/* STEP 1: 폴더 선택 */}
              {organizePhase === 'select-folder' && (
                <div className="card" style={{ padding: '20px', textAlign: 'center' }}>
                  <div style={{ fontSize: '48px', marginBottom: '16px' }}>📁</div>
                  <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>정리할 폴더를 선택하세요</h3>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                    AI가 폴더 안의 파일들을 분석하고 정리 방안을 제안해드려요
                  </p>
                  <button
                    onClick={async () => {
                      try {
                        const selected = await open({
                          directory: true,
                          multiple: false,
                          title: "정리할 폴더 선택"
                        });
                        if (selected && typeof selected === 'string') {
                          setOrganizeBasePath(selected);
                          setOrganizeLoading(true);
                          setOrganizeStep("📂 폴더 스캔 중...");

                          const files = await invoke<FileInfo[]>("scan_folder", { path: selected });
                          setOrganizeFiles(files);
                          setOrganizeLoading(false);
                          setOrganizePhase('select-method');
                        }
                      } catch (e) {
                        console.error(e);
                        setOrganizeLoading(false);
                        setOrganizeResult(`오류: ${e}`);
                      }
                    }}
                    disabled={organizeLoading}
                    className="btn"
                    style={{
                      background: 'var(--accent)',
                      color: 'white',
                      padding: '12px 32px',
                      fontSize: '14px'
                    }}
                  >
                    {organizeLoading ? '🔄 스캔 중...' : '📂 폴더 선택하기'}
                  </button>
                </div>
              )}

              {/* STEP 2: 정리 방식 선택 */}
              {organizePhase === 'select-method' && (
                <div className="card" style={{ padding: '20px' }}>
                  <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px', textAlign: 'center' }}>
                    어떻게 정리할까요?
                  </h3>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px', textAlign: 'center' }}>
                    {organizeFiles.filter(f => !f.is_dir).length}개 파일을 발견했어요. 정리 방식을 선택해주세요.
                  </p>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    {[
                      { id: 'type', icon: '📦', title: '종류별', desc: '이미지, 문서, 영상, 음악 등 파일 유형으로 분류' },
                      { id: 'date', icon: '📅', title: '날짜별', desc: '2024년, 2023년 등 파일 수정 날짜로 분류' },
                      { id: 'topic', icon: '🏷️', title: '주제별', desc: '파일명의 키워드를 분석해서 주제로 분류' },
                      { id: 'smart', icon: '🤖', title: 'AI 추천', desc: 'AI가 가장 적합한 방식으로 자동 분류' },
                    ].map((method) => (
                      <button
                        key={method.id}
                        onClick={() => setOrganizeMethod(method.id)}
                        className="card"
                        style={{
                          padding: '16px',
                          textAlign: 'left',
                          cursor: 'pointer',
                          border: organizeMethod === method.id ? '2px solid var(--accent)' : '1px solid var(--border-light)',
                          background: organizeMethod === method.id ? 'var(--bg-active)' : 'var(--bg)',
                          transition: 'all 0.2s ease'
                        }}
                      >
                        <div style={{ fontSize: '24px', marginBottom: '8px' }}>{method.icon}</div>
                        <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>{method.title}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{method.desc}</div>
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
                    <button
                      onClick={() => {
                        setOrganizePhase('select-folder');
                        setOrganizeBasePath('');
                        setOrganizeFiles([]);
                      }}
                      className="btn"
                      style={{ flex: 1, padding: '10px' }}
                    >
                      ← 이전
                    </button>
                    <button
                      onClick={async () => {
                        if (!organizeMethod) {
                          setToast('정리 방식을 선택해주세요');
                          return;
                        }
                        setOrganizeLoading(true);
                        setOrganizeStep("🤖 AI가 분석 중...");
                        setOrganizePhase('preview');

                        try {
                          // AI 분석 (선택한 방식 전달 - 추후 백엔드에서 처리)
                          const files = organizeFiles;
                          const plans = await invoke<OrganizePlan[]>("analyze_files_for_organization", {
                            files,
                            // method: organizeMethod  // TODO: 백엔드에 전달
                          });
                          setOrganizePlans(plans);
                          setOrganizeLoading(false);
                        } catch (e) {
                          console.error(e);
                          setOrganizeLoading(false);
                          setOrganizeResult(`오류: ${e}`);
                          setOrganizePhase('select-method');
                        }
                      }}
                      disabled={!organizeMethod || organizeLoading}
                      className="btn"
                      style={{
                        flex: 2,
                        padding: '10px',
                        background: organizeMethod ? 'var(--accent)' : 'var(--bg-secondary)',
                        color: organizeMethod ? 'white' : 'var(--text-secondary)'
                      }}
                    >
                      {organizeLoading ? '🔄 분석 중...' : '다음 →'}
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 3: 미리보기 및 수정 */}
              {organizePhase === 'preview' && !organizeLoading && (
                <div className="card" style={{ padding: '16px' }}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 style={{ fontSize: '14px', fontWeight: 600 }}>🗂️ 정리 계획 미리보기</h3>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setOrganizePlans(prev => prev.map(p => ({ ...p, selected: true })))}
                        className="btn"
                        style={{ padding: '4px 8px', fontSize: '11px' }}
                      >
                        전체 선택
                      </button>
                      <button
                        onClick={() => setOrganizePlans(prev => prev.map(p => ({ ...p, selected: false })))}
                        className="btn"
                        style={{ padding: '4px 8px', fontSize: '11px' }}
                      >
                        전체 해제
                      </button>
                    </div>
                  </div>

                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                    원하지 않는 항목은 체크 해제하세요. 선택된 파일만 이동됩니다.
                  </p>

                  <div style={{ maxHeight: '350px', overflowY: 'auto', marginBottom: '16px' }}>
                    {organizePlans.map((plan, idx) => (
                      <div
                        key={idx}
                        onClick={() => {
                          setOrganizePlans(prev => prev.map((p, i) =>
                            i === idx ? { ...p, selected: !p.selected } : p
                          ));
                        }}
                        className="cursor-pointer"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '10px 12px',
                          borderBottom: '1px solid var(--border-light)',
                          background: plan.selected ? 'var(--bg-active)' : 'transparent',
                          transition: 'background 0.15s ease'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={plan.selected}
                          onChange={() => {}}
                          style={{ marginRight: '12px', width: '16px', height: '16px' }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: '13px',
                            fontWeight: 500,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}>
                            {plan.file_name}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            → <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{plan.suggested_folder}/</span>
                            <span style={{ marginLeft: '8px', opacity: 0.7 }}>{plan.reason}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: '12px' }}>
                    <button
                      onClick={() => {
                        setOrganizePhase('select-method');
                        setOrganizePlans([]);
                      }}
                      className="btn"
                      style={{ flex: 1, padding: '10px' }}
                    >
                      ← 다시 선택
                    </button>
                    <button
                      onClick={async () => {
                        const selectedCount = organizePlans.filter(p => p.selected).length;
                        if (selectedCount === 0) {
                          setToast('선택된 파일이 없습니다');
                          return;
                        }
                        setOrganizeExecuting(true);
                        try {
                          const result = await invoke<{
                            success: boolean;
                            moved_count: number;
                            failed_count: number;
                            message: string;
                            moved_files: Array<{
                              file_name: string;
                              from_path: string;
                              to_path: string;
                              to_folder: string;
                            }>;
                          }>(
                            "execute_organization",
                            { basePath: organizeBasePath, plans: organizePlans.filter(p => p.selected) }
                          );
                          setOrganizeResult(result.message);
                          setOrganizeMovedFiles(result.moved_files);
                          setOrganizePlans([]);
                          setOrganizePhase('done');
                          if (result.success) {
                            setToast(`✅ ${result.moved_count}개 파일 정리 완료!`);
                          }
                        } catch (e) {
                          setOrganizeResult(`오류: ${e}`);
                        }
                        setOrganizeExecuting(false);
                      }}
                      disabled={organizeExecuting || organizePlans.filter(p => p.selected).length === 0}
                      className="btn"
                      style={{
                        flex: 2,
                        padding: '10px',
                        background: 'var(--success)',
                        color: 'white'
                      }}
                    >
                      {organizeExecuting ? '🔄 정리 중...' : `✅ ${organizePlans.filter(p => p.selected).length}개 파일 정리하기`}
                    </button>
                  </div>
                </div>
              )}

              {/* 분석 중 로딩 */}
              {organizePhase === 'preview' && organizeLoading && (
                <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
                  <div style={{
                    width: '60px',
                    height: '60px',
                    margin: '0 auto 20px',
                    borderRadius: '50%',
                    border: '3px solid var(--border-light)',
                    borderTopColor: 'var(--accent)',
                    animation: 'spin 1s linear infinite'
                  }} />
                  <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                    {organizeStep || 'AI가 분석 중...'}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    파일을 분석하고 최적의 정리 방안을 찾고 있어요
                  </div>
                  <style>{`
                    @keyframes spin {
                      from { transform: rotate(0deg); }
                      to { transform: rotate(360deg); }
                    }
                  `}</style>
                </div>
              )}

              {/* STEP 4: 완료 - 결과 상세 보기 */}
              {organizePhase === 'done' && (
                <div className="card" style={{ padding: '20px' }}>
                  <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                    <div style={{ fontSize: '48px', marginBottom: '12px' }}>✅</div>
                    <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '4px' }}>정리 완료!</h3>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                      {organizeMovedFiles.length}개 파일이 정리되었어요
                    </p>
                  </div>

                  {/* 이동된 파일 목록 - 폴더별로 그룹화 */}
                  <div style={{ marginBottom: '20px' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '12px' }}>📋 정리 내역</h4>
                    <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                      {Object.entries(
                        organizeMovedFiles.reduce((acc, file) => {
                          if (!acc[file.to_folder]) acc[file.to_folder] = [];
                          acc[file.to_folder].push(file);
                          return acc;
                        }, {} as Record<string, typeof organizeMovedFiles>)
                      ).map(([folder, files]) => (
                        <div key={folder} style={{ marginBottom: '12px' }}>
                          <div style={{
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--accent)',
                            marginBottom: '6px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                          }}>
                            📁 {folder}/ <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>({files.length}개)</span>
                          </div>
                          {files.map((file, idx) => (
                            <div
                              key={idx}
                              style={{
                                fontSize: '11px',
                                padding: '4px 0 4px 20px',
                                color: 'var(--text-secondary)',
                                borderLeft: '2px solid var(--border-light)',
                                marginLeft: '6px'
                              }}
                            >
                              {file.file_name}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      setOrganizePhase('select-folder');
                      setOrganizeBasePath('');
                      setOrganizeFiles([]);
                      setOrganizeMovedFiles([]);
                      setOrganizeMethod('');
                      setOrganizeResult(null);
                    }}
                    className="btn"
                    style={{
                      width: '100%',
                      padding: '12px',
                      background: 'var(--accent)',
                      color: 'white'
                    }}
                  >
                    🔄 다른 폴더 정리하기
                  </button>
                </div>
              )}

              {/* 오류 메시지 */}
              {organizeResult && organizeResult.startsWith('오류') && (
                <div
                  className="card"
                  style={{
                    padding: '12px 16px',
                    background: 'var(--error-bg)',
                    color: 'var(--error)',
                    fontSize: '13px'
                  }}
                >
                  {organizeResult}
                </div>
              )}
            </div>
          )}

          {/* ===== RESEARCH (자동 리서치) ===== */}
          {tab === "research" && !selectedMemo && (
            <div className="space-y-4">
              {/* 검색 입력 */}
              <div className="card" style={{ padding: '16px' }}>
                <div className="card-header" style={{ marginBottom: '12px' }}>
                  <span style={{ fontSize: '16px', marginRight: '8px' }}>🔬</span>
                  자동 리서치
                </div>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  검색어를 입력하면 AI가 네이버/구글에서 정보를 수집하고 분석 리포트를 생성합니다.
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={researchQuery}
                    onChange={(e) => setResearchQuery(e.target.value)}
                    placeholder="리서치할 주제를 입력하세요..."
                    className="input"
                    style={{ flex: 1, fontSize: '13px' }}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter' && researchQuery.trim() && !researchLoading) {
                        handleResearch();
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={handleResearch}
                    disabled={!researchQuery.trim() || researchLoading}
                    style={{ minWidth: '100px' }}
                  >
                    {researchLoading ? '분석 중...' : '🔍 리서치 시작'}
                  </button>
                </div>
                {/* API 키 상태 표시 */}
                <div style={{ marginTop: '12px', display: 'flex', gap: '12px', fontSize: '11px' }}>
                  <span style={{ color: naverClientId ? 'var(--success)' : 'var(--text-secondary)' }}>
                    {naverClientId ? '✓' : '○'} 네이버 API
                  </span>
                  <span style={{ color: googleSearchApiKey ? 'var(--success)' : 'var(--text-secondary)' }}>
                    {googleSearchApiKey ? '✓' : '○'} Google API
                  </span>
                  {!naverClientId && !googleSearchApiKey && (
                    <span
                      style={{ color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => setTab('settings')}
                    >
                      → 설정에서 API 키 추가
                    </span>
                  )}
                </div>
              </div>

              {/* 로딩 상태 - 실시간 진행 상황 */}
              {researchLoading && (
                <div className="card" style={{ padding: '24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                    <div style={{ fontSize: '32px', animation: 'pulse 2s infinite' }}>🔬</div>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 600 }}>
                        AI 에이전트 리서치 중...
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        {researchProgress ? `${researchProgress.step}/${researchProgress.total_steps} 단계` : '준비 중...'}
                      </div>
                    </div>
                  </div>

                  {/* 진행률 바 */}
                  <div style={{ marginBottom: '16px', height: '6px', background: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{
                      width: researchProgress ? `${(researchProgress.step / researchProgress.total_steps) * 100}%` : '5%',
                      height: '100%',
                      background: '#3b82f6',
                      transition: 'width 0.3s ease',
                      borderRadius: '3px'
                    }} />
                  </div>

                  {/* 내부 투두리스트 */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {researchProgress?.tasks.map((task) => (
                      <div
                        key={task.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '10px 12px',
                          background: task.status === 'in_progress' ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-tertiary)',
                          borderRadius: '6px',
                          border: task.status === 'in_progress' ? '1px solid #3b82f6' : '1px solid transparent',
                          transition: 'all 0.2s ease'
                        }}
                      >
                        {/* 상태 아이콘 */}
                        <div style={{ fontSize: '16px', width: '24px', textAlign: 'center' }}>
                          {task.status === 'completed' && '✅'}
                          {task.status === 'in_progress' && (
                            <div style={{ animation: 'spin 1s linear infinite' }}>⏳</div>
                          )}
                          {task.status === 'pending' && '⬜'}
                          {task.status === 'failed' && '❌'}
                        </div>

                        {/* 태스크 정보 */}
                        <div style={{ flex: 1 }}>
                          <div style={{
                            fontSize: '13px',
                            fontWeight: task.status === 'in_progress' ? 600 : 400,
                            color: task.status === 'completed' ? 'var(--text-secondary)' :
                                   task.status === 'in_progress' ? 'var(--text-primary)' :
                                   'var(--text-tertiary)'
                          }}>
                            {task.description}
                          </div>
                        </div>

                        {/* 태스크 타입 배지 */}
                        <div style={{
                          padding: '2px 8px',
                          background: task.status === 'in_progress' ? '#3b82f6' : 'var(--bg-secondary)',
                          color: task.status === 'in_progress' ? 'white' : 'var(--text-secondary)',
                          borderRadius: '4px',
                          fontSize: '10px',
                          fontWeight: 500
                        }}>
                          {task.task_type === 'plan' && '계획'}
                          {task.task_type === 'search' && '검색'}
                          {task.task_type === 'select' && '선택'}
                          {task.task_type === 'crawl' && '크롤링'}
                          {task.task_type === 'analyze' && '분석'}
                          {task.task_type === 'summarize' && '요약'}
                          {task.task_type === 'compile' && '작성'}
                        </div>
                      </div>
                    ))}

                    {/* 아직 진행 상황이 없을 때 */}
                    {!researchProgress && (
                      <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                        AI 에이전트 초기화 중...
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 리서치 결과 - 프로페셔널 디자인 */}
              {researchResult && !researchLoading && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

                  {/* 헤더 - 그라데이션 배경 */}
                  <div style={{
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    borderRadius: '12px',
                    padding: '20px 24px',
                    color: 'white',
                    position: 'relative',
                    overflow: 'hidden'
                  }}>
                    <div style={{ position: 'absolute', top: 0, right: 0, width: '200px', height: '200px', background: 'rgba(255,255,255,0.1)', borderRadius: '50%', transform: 'translate(50%, -50%)' }} />
                    <div style={{ position: 'relative', zIndex: 1 }}>
                      <div style={{ fontSize: '11px', opacity: 0.9, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        AI Research Report
                      </div>
                      <h2 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 12px 0', lineHeight: 1.3 }}>
                        {researchResult.query}
                      </h2>
                      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ fontSize: '12px', background: 'rgba(255,255,255,0.2)', padding: '4px 10px', borderRadius: '20px' }}>
                          🔍 {researchResult.search_engines_used.join(' + ')}
                        </span>
                        <span style={{ fontSize: '12px', background: 'rgba(255,255,255,0.2)', padding: '4px 10px', borderRadius: '20px' }}>
                          📄 {researchResult.sources.length}개 출처
                        </span>
                        {researchResult.memo_id && (
                          <span style={{ fontSize: '12px', background: 'rgba(34, 197, 94, 0.3)', padding: '4px 10px', borderRadius: '20px' }}>
                            ✓ 저장됨
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 액션 바 - 복사 버튼들 */}
                  <div style={{
                    display: 'flex',
                    gap: '8px',
                    padding: '12px 16px',
                    background: 'var(--bg-secondary)',
                    borderRadius: '8px',
                    border: '1px solid var(--border)'
                  }}>
                    <button
                      onClick={() => {
                        const fullText = `# ${researchResult.query}\n\n## 요약\n${researchResult.summary}\n\n## 핵심 포인트\n${researchResult.key_points.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n## 상세 리포트\n${researchResult.full_report}\n\n## 출처\n${researchResult.sources.map(s => `- ${s.title} (${s.source})\n  ${s.link}`).join('\n')}\n\n## 출처별 상세 요약\n${researchResult.source_summaries?.map((ss, i) => `[${i + 1}] ${ss.title}\n출처: ${ss.source}\n${ss.summary}\n${ss.url}`).join('\n\n') || '없음'}`;
                        navigator.clipboard.writeText(fullText);
                        showToast('전체 리포트가 복사되었습니다');
                      }}
                      style={{
                        flex: 1,
                        padding: '10px 16px',
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '13px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px'
                      }}
                    >
                      📋 전체 복사
                    </button>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(researchResult.summary);
                        showToast('요약이 복사되었습니다');
                      }}
                      style={{
                        padding: '10px 16px',
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        cursor: 'pointer'
                      }}
                    >
                      요약 복사
                    </button>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(researchResult.full_report);
                        showToast('리포트가 복사되었습니다');
                      }}
                      style={{
                        padding: '10px 16px',
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        cursor: 'pointer'
                      }}
                    >
                      리포트 복사
                    </button>
                  </div>

                  {/* 요약 카드 - 하이라이트 */}
                  <div style={{
                    background: 'linear-gradient(135deg, rgba(102, 126, 234, 0.1) 0%, rgba(118, 75, 162, 0.1) 100%)',
                    borderRadius: '12px',
                    padding: '20px',
                    border: '1px solid rgba(102, 126, 234, 0.2)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                      <span style={{ fontSize: '20px' }}>💡</span>
                      <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>핵심 요약</span>
                    </div>
                    <p style={{
                      fontSize: '14px',
                      lineHeight: '1.8',
                      color: 'var(--text-primary)',
                      margin: 0,
                      fontWeight: 500
                    }}>
                      {researchResult.summary}
                    </p>
                  </div>

                  {/* 핵심 포인트 - 번호 카드 */}
                  <div style={{
                    background: 'var(--bg-secondary)',
                    borderRadius: '12px',
                    padding: '20px',
                    border: '1px solid var(--border)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                      <span style={{ fontSize: '20px' }}>🎯</span>
                      <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>핵심 포인트</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                        {researchResult.key_points.length}개 발견
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {researchResult.key_points.map((point, i) => (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            gap: '12px',
                            padding: '12px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: '8px',
                            alignItems: 'flex-start'
                          }}
                        >
                          <div style={{
                            minWidth: '28px',
                            height: '28px',
                            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'white',
                            fontSize: '12px',
                            fontWeight: 700
                          }}>
                            {i + 1}
                          </div>
                          <p style={{
                            fontSize: '13px',
                            lineHeight: '1.6',
                            color: 'var(--text-primary)',
                            margin: 0,
                            flex: 1
                          }}>
                            {point}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 상세 리포트 */}
                  <div style={{
                    background: 'var(--bg-secondary)',
                    borderRadius: '12px',
                    padding: '24px',
                    border: '1px solid var(--border)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                      <span style={{ fontSize: '20px' }}>📝</span>
                      <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>상세 분석 리포트</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                        {researchResult.full_report.length.toLocaleString()}자
                      </span>
                    </div>
                    <div style={{
                      fontSize: '14px',
                      lineHeight: '2',
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-wrap',
                      background: 'var(--bg-tertiary)',
                      padding: '20px',
                      borderRadius: '8px',
                      maxHeight: '500px',
                      overflow: 'auto'
                    }}>
                      {researchResult.full_report}
                    </div>
                  </div>

                  {/* 출처 목록 - 그리드 */}
                  <div style={{
                    background: 'var(--bg-secondary)',
                    borderRadius: '12px',
                    padding: '20px',
                    border: '1px solid var(--border)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                      <span style={{ fontSize: '20px' }}>🔗</span>
                      <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>참고 출처</span>
                      <span style={{
                        fontSize: '11px',
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        color: 'white',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        marginLeft: '8px'
                      }}>
                        {researchResult.sources.length}개
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
                      {researchResult.sources.slice(0, 12).map((source, i) => (
                        <a
                          key={i}
                          href={source.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            padding: '12px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: '8px',
                            textDecoration: 'none',
                            border: '1px solid transparent',
                            transition: 'all 0.2s',
                            display: 'block'
                          }}
                          onMouseOver={(e) => { e.currentTarget.style.borderColor = '#667eea'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                          onMouseOut={(e) => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.transform = 'translateY(0)'; }}
                        >
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px', lineHeight: 1.4 }}>
                            {source.title.length > 60 ? source.title.slice(0, 60) + '...' : source.title}
                          </div>
                          <div style={{
                            fontSize: '10px',
                            color: '#667eea',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                          }}>
                            <span style={{
                              background: 'rgba(102, 126, 234, 0.1)',
                              padding: '2px 6px',
                              borderRadius: '4px'
                            }}>
                              {source.source}
                            </span>
                          </div>
                        </a>
                      ))}
                    </div>
                    {researchResult.sources.length > 12 && (
                      <div style={{ textAlign: 'center', marginTop: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        +{researchResult.sources.length - 12}개 더 있음 (메모에서 전체 확인)
                      </div>
                    )}
                  </div>

                  {/* 별첨: 출처별 상세 요약 */}
                  {researchResult.source_summaries && researchResult.source_summaries.length > 0 && (
                    <div style={{
                      background: 'var(--bg-secondary)',
                      borderRadius: '12px',
                      padding: '20px',
                      border: '1px solid var(--border)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                        <span style={{ fontSize: '20px' }}>📚</span>
                        <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>출처별 상세 분석</span>
                        <span style={{
                          fontSize: '11px',
                          background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                          color: 'white',
                          padding: '2px 8px',
                          borderRadius: '10px',
                          marginLeft: '8px'
                        }}>
                          별첨 {researchResult.source_summaries.length}개
                        </span>
                      </div>
                      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                        AI가 각 출처의 내용을 개별적으로 분석하고 요약한 심층 자료입니다.
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {researchResult.source_summaries.map((ss, i) => (
                          <div
                            key={i}
                            style={{
                              padding: '16px',
                              background: 'var(--bg-tertiary)',
                              borderRadius: '10px',
                              borderLeft: '4px solid',
                              borderImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%) 1'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '10px' }}>
                              <div style={{
                                minWidth: '32px',
                                height: '32px',
                                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                                borderRadius: '8px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'white',
                                fontSize: '13px',
                                fontWeight: 700
                              }}>
                                {i + 1}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)', marginBottom: '4px', lineHeight: 1.4 }}>
                                  {ss.title.length > 70 ? ss.title.slice(0, 70) + '...' : ss.title}
                                </div>
                                <div style={{
                                  fontSize: '10px',
                                  color: '#667eea',
                                  display: 'inline-block',
                                  background: 'rgba(102, 126, 234, 0.1)',
                                  padding: '2px 8px',
                                  borderRadius: '4px'
                                }}>
                                  {ss.source}
                                </div>
                              </div>
                            </div>
                            <p style={{
                              fontSize: '13px',
                              lineHeight: '1.8',
                              color: 'var(--text-secondary)',
                              margin: '0 0 10px 0',
                              paddingLeft: '44px'
                            }}>
                              {ss.summary}
                            </p>
                            <div style={{ paddingLeft: '44px' }}>
                              <a
                                href={ss.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  fontSize: '11px',
                                  color: '#667eea',
                                  textDecoration: 'none',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px'
                                }}
                              >
                                원문 보기 →
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 푸터 - 통계 정보 */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'center',
                    gap: '24px',
                    padding: '16px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: 'var(--text-secondary)'
                  }}>
                    <span>🤖 Gemini 3.0 Pro</span>
                    <span>📊 토큰: {(researchResult.input_tokens + researchResult.output_tokens).toLocaleString()}</span>
                    <span>💰 비용: ${researchResult.cost_usd.toFixed(4)}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===== COLLECT (데이터 수집) ===== */}
          {/* {tab === "collect" && !selectedMemo && (
            <DataCollection showToast={showToast} />
          )} */}

          {/* ===== CONSULTING (파일 컨설팅) ===== */}
          {tab === "consulting" && !selectedMemo && (
            <FileConsulting />
          )}

          {/* ===== EXTRACT (AI 데이터 추출) ===== */}
          {tab === "extract" && !selectedMemo && (
            <div className="space-y-3">
              <div className="card" style={{ padding: '16px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>
                  🧲 AI 데이터 추출
                </h3>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                  웹페이지에서 원하는 데이터만 AI가 구조화하여 추출합니다.
                </p>

                {/* URL 입력 */}
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                    URL
                  </label>
                  <input
                    type="text"
                    value={extractUrl}
                    onChange={(e) => setExtractUrl(e.target.value)}
                    placeholder="https://example.com/page"
                    className="input"
                    style={{ fontSize: '12px', padding: '10px' }}
                  />
                </div>

                {/* 스키마 입력 */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                    추출할 데이터 (자연어로 설명)
                  </label>
                  <textarea
                    value={extractSchema}
                    onChange={(e) => setExtractSchema(e.target.value)}
                    placeholder={`예시:
- 상품명, 가격, 평점, 리뷰 수
- 기사 제목, 작성자, 날짜, 본문 요약
- 테이블의 모든 데이터를 JSON 배열로`}
                    className="input"
                    style={{ fontSize: '12px', padding: '10px', minHeight: '100px', resize: 'vertical' }}
                  />
                </div>

                {/* 추출 버튼 */}
                <button
                  onClick={async () => {
                    if (!extractUrl || !extractSchema) {
                      showToast("URL과 추출할 데이터를 입력하세요");
                      return;
                    }
                    setExtractLoading(true);
                    setExtractResult(null);
                    try {
                      const result = await invoke<{url: string; data: unknown; input_tokens: number; output_tokens: number; cost_usd: number}>("extract_from_url", {
                        url: extractUrl,
                        schema: extractSchema
                      });
                      setExtractResult(result);
                      showToast("✅ 데이터 추출 완료");
                    } catch (e) {
                      showToast(`❌ ${e}`);
                    } finally {
                      setExtractLoading(false);
                    }
                  }}
                  disabled={extractLoading || !extractUrl || !extractSchema}
                  className="btn btn-primary"
                  style={{ width: '100%', padding: '12px', fontSize: '13px' }}
                >
                  {extractLoading ? '추출 중...' : '🧲 데이터 추출'}
                </button>
              </div>

              {/* 추출 결과 */}
              {extractResult && (
                <div className="card" style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600 }}>추출 결과</h4>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(extractResult.data, null, 2));
                        showToast("JSON 복사됨");
                      }}
                      className="btn btn-secondary"
                      style={{ fontSize: '10px', padding: '4px 8px' }}
                    >
                      📋 복사
                    </button>
                  </div>
                  <pre style={{
                    background: 'var(--bg-tertiary)',
                    padding: '12px',
                    borderRadius: '8px',
                    fontSize: '11px',
                    overflow: 'auto',
                    maxHeight: '400px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}>
                    {JSON.stringify(extractResult.data, null, 2)}
                  </pre>
                  <div style={{ marginTop: '12px', fontSize: '10px', color: 'var(--text-muted)', display: 'flex', gap: '12px' }}>
                    <span>📥 입력: {extractResult.input_tokens.toLocaleString()} 토큰</span>
                    <span>📤 출력: {extractResult.output_tokens.toLocaleString()} 토큰</span>
                    <span>💰 비용: ${extractResult.cost_usd.toFixed(4)}</span>
                  </div>
                </div>
              )}

              {/* 사용 예시 */}
              <div className="card" style={{ padding: '12px', background: 'var(--bg-tertiary)' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>💡 사용 예시</div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', lineHeight: '1.8' }}>
                  <div><strong>쇼핑몰:</strong> "상품명, 가격, 할인율, 리뷰 수 추출"</div>
                  <div><strong>뉴스:</strong> "제목, 작성일, 요약 추출"</div>
                  <div><strong>부동산:</strong> "매물 목록에서 주소, 가격, 면적, 층수 추출"</div>
                  <div><strong>채용:</strong> "회사명, 포지션, 연봉, 자격요건 추출"</div>
                </div>
              </div>
            </div>
          )}

          {/* ===== AGENT (AI 브라우저 에이전트) ===== */}
          {tab === "agent" && !selectedMemo && (
            <div className="space-y-3">
              <div className="card" style={{ padding: '16px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>
                  🤖 AI 브라우저 에이전트
                </h3>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                  목표를 입력하면 AI가 자동으로 브라우저를 조작하여 작업을 수행합니다.
                </p>

                {/* 목표 입력 */}
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                    목표
                  </label>
                  <textarea
                    value={agentGoal}
                    onChange={(e) => setAgentGoal(e.target.value)}
                    placeholder={`예시:
- 네이버에서 "아이폰 16" 검색하고 최저가 찾기
- 구글에서 "Claude AI" 검색하고 최신 뉴스 5개 요약
- 네이버 쇼핑에서 "에어팟" 검색 후 평점 높은 상품 3개 추출`}
                    className="input"
                    style={{ fontSize: '12px', padding: '10px', minHeight: '100px', resize: 'vertical' }}
                  />
                </div>

                {/* 시작 URL */}
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                    시작 URL
                  </label>
                  <input
                    type="text"
                    value={agentStartUrl}
                    onChange={(e) => setAgentStartUrl(e.target.value)}
                    placeholder="https://www.naver.com"
                    className="input"
                    style={{ fontSize: '12px', padding: '10px' }}
                  />
                </div>

                {/* 최대 단계 */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                    최대 단계 수: {agentMaxSteps}
                  </label>
                  <input
                    type="range"
                    min="3"
                    max="15"
                    value={agentMaxSteps}
                    onChange={(e) => setAgentMaxSteps(parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>빠름 (3)</span>
                    <span>기본 (10)</span>
                    <span>상세 (15)</span>
                  </div>
                </div>

                {/* 실행 버튼 */}
                <button
                  onClick={async () => {
                    if (!agentGoal) {
                      showToast("목표를 입력하세요");
                      return;
                    }
                    setAgentLoading(true);
                    setAgentResult(null);
                    setAgentLiveSteps([]);
                    try {
                      const result = await invoke("run_browser_agent", {
                        goal: agentGoal,
                        startUrl: agentStartUrl,
                        maxSteps: agentMaxSteps
                      }) as AgentResult;
                      setAgentResult(result);
                      setAgentLiveSteps([]);
                      showToast(result.success ? "✅ 에이전트 작업 완료" : "⚠️ 에이전트가 최대 단계에 도달");
                    } catch (e) {
                      showToast(`❌ ${e}`);
                    } finally {
                      setAgentLoading(false);
                    }
                  }}
                  disabled={agentLoading || !agentGoal}
                  className="btn btn-primary"
                  style={{ width: '100%', padding: '12px', fontSize: '13px' }}
                >
                  {agentLoading ? '🤖 에이전트 실행 중...' : '🚀 에이전트 시작'}
                </button>
              </div>

              {/* 실시간 진행상황 */}
              {agentLoading && agentLiveSteps.length > 0 && (
                <div className="card" style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600 }}>
                      🔄 실행 중...
                    </h4>
                    <span style={{
                      fontSize: '10px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      background: 'rgba(102, 126, 234, 0.2)',
                      color: '#667eea'
                    }}>
                      {agentLiveSteps.length}단계 진행
                    </span>
                  </div>
                  <div
                    ref={agentStepsRef}
                    style={{
                      background: 'var(--bg-tertiary)',
                      borderRadius: '8px',
                      padding: '12px',
                      maxHeight: '400px',
                      overflow: 'auto'
                    }}
                  >
                    {agentLiveSteps.map((step: AgentStep, idx: number) => (
                      <div
                        key={idx}
                        style={{
                          padding: '10px',
                          borderLeft: '3px solid',
                          borderLeftColor: step.result.includes('실패') ? '#ef4444' :
                                          step.action_type === 'Done' ? '#10b981' : '#667eea',
                          marginBottom: '10px',
                          background: idx === agentLiveSteps.length - 1 ? 'rgba(102, 126, 234, 0.1)' : 'var(--bg-secondary)',
                          borderRadius: '0 8px 8px 0',
                          animation: idx === agentLiveSteps.length - 1 ? 'fadeIn 0.3s ease-in' : 'none'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                          <span style={{
                            fontSize: '10px',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '4px',
                            background: idx === agentLiveSteps.length - 1 ? '#667eea' : 'rgba(102, 126, 234, 0.2)',
                            color: idx === agentLiveSteps.length - 1 ? 'white' : '#667eea'
                          }}>
                            Step {step.step_number}
                          </span>
                          <span style={{ fontSize: '12px', fontWeight: 600 }}>
                            {step.action_type === 'Navigate' && '🌐 이동'}
                            {step.action_type === 'Click' && '👆 클릭'}
                            {step.action_type === 'Type' && '⌨️ 입력'}
                            {step.action_type === 'Scroll' && '📜 스크롤'}
                            {step.action_type === 'Wait' && '⏳ 대기'}
                            {step.action_type === 'Extract' && '📦 추출'}
                            {step.action_type === 'Done' && '✅ 완료'}
                          </span>
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                          💭 {step.reason}
                        </div>
                        {step.selector && (
                          <div style={{ fontSize: '10px', color: '#667eea', fontFamily: 'monospace', marginBottom: '4px' }}>
                            🎯 대상: {step.selector}
                          </div>
                        )}
                        {step.value && (
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', marginBottom: '4px' }}>
                            📝 값: {step.value.substring(0, 100)}{step.value.length > 100 ? '...' : ''}
                          </div>
                        )}
                        <div style={{
                          fontSize: '10px',
                          fontFamily: 'monospace',
                          padding: '6px 8px',
                          background: step.result.includes('실패') ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                          borderRadius: '4px',
                          color: step.result.includes('실패') ? '#ef4444' : '#10b981'
                        }}>
                          ➜ {step.result}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 실행 결과 */}
              {agentResult && (
                <div className="card" style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600 }}>
                      {agentResult.success ? '✅ 작업 완료' : '⚠️ 최대 단계 도달'}
                    </h4>
                    <span style={{
                      fontSize: '10px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      background: agentResult.success ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                      color: agentResult.success ? '#10b981' : '#f59e0b'
                    }}>
                      {agentResult.steps.length}단계 완료
                    </span>
                  </div>

                  {/* 단계별 로그 */}
                  <div style={{ marginBottom: '16px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>실행 로그</div>
                    <div style={{
                      background: 'var(--bg-tertiary)',
                      borderRadius: '8px',
                      padding: '12px',
                      maxHeight: '300px',
                      overflow: 'auto'
                    }}>
                      {agentResult.steps.map((step: AgentStep, idx: number) => (
                        <div
                          key={idx}
                          style={{
                            padding: '8px',
                            borderLeft: '2px solid',
                            borderLeftColor: step.action_type === 'Done' ? '#10b981' : '#667eea',
                            marginBottom: '8px',
                            background: 'var(--bg-secondary)',
                            borderRadius: '0 6px 6px 0'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                            <span style={{
                              fontSize: '10px',
                              fontWeight: 600,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'rgba(102, 126, 234, 0.2)',
                              color: '#667eea'
                            }}>
                              Step {step.step_number}
                            </span>
                            <span style={{ fontSize: '11px', fontWeight: 600 }}>
                              {step.action_type === 'Navigate' && '🌐 이동'}
                              {step.action_type === 'Click' && '👆 클릭'}
                              {step.action_type === 'Type' && '⌨️ 입력'}
                              {step.action_type === 'Scroll' && '📜 스크롤'}
                              {step.action_type === 'Wait' && '⏳ 대기'}
                              {step.action_type === 'Extract' && '📦 추출'}
                              {step.action_type === 'Done' && '✅ 완료'}
                            </span>
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '2px' }}>
                            {step.reason}
                          </div>
                          {step.value && (
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                              → {step.value.substring(0, 100)}{step.value.length > 100 ? '...' : ''}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 최종 결과 데이터 */}
                  {agentResult.final_data && (
                    <div style={{ marginBottom: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 600 }}>결과 데이터</span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(JSON.stringify(agentResult.final_data, null, 2));
                            showToast("JSON 복사됨");
                          }}
                          className="btn btn-secondary"
                          style={{ fontSize: '10px', padding: '4px 8px' }}
                        >
                          📋 복사
                        </button>
                      </div>
                      <pre style={{
                        background: 'var(--bg-tertiary)',
                        padding: '12px',
                        borderRadius: '8px',
                        fontSize: '11px',
                        overflow: 'auto',
                        maxHeight: '200px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word'
                      }}>
                        {JSON.stringify(agentResult.final_data, null, 2)}
                      </pre>
                    </div>
                  )}

                  {/* 비용 정보 */}
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', gap: '12px' }}>
                    <span>📥 입력: {agentResult.total_input_tokens.toLocaleString()} 토큰</span>
                    <span>📤 출력: {agentResult.total_output_tokens.toLocaleString()} 토큰</span>
                    <span>💰 비용: ${agentResult.total_cost_usd.toFixed(4)}</span>
                  </div>
                </div>
              )}

              {/* 사용 안내 */}
              <div className="card" style={{ padding: '12px', background: 'var(--bg-tertiary)' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>💡 사용 팁</div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', lineHeight: '1.8' }}>
                  <div><strong>검색:</strong> "네이버에서 [키워드] 검색하고 결과 정리"</div>
                  <div><strong>가격비교:</strong> "네이버 쇼핑에서 [상품] 최저가 찾기"</div>
                  <div><strong>정보수집:</strong> "위키백과에서 [주제] 찾아서 요약"</div>
                  <div style={{ marginTop: '8px', color: 'var(--text-muted)' }}>
                    ⚠️ 로그인이 필요한 작업은 지원하지 않습니다
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ===== DATA (데이터셋/엑셀) ===== */}
          {tab === "data" && !selectedMemo && (
            <div className="space-y-3">
              {/* 드래그 앤 드롭 영역 */}
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDraggingExcel(true); }}
                onDragLeave={() => setIsDraggingExcel(false)}
                onDrop={handleExcelDrop}
                style={{
                  padding: '24px',
                  border: `2px dashed ${isDraggingExcel ? '#667eea' : 'var(--border)'}`,
                  borderRadius: '12px',
                  textAlign: 'center',
                  background: isDraggingExcel ? 'rgba(102, 126, 234, 0.1)' : 'var(--bg-secondary)',
                  transition: 'all 0.2s'
                }}
              >
                {datasetLoading ? (
                  <div style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ fontSize: '24px', marginBottom: '8px', display: 'block' }}>⏳</span>
                    <span style={{ fontSize: '13px' }}>엑셀 파일 처리 중...</span>
                  </div>
                ) : (
                  <>
                    <span style={{ fontSize: '32px', marginBottom: '8px', display: 'block' }}>📊</span>
                    <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
                      엑셀 파일을 드래그 앤 드롭하세요
                    </p>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      .xlsx, .xls, .csv 파일 지원
                    </p>
                  </>
                )}
              </div>

              {/* 데이터셋 목록 */}
              {datasets.length > 0 && (
                <div className="card" style={{ padding: '12px' }}>
                  <div className="card-header" style={{ fontSize: '11px', marginBottom: '8px', paddingBottom: '8px' }}>
                    저장된 데이터셋 ({datasets.length}개)
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {datasets.map((ds) => (
                      <div
                        key={ds.id}
                        onClick={() => selectDataset(ds)}
                        style={{
                          padding: '10px 12px',
                          background: selectedDataset?.id === ds.id ? 'rgba(102, 126, 234, 0.1)' : 'var(--bg-tertiary)',
                          border: selectedDataset?.id === ds.id ? '1px solid #667eea' : '1px solid transparent',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>{ds.name}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                            {ds.row_count}행 × {ds.columns.length}열
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteDataset(ds.id); }}
                          style={{ padding: '4px 8px', fontSize: '11px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer' }}
                        >
                          🗑️
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 선택된 데이터셋 상세 */}
              {selectedDataset && (
                <>
                  {/* 데이터셋 헤더 */}
                  <div style={{
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    borderRadius: '12px',
                    padding: '16px 20px',
                    color: 'white'
                  }}>
                    <div style={{ fontSize: '11px', opacity: 0.9, marginBottom: '4px' }}>데이터셋</div>
                    <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>{selectedDataset.name}</h3>
                    <div style={{ fontSize: '12px', marginTop: '8px', display: 'flex', gap: '12px' }}>
                      <span style={{ background: 'rgba(255,255,255,0.2)', padding: '2px 8px', borderRadius: '4px' }}>
                        📊 {selectedDataset.row_count.toLocaleString()}행
                      </span>
                      <span style={{ background: 'rgba(255,255,255,0.2)', padding: '2px 8px', borderRadius: '4px' }}>
                        📋 {selectedDataset.columns.length}열
                      </span>
                    </div>
                  </div>

                  {/* 검색 및 필터 */}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      value={datasetSearchQuery}
                      onChange={(e) => setDatasetSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && searchDataset()}
                      placeholder="데이터 검색..."
                      className="input"
                      style={{ flex: 1, fontSize: '12px', padding: '8px 12px' }}
                    />
                    <button
                      onClick={searchDataset}
                      className="btn"
                      style={{ padding: '8px 16px', fontSize: '12px', background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                    >
                      🔍 검색
                    </button>
                  </div>

                  {/* 데이터 테이블 */}
                  <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                        <thead>
                          <tr style={{ background: 'var(--bg-tertiary)' }}>
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>#</th>
                            {selectedDataset.columns.map((col, i) => (
                              <th key={i} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {datasetRows.slice(0, 50).map((row, rowIdx) => (
                            <tr key={row.id} style={{ background: rowIdx % 2 === 0 ? 'var(--bg-secondary)' : 'var(--bg-tertiary)' }}>
                              <td style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>{row.row_index + 1}</td>
                              {row.data.map((cell, cellIdx) => (
                                <td key={cellIdx} style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-light)', whiteSpace: 'nowrap', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {datasetRows.length > 50 && (
                      <div style={{ padding: '8px', textAlign: 'center', fontSize: '11px', color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>
                        +{datasetRows.length - 50}개 더 있음
                      </div>
                    )}
                  </div>

                  {/* AI 분석 섹션 */}
                  <div className="card" style={{ padding: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <span style={{ fontWeight: 600, fontSize: '14px' }}>🤖 AI 데이터 분석</span>
                      <button
                        onClick={analyzeDataset}
                        disabled={datasetLoading}
                        style={{
                          padding: '8px 16px',
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: datasetLoading ? 'not-allowed' : 'pointer',
                          opacity: datasetLoading ? 0.7 : 1
                        }}
                      >
                        {datasetLoading ? '분석 중...' : '분석 실행'}
                      </button>
                    </div>

                    {datasetAnalysis && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {/* 요약 */}
                        <div style={{ padding: '12px', background: 'rgba(102, 126, 234, 0.1)', borderRadius: '8px' }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: '#667eea' }}>💡 요약</div>
                          <p style={{ fontSize: '13px', lineHeight: 1.6, margin: 0 }}>{datasetAnalysis.summary}</p>
                        </div>

                        {/* 통계 */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
                          {datasetAnalysis.statistics.map((stat, i) => (
                            <div key={i} style={{ padding: '10px', background: 'var(--bg-tertiary)', borderRadius: '6px', textAlign: 'center' }}>
                              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{stat.label}</div>
                              <div style={{ fontSize: '14px', fontWeight: 600 }}>{stat.value}</div>
                            </div>
                          ))}
                        </div>

                        {/* 인사이트 */}
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>🎯 인사이트</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {datasetAnalysis.insights.map((insight, i) => (
                              <div key={i} style={{ padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: '6px', fontSize: '12px', display: 'flex', gap: '8px' }}>
                                <span style={{ color: '#667eea', fontWeight: 600 }}>{i + 1}.</span>
                                <span>{insight}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* 차트 */}
                        {datasetAnalysis.chart_data && (
                          <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '12px' }}>📈 {datasetAnalysis.chart_data.title}</div>
                            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '120px' }}>
                              {datasetAnalysis.chart_data.values.map((value, i) => {
                                const maxVal = Math.max(...datasetAnalysis.chart_data!.values);
                                const height = maxVal > 0 ? (value / maxVal) * 100 : 0;
                                return (
                                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                    <div
                                      style={{
                                        width: '100%',
                                        height: `${height}px`,
                                        background: 'linear-gradient(180deg, #667eea 0%, #764ba2 100%)',
                                        borderRadius: '4px 4px 0 0',
                                        minHeight: '4px'
                                      }}
                                    />
                                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '60px' }}>
                                      {datasetAnalysis.chart_data!.labels[i]}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* 비용 정보 */}
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textAlign: 'right' }}>
                          토큰: {(datasetAnalysis.input_tokens + datasetAnalysis.output_tokens).toLocaleString()} | 비용: ${datasetAnalysis.cost_usd.toFixed(4)}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* AI Q&A 섹션 (RAG) */}
                  <div className="card" style={{ padding: '16px' }}>
                    <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '12px' }}>💬 데이터에 질문하기 (RAG)</div>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                      <input
                        type="text"
                        value={datasetQuestion}
                        onChange={(e) => setDatasetQuestion(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && askDatasetQuestion()}
                        placeholder="예: 매출이 가장 높은 제품은? 평균 가격은?"
                        className="input"
                        style={{ flex: 1, fontSize: '12px', padding: '10px 12px' }}
                      />
                      <button
                        onClick={askDatasetQuestion}
                        disabled={datasetQALoading || !datasetQuestion.trim()}
                        style={{
                          padding: '10px 20px',
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: datasetQALoading ? 'not-allowed' : 'pointer',
                          opacity: datasetQALoading ? 0.7 : 1
                        }}
                      >
                        {datasetQALoading ? '답변 중...' : '질문'}
                      </button>
                    </div>

                    {datasetQAResult && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {/* AI 답변 */}
                        <div style={{ padding: '16px', background: 'rgba(102, 126, 234, 0.1)', borderRadius: '8px', borderLeft: '4px solid #667eea' }}>
                          <div style={{ fontSize: '11px', color: '#667eea', marginBottom: '8px', fontWeight: 600 }}>🤖 AI 답변</div>
                          <p style={{ fontSize: '14px', lineHeight: 1.8, margin: 0, whiteSpace: 'pre-wrap' }}>{datasetQAResult.answer}</p>
                        </div>

                        {/* 관련 데이터 */}
                        {datasetQAResult.relevant_rows.length > 0 && (
                          <div>
                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>📋 관련 데이터 ({datasetQAResult.relevant_rows.length}건)</div>
                            <div style={{ overflowX: 'auto' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                                <thead>
                                  <tr style={{ background: 'var(--bg-tertiary)' }}>
                                    {selectedDataset.columns.map((col, i) => (
                                      <th key={i} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{col}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {datasetQAResult.relevant_rows.slice(0, 10).map((row, rowIdx) => (
                                    <tr key={rowIdx} style={{ background: rowIdx % 2 === 0 ? 'var(--bg-secondary)' : 'var(--bg-tertiary)' }}>
                                      {row.map((cell, cellIdx) => (
                                        <td key={cellIdx} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-light)' }}>{cell}</td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* 비용 정보 */}
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textAlign: 'right' }}>
                          토큰: {(datasetQAResult.input_tokens + datasetQAResult.output_tokens).toLocaleString()} | 비용: ${datasetQAResult.cost_usd.toFixed(4)}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* 빈 상태 */}
              {datasets.length === 0 && !datasetLoading && (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                  <span style={{ fontSize: '48px', marginBottom: '16px', display: 'block' }}>📊</span>
                  <p style={{ fontSize: '14px', marginBottom: '8px' }}>아직 데이터가 없습니다</p>
                  <p style={{ fontSize: '12px' }}>엑셀 파일을 드래그 앤 드롭하여 시작하세요</p>
                </div>
              )}
            </div>
          )}

          {/* ===== SETTINGS ===== */}
          {tab === "settings" && !selectedMemo && (
            <div className="space-y-3">
              {/* API 키 없음 안내 */}
              {(!apiKey || apiKey.trim() === "") && (
                <div style={{
                  padding: '12px 16px',
                  background: 'var(--accent)',
                  color: 'white',
                  borderRadius: '3px',
                  fontSize: '13px'
                }}>
                  <strong>시작하려면 API 키가 필요해요</strong>
                  <p style={{ marginTop: '4px', opacity: 0.9, fontSize: '12px' }}>
                    아래에서 Google Gemini API 키를 입력하세요. 무료예요.
                  </p>
                </div>
              )}

              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>Google Gemini API 키</div>
                <div className="flex gap-2 mb-2">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter Gemini API key..."
                    className="input"
                    style={{ flex: 1, fontSize: '11px', padding: '4px 8px' }}
                  />
                  <button
                    onClick={async () => {
                      if (!apiKey) {
                        showToast("API 키를 입력하세요");
                        return;
                      }
                      showToast("테스트 중...");
                      try {
                        const result = await invoke<string>("test_gemini_key", { apiKey });
                        showToast(result);
                      } catch (e) {
                        showToast(`${e}`);
                      }
                    }}
                    className="btn btn-secondary"
                    style={{ fontSize: '10px', padding: '4px 12px', whiteSpace: 'nowrap' }}
                  >
                    테스트
                  </button>
                </div>
                <div className="code-block" style={{ padding: '6px', fontSize: '10px' }}>
                  <p className="font-bold mb-1"># {t("settings.apiKeyGuide")}</p>
                  <ol className="list-decimal list-inside space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                    <li>$ open <a href="https://aistudio.google.com/apikey" target="_blank" style={{ color: 'var(--accent)' }}>aistudio.google.com/apikey</a></li>
                    <li>$ {t("settings.apiKeyStep2")}</li>
                    <li>$ {t("settings.apiKeyStep3")}</li>
                  </ol>
                </div>
              </div>

              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>AI MODEL</div>
                <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} className="input" style={{ fontSize: '11px', padding: '4px 6px' }}>
                  {availableModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <div className="mt-2" style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                  2.0 = 저렴 | 2.5 = 균형 | 3.x = 최신/강력
                </div>
              </div>

              {/* 검색 API 설정 */}
              <div className="card" style={{ padding: '14px' }}>
                <div className="card-header" style={{ fontSize: '12px', marginBottom: '10px', paddingBottom: '8px' }}>
                  🔍 검색 API (리서치 기능용)
                </div>
                <p style={{ fontSize: '11px', color: 'var(--text-primary)', marginBottom: '14px', lineHeight: '1.6' }}>
                  AI 리서치 기능을 사용하려면 네이버 또는 Google 검색 API 키가 필요합니다.<br/>
                  <span style={{ color: 'var(--text-secondary)' }}>둘 다 설정하면 더 풍부한 검색 결과를 얻을 수 있습니다. (무료)</span>
                </p>

                {/* 네이버 API */}
                <div style={{ marginBottom: '18px', padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ background: '#03C75A', color: 'white', padding: '2px 6px', borderRadius: '3px', fontSize: '10px', fontWeight: 700 }}>N</span>
                    네이버 검색 API
                    {naverClientId && <span style={{ color: '#22c55e', fontSize: '11px', fontWeight: 500 }}>✓ 설정됨</span>}
                  </div>

                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={naverClientId}
                      onChange={(e) => setNaverClientId(e.target.value)}
                      placeholder="Client ID"
                      className="input"
                      style={{ flex: 1, fontSize: '11px', padding: '8px 10px' }}
                    />
                    <input
                      type="password"
                      value={naverClientSecret}
                      onChange={(e) => setNaverClientSecret(e.target.value)}
                      placeholder="Client Secret"
                      className="input"
                      style={{ flex: 1, fontSize: '11px', padding: '8px 10px' }}
                    />
                    <button
                      onClick={async () => {
                        if (!naverClientId || !naverClientSecret) {
                          showToast("Client ID와 Secret을 입력하세요");
                          return;
                        }
                        showToast("테스트 중...");
                        try {
                          const result = await invoke<string>("test_naver_key", { clientId: naverClientId, clientSecret: naverClientSecret });
                          showToast(result);
                        } catch (e) {
                          showToast(`${e}`);
                        }
                      }}
                      className="btn btn-secondary"
                      style={{ fontSize: '10px', padding: '8px 12px', whiteSpace: 'nowrap' }}
                    >
                      테스트
                    </button>
                  </div>

                  <div style={{ fontSize: '11px', color: 'var(--text-primary)', marginBottom: '10px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '6px', lineHeight: '1.8' }}>
                    <div style={{ fontWeight: 700, marginBottom: '8px', fontSize: '12px' }}>📋 API 키 발급 방법 (무료, 5분 소요)</div>
                    <div style={{ marginBottom: '4px' }}><strong>1.</strong> 아래 "네이버 개발자 센터" 링크 클릭 후 네이버 계정으로 로그인</div>
                    <div style={{ marginBottom: '4px' }}><strong>2.</strong> "애플리케이션 등록" 페이지에서 애플리케이션 이름 입력</div>
                    <div style={{ paddingLeft: '16px', color: 'var(--text-secondary)', marginBottom: '4px' }}>예: "JolaJoa 리서치" 또는 아무 이름</div>
                    <div style={{ marginBottom: '4px' }}><strong>3.</strong> "사용 API" 선택에서 반드시 <strong>"검색"</strong> 체크</div>
                    <div style={{ marginBottom: '4px' }}><strong>4.</strong> "비로그인 오픈 API 서비스 환경" 설정:</div>
                    <div style={{ paddingLeft: '16px', marginBottom: '4px' }}>• 환경 추가 버튼 클릭 → <strong>"WEB 설정"</strong> 선택</div>
                    <div style={{ paddingLeft: '16px', marginBottom: '4px' }}>• 웹 서비스 URL에 <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: '3px' }}>http://localhost</code> 입력</div>
                    <div style={{ marginBottom: '4px' }}><strong>5.</strong> "등록하기" 버튼 클릭</div>
                    <div><strong>6.</strong> 생성된 <strong>Client ID</strong>와 <strong>Client Secret</strong>을 위 입력란에 복사/붙여넣기</div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <a href="https://developers.naver.com/apps/#/register" target="_blank" rel="noopener noreferrer"
                       style={{ fontSize: '11px', color: '#03C75A', fontWeight: 600, textDecoration: 'underline' }}>
                      🔗 네이버 개발자 센터 - 애플리케이션 등록
                    </a>
                    <a href="https://developers.naver.com/docs/serviceapi/search/web/web.md" target="_blank" rel="noopener noreferrer"
                       style={{ fontSize: '10px', color: '#60a5fa', textDecoration: 'underline' }}>
                      📖 API 공식 문서
                    </a>
                  </div>
                </div>

                {/* Google API */}
                <div style={{ marginBottom: '18px', padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ background: '#4285F4', color: 'white', padding: '2px 6px', borderRadius: '3px', fontSize: '10px', fontWeight: 700 }}>G</span>
                    Google Custom Search API
                    {googleSearchApiKey && <span style={{ color: '#22c55e', fontSize: '11px', fontWeight: 500 }}>✓ 설정됨</span>}
                  </div>

                  <div className="flex gap-2 mb-3">
                    <input
                      type="password"
                      value={googleSearchApiKey}
                      onChange={(e) => setGoogleSearchApiKey(e.target.value)}
                      placeholder="API Key"
                      className="input"
                      style={{ flex: 1, fontSize: '11px', padding: '8px 10px' }}
                    />
                    <input
                      type="text"
                      value={googleSearchCx}
                      onChange={(e) => setGoogleSearchCx(e.target.value)}
                      placeholder="Search Engine ID (cx)"
                      className="input"
                      style={{ flex: 1, fontSize: '11px', padding: '8px 10px' }}
                    />
                    <button
                      onClick={async () => {
                        if (!googleSearchApiKey || !googleSearchCx) {
                          showToast("API Key와 CX를 입력하세요");
                          return;
                        }
                        showToast("테스트 중...");
                        try {
                          const result = await invoke<string>("test_google_key", { apiKey: googleSearchApiKey, cx: googleSearchCx });
                          showToast(result);
                        } catch (e) {
                          showToast(`${e}`);
                        }
                      }}
                      className="btn btn-secondary"
                      style={{ fontSize: '10px', padding: '8px 12px', whiteSpace: 'nowrap' }}
                    >
                      테스트
                    </button>
                  </div>

                  <div style={{ fontSize: '11px', color: 'var(--text-primary)', marginBottom: '10px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '6px', lineHeight: '1.8' }}>
                    <div style={{ fontWeight: 700, marginBottom: '8px', fontSize: '12px' }}>📋 API 키 발급 방법 (무료, 10분 소요)</div>

                    <div style={{ fontWeight: 600, marginTop: '8px', marginBottom: '6px', borderBottom: '1px solid var(--border-light)', paddingBottom: '4px' }}>1단계: 검색 엔진 ID (cx) 만들기</div>
                    <div style={{ marginBottom: '4px' }}><strong>1.</strong> 아래 "Programmable Search Engine" 링크 클릭</div>
                    <div style={{ marginBottom: '4px' }}><strong>2.</strong> Google 계정으로 로그인</div>
                    <div style={{ marginBottom: '4px' }}><strong>3.</strong> "새 검색 엔진 만들기" 또는 "추가" 버튼 클릭</div>
                    <div style={{ marginBottom: '4px' }}><strong>4.</strong> "검색할 사이트"에 아무 사이트나 입력 (예: <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: '3px' }}>google.com</code>)</div>
                    <div style={{ marginBottom: '4px' }}><strong>5.</strong> 검색 엔진 생성 후 "수정" 또는 "제어판"으로 이동</div>
                    <div style={{ marginBottom: '4px' }}><strong>6.</strong> <strong>"전체 웹 검색"</strong>을 반드시 <strong>켜기</strong>로 설정 (중요!)</div>
                    <div style={{ marginBottom: '4px' }}><strong>7.</strong> "검색 엔진 ID" (cx로 시작하는 문자열) 복사</div>

                    <div style={{ fontWeight: 600, marginTop: '12px', marginBottom: '6px', borderBottom: '1px solid var(--border-light)', paddingBottom: '4px' }}>2단계: API 키 발급</div>
                    <div style={{ marginBottom: '4px' }}><strong>1.</strong> 아래 "Google Cloud Console" 링크 클릭</div>
                    <div style={{ marginBottom: '4px' }}><strong>2.</strong> 프로젝트가 없으면 새 프로젝트 생성</div>
                    <div style={{ marginBottom: '4px' }}><strong>3.</strong> 왼쪽 메뉴에서 "사용자 인증 정보" 선택</div>
                    <div style={{ marginBottom: '4px' }}><strong>4.</strong> "사용자 인증 정보 만들기" → "API 키" 클릭</div>
                    <div style={{ marginBottom: '4px' }}><strong>5.</strong> 생성된 API 키 복사해서 위 입력란에 붙여넣기</div>
                    <div style={{ marginTop: '8px', padding: '8px', background: 'var(--bg-tertiary)', borderRadius: '4px', fontSize: '10px', color: 'var(--text-secondary)' }}>
                      ⚠️ 처음 사용 시 "Custom Search API"를 활성화해야 할 수 있습니다.<br/>
                      "API 및 서비스" → "라이브러리" → "Custom Search API" 검색 → "사용" 클릭
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <a href="https://programmablesearchengine.google.com/controlpanel/create" target="_blank" rel="noopener noreferrer"
                       style={{ fontSize: '11px', color: '#4285F4', fontWeight: 600, textDecoration: 'underline' }}>
                      🔗 1단계: Programmable Search Engine (검색 엔진 생성)
                    </a>
                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer"
                       style={{ fontSize: '11px', color: '#4285F4', fontWeight: 600, textDecoration: 'underline' }}>
                      🔗 2단계: Google Cloud Console (API 키 발급)
                    </a>
                    <a href="https://developers.google.com/custom-search/v1/introduction" target="_blank" rel="noopener noreferrer"
                       style={{ fontSize: '10px', color: '#60a5fa', textDecoration: 'underline' }}>
                      📖 API 공식 문서
                    </a>
                  </div>
                </div>

                <button
                  onClick={async () => {
                    try {
                      await invoke("save_setting", { key: "naver_client_id", value: naverClientId });
                      await invoke("save_setting", { key: "naver_client_secret", value: naverClientSecret });
                      await invoke("save_setting", { key: "google_search_api_key", value: googleSearchApiKey });
                      await invoke("save_setting", { key: "google_search_cx", value: googleSearchCx });
                      showToast("검색 API 설정 저장됨");
                    } catch (e) {
                      showToast(`저장 실패: ${e}`);
                    }
                  }}
                  className="btn btn-primary"
                  style={{ fontSize: '12px', padding: '10px 12px', width: '100%' }}
                >
                  검색 API 설정 저장
                </button>
              </div>

              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>LANGUAGE</div>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className="input" style={{ fontSize: '11px', padding: '4px 6px' }}>
                  {languages.map((lang) => <option key={lang.code} value={lang.code}>{lang.name}</option>)}
                </select>
              </div>

              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>화면 크기 ({zoomLevel}%)</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const newZoom = Math.max(70, zoomLevel - 10);
                      setZoomLevel(newZoom);
                      document.documentElement.style.fontSize = `${newZoom}%`;
                    }}
                    className="btn btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                  >−</button>
                  <input
                    type="range"
                    min="70"
                    max="150"
                    step="10"
                    value={zoomLevel}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      setZoomLevel(val);
                      document.documentElement.style.fontSize = `${val}%`;
                    }}
                    className="flex-1"
                    style={{ height: '20px' }}
                  />
                  <button
                    onClick={() => {
                      const newZoom = Math.min(150, zoomLevel + 10);
                      setZoomLevel(newZoom);
                      document.documentElement.style.fontSize = `${newZoom}%`;
                    }}
                    className="btn btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                  >+</button>
                </div>
              </div>

              {/* 첨부파일 설정 */}
              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>첨부파일 설정</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span style={{ fontSize: '11px' }}>파일 저장 방식</span>
                    <select
                      id="attachmentCopyMode"
                      className="input"
                      style={{ padding: '4px 6px', fontSize: '11px', width: '120px' }}
                      value={attachmentCopyMode}
                      onChange={async (e) => {
                        setAttachmentCopyMode(e.target.value);
                        await invoke("save_setting", { key: "attachment_copy_mode", value: e.target.value });
                      }}
                    >
                      <option value="link">링크만 저장</option>
                      <option value="copy">파일 복사</option>
                    </select>
                  </div>
                  <p style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                    링크: 원본 위치 참조 (용량 절약) | 복사: 앱 폴더에 복사 (안전)
                  </p>
                </div>
              </div>

              <button onClick={handleSaveSettings} className="btn btn-primary w-full" style={{ padding: '6px 12px', fontSize: '11px' }}>SAVE_SETTINGS</button>

              <div className="flex gap-2">
                <div className="card flex-1" style={{ padding: '8px' }}>
                  <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>DATA_BACKUP</div>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        const json = await invoke<string>("export_db");
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(new Blob([json]));
                        a.download = `jolajoa_backup.json`;
                        a.click();
                      }}
                      className="btn btn-secondary flex-1"
                      style={{ padding: '4px 8px', fontSize: '10px' }}
                    >EXPORT</button>
                    <label className="flex-1">
                      <input type="file" accept=".json" className="hidden" onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) { await invoke("import_db", { jsonData: await file.text() }); loadMemos(); }
                        e.target.value = "";
                      }} />
                      <div className="btn btn-secondary text-center cursor-pointer" style={{ padding: '4px 8px', fontSize: '10px' }}>IMPORT</div>
                    </label>
                  </div>
                </div>
                <div className="card flex-1" style={{ padding: '8px' }}>
                  <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>DANGER</div>
                  <button onClick={deleteAllMemos} className="btn btn-danger w-full" style={{ padding: '4px 8px', fontSize: '10px' }}>
                    DELETE_ALL ({totalMemoCount})
                  </button>
                </div>
              </div>

              {(result || error) && (
                <p className={`status ${error ? 'status-error' : 'status-success'}`} style={{ fontSize: '10px' }}>{error || result}</p>
              )}
            </div>
          )}

          {/* ===== MEMO VIEW & EDIT (실시간 저장) ===== */}
          {selectedMemo && (
            <div className="space-y-3">
              {/* 헤더: 닫기 & 삭제 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="tag" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: '10px', padding: '2px 6px', border: '1px solid var(--border)' }}>{editCategory}</span>
                  {saving && <span className="status status-warning" style={{ fontSize: '10px' }}>저장 중...</span>}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => {
                      const content = memoViewTab === "original" ? editOriginal : editContent;
                      navigator.clipboard.writeText(content);
                      showToast("📋 클립보드에 복사되었습니다");
                    }}
                    className="btn"
                    style={{ padding: '4px 8px', fontSize: '10px' }}
                  >
                    복사
                  </button>
                  <button onClick={autoSave} className="btn btn-primary" style={{ padding: '4px 8px', fontSize: '10px' }}>{saving ? '...' : '저장'}</button>
                  <button onClick={reanalyzeMemo} className="btn" style={{ padding: '4px 8px', fontSize: '10px' }} disabled={reanalyzing}>{reanalyzing ? '...' : '학습'}</button>
                  <button onClick={deleteMemo} className="btn btn-danger" style={{ padding: '4px 8px', fontSize: '10px' }}>삭제</button>
                  <button onClick={() => setSelectedMemo(null)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }}>닫기</button>
                </div>
              </div>

              {/* 제목 (인라인 편집) */}
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full text-base font-bold uppercase bg-transparent border-b-2 focus:outline-none py-1"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                placeholder="TITLE..."
              />

              {/* 카테고리 & 태그 (인라인 편집) */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="section-label block mb-1" style={{ fontSize: '9px' }}>CAT</label>
                  <div className="flex gap-1">
                    <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className="input flex-1" style={{ padding: '4px 6px', fontSize: '11px' }}>
                      {allCategories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                    <input type="text" value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className="input flex-1" placeholder="New..." style={{ padding: '4px 6px', fontSize: '11px' }} />
                  </div>
                </div>
                <div className="flex-1">
                  <label className="section-label block mb-1" style={{ fontSize: '9px' }}>TAGS</label>
                  <input type="text" value={editTags} onChange={(e) => setEditTags(e.target.value)} className="input" placeholder="tag1, tag2" style={{ padding: '4px 6px', fontSize: '11px' }} />
                </div>
              </div>

              {/* 탭 버튼 */}
              <div className="flex gap-1 items-center" style={{ borderBottom: '1px solid var(--border-light)', paddingBottom: '8px', marginBottom: '8px' }}>
                {[
                  { id: "formatted" as const, label: "📝 정리본" },
                  { id: "original" as const, label: "📄 원본" },
                  { id: "attachments" as const, label: `📎 첨부 (${attachments.length})` }
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => { setMemoViewTab(t.id); setIsEditing(false); }}
                    className="btn"
                    style={{
                      padding: '4px 10px',
                      fontSize: '11px',
                      background: memoViewTab === t.id ? 'var(--accent)' : 'var(--bg-secondary)',
                      color: memoViewTab === t.id ? 'var(--accent-text)' : 'var(--text)'
                    }}
                  >
                    {t.label}
                  </button>
                ))}
                <div className="flex-1" />
                {(memoViewTab === "formatted" || memoViewTab === "original") && (
                  <button
                    onClick={() => setIsEditing(!isEditing)}
                    className="btn"
                    style={{
                      padding: '4px 10px',
                      fontSize: '11px',
                      background: isEditing ? 'var(--warning)' : 'var(--bg-secondary)',
                      color: isEditing ? 'var(--accent-text)' : 'var(--text)'
                    }}
                  >
                    {isEditing ? '✓ 완료' : '✏️ 편집'}
                  </button>
                )}
              </div>

              {/* 탭 콘텐츠 */}
              <div className="card flex-1" style={{ padding: '12px' }}>
                {/* 정리본 탭 */}
                {memoViewTab === "formatted" && (
                  isEditing ? (
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="input w-full resize-none"
                      placeholder="정리본을 편집하세요..."
                      style={{ fontSize: '12px', minHeight: '300px', lineHeight: '1.6' }}
                    />
                  ) : (
                    <div style={{ fontSize: '13px', lineHeight: '1.6' }}>{renderMarkdown(editContent)}</div>
                  )
                )}

                {/* 원본 탭 */}
                {memoViewTab === "original" && selectedMemo && (
                  isEditing ? (
                    <textarea
                      value={editOriginal}
                      onChange={(e) => setEditOriginal(e.target.value)}
                      className="input w-full resize-none"
                      placeholder="원본을 편집하세요..."
                      style={{ fontSize: '12px', minHeight: '300px', lineHeight: '1.5' }}
                    />
                  ) : (
                    <pre style={{ fontSize: '12px', whiteSpace: 'pre-wrap', color: 'var(--text)', fontFamily: 'inherit', lineHeight: '1.5' }}>{editOriginal}</pre>
                  )
                )}

                {/* 첨부파일 탭 */}
                {memoViewTab === "attachments" && (
                  <div>
                    {/* 드래그앤드롭 영역 */}
                    <div
                      onDragOver={(e) => { e.preventDefault(); setIsDraggingFile(true); }}
                      onDragLeave={() => setIsDraggingFile(false)}
                      onDrop={handleFileDrop}
                      style={{
                        border: `2px dashed ${isDraggingFile ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: '6px',
                        padding: '20px',
                        textAlign: 'center',
                        marginBottom: '12px',
                        background: isDraggingFile ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                        transition: 'all 0.2s ease'
                      }}
                    >
                      <p style={{ fontSize: '13px', color: isDraggingFile ? 'var(--accent)' : 'var(--text-muted)' }}>
                        {isDraggingFile ? '여기에 놓으세요' : '📂 파일을 드래그하여 첨부'}
                      </p>
                    </div>

                    {/* 첨부파일 목록 */}
                    {attachments.length === 0 ? (
                      <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '20px' }}>
                        첨부된 파일이 없습니다
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {attachments.map((att) => (
                          <div
                            key={att.id}
                            className="flex items-center gap-2 p-3"
                            style={{
                              background: 'var(--bg-secondary)',
                              borderRadius: '6px',
                              fontSize: '12px'
                            }}
                          >
                            <span style={{ fontSize: '20px' }}>
                              {att.file_name.match(/\.(jpg|jpeg|png|gif|bmp|webp)$/i) ? '🖼️' :
                               att.file_name.match(/\.(pdf)$/i) ? '📄' :
                               att.file_name.match(/\.(doc|docx)$/i) ? '📝' :
                               att.file_name.match(/\.(xls|xlsx)$/i) ? '📊' :
                               att.file_name.match(/\.(zip|rar|7z)$/i) ? '📦' :
                               att.file_name.match(/\.(mp3|wav|m4a)$/i) ? '🎵' :
                               att.file_name.match(/\.(mp4|mov|avi)$/i) ? '🎬' : '📎'}
                            </span>
                            <div className="flex-1">
                              <button
                                onClick={() => openAttachment(att.file_path)}
                                className="hover:underline"
                                style={{ color: 'var(--text)', background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 500 }}
                              >
                                {att.file_name}
                              </button>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                {formatFileSize(att.file_size)} {att.is_copy && '• 복사됨'}
                              </div>
                            </div>
                            <button
                              onClick={() => removeAttachment(att.id)}
                              className="btn btn-danger"
                              style={{ padding: '4px 8px', fontSize: '10px' }}
                            >
                              삭제
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 메타 정보 */}
              <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                {selectedMemo.created_at} | {selectedMemo.updated_at}
              </div>
            </div>
          )}
        </div>
      </div>}

      {/* ===== FOOTER ===== */}
      {!minimized && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 16px',
          borderTop: '1px solid var(--border-light)',
          background: 'var(--bg-secondary)'
        }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            JolaJoa Memo {appVersion && `v${appVersion}`}
          </span>
          <a
            href="https://github.com/johunsang/jolajoamemo/issues"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '10px',
              color: 'var(--text-muted)',
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            💬 피드백
          </a>
        </div>
      )}

      {/* 토스트 알림 */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--text)',
            color: 'var(--bg)',
            padding: '12px 24px',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 500,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            zIndex: 9999,
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
