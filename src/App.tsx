import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useTranslation } from "react-i18next";
import { languages } from "./i18n";

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

type Tab = "input" | "search" | "schedule" | "todo" | "ledger" | "settings";

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

function App() {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<Tab>("input");
  const [inputText, setInputText] = useState("");
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(false);
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
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body: string; showDetails?: boolean } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [_opacity, setOpacity] = useState(100);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiModel, setAiModel] = useState("gemini-3-flash-preview");
  const [appVersion, setAppVersion] = useState("");

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

  useEffect(() => {
    loadSettings();
    loadUsage();
    loadMemos();
    loadSchedules();
    loadTodos();
    loadTransactions();
    checkForUpdates();
    getVersion().then(v => setAppVersion(v)).catch(() => {});
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

  const checkForUpdates = async () => {
    try {
      const update = await check();
      if (update) {
        setUpdateAvailable({ version: update.version, body: update.body || "" });
      }
    } catch (e) {
      console.log("Update check failed:", e);
    }
  };

  const installUpdate = async () => {
    if (!updateAvailable) return;
    setUpdating(true);
    try {
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
        await relaunch();
      }
    } catch (e) {
      console.error("Update failed:", e);
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

  // 메모 선택 시 편집 필드 초기화
  useEffect(() => {
    if (selectedMemo) {
      setEditTitle(selectedMemo.title);
      setEditContent(selectedMemo.formatted_content);
      setEditCategory(selectedMemo.category);
      setEditTags(selectedMemo.tags);
    }
  }, [selectedMemo]);

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
        tags: editTags
      });
      // 사이드바의 메모 목록 업데이트
      setMemos(prev => prev.map(m =>
        m.id === selectedMemo.id
          ? { ...m, title: editTitle, formatted_content: editContent, category: editCategory, tags: editTags }
          : m
      ));
      setSelectedMemo(prev => prev ? { ...prev, title: editTitle, formatted_content: editContent, category: editCategory, tags: editTags } : null);
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  }, [selectedMemo, editTitle, editContent, editCategory, editTags]);

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
    if (!inputText.trim()) return;
    const savedText = inputText;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await invoke<InputResult>("input_memo", { content: savedText });
      setResult(res.message);
      // 저장 후 내용 유지 - 새로 작성 버튼 눌러야 초기화
      loadUsage(); loadMemos(); loadSchedules(); loadTodos(); loadTransactions();
    } catch (e) {
      setError(String(e));
    }
    finally { setLoading(false); }
  };

  const handleSearch = async () => {
    if (!searchText.trim()) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await invoke<SearchResult>("search_memo", { question: searchText });
      setResult(res.answer);
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

  const categoryTree = buildCategoryTree(memos);
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
          <button
            onClick={() => {
              const newSet = new Set(expandedCategories);
              newSet.has(child.path) ? newSet.delete(child.path) : newSet.add(child.path);
              setExpandedCategories(newSet);
            }}
            className="category w-full flex items-center gap-1 cursor-pointer mb-1"
            style={{ fontSize: `${Math.max(10, 11 - depth)}px` }}
          >
            <span>{isExpanded ? '[-]' : '[+]'}</span>
            <span className="flex-1 text-left">{child.name}</span>
            <span className="tag">{totalMemos}</span>
          </button>

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
                      onClick={() => setSelectedMemo(memo)}
                      draggable
                      onDragStart={() => setDraggedMemo(memo)}
                      onDragEnd={() => { setDraggedMemo(null); setDragOverCategory(null); }}
                      className={`w-full text-left px-2 py-1 text-xs cursor-pointer ${draggedMemo?.id === memo.id ? 'opacity-50' : ''}`}
                      style={{
                        border: `1px solid ${selectedMemo?.id === memo.id ? 'var(--accent)' : 'var(--border)'}`,
                        background: selectedMemo?.id === memo.id ? 'var(--accent)' : 'var(--bg)',
                        color: selectedMemo?.id === memo.id ? '#ffffff' : 'var(--text)'
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

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg)' }}>
      {/* ===== TOP NAV BAR - macOS Native Style ===== */}
      <div
        className="h-10 flex items-center justify-between px-3 select-none"
        style={{
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-light)',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}
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
              { id: "input" as Tab, label: "메모" },
              { id: "search" as Tab, label: "검색" },
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
          <button
            onClick={toggleMinimized}
            className="btn"
            style={{
              padding: minimized ? '4px 12px' : '4px 8px',
              background: minimized ? 'var(--accent)' : 'transparent',
              color: minimized ? '#fff' : 'var(--text)',
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

      {/* ===== UPDATE BANNER ===== */}
      {!minimized && updateAvailable && (
        <div style={{ background: 'var(--accent)', color: '#ffffff' }}>
          <div className="flex items-center justify-between px-6 py-3">
            <span className="font-bold uppercase">
              NEW VERSION {updateAvailable.version} AVAILABLE
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setUpdateAvailable(prev => prev ? { ...prev, showDetails: !prev.showDetails } : null)}
                className="px-4 py-2 font-bold uppercase"
                style={{ background: 'transparent', color: '#ffffff', border: '2px solid #ffffff' }}
              >
                {updateAvailable.showDetails ? 'HIDE' : "WHAT'S NEW"}
              </button>
              <button
                onClick={installUpdate}
                disabled={updating}
                className="px-4 py-2 font-bold uppercase"
                style={{ background: 'var(--bg)', color: 'var(--accent)', border: 'none' }}
              >
                {updating ? 'UPDATING...' : 'UPDATE NOW'}
              </button>
            </div>
          </div>
          {updateAvailable.showDetails && updateAvailable.body && (
            <div className="px-6 pb-4">
              <div className="p-4 text-sm" style={{ background: 'rgba(0,0,0,0.2)', maxHeight: '200px', overflowY: 'auto' }}>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{updateAvailable.body}</pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== MAIN LAYOUT ===== */}
      {!minimized && <div className="flex-1 flex overflow-hidden">
        {/* ===== LEFT SIDEBAR ===== */}
        {sidebarOpen && (
        <div className="w-52 flex flex-col overflow-hidden" style={{ borderRight: '1px solid var(--border-light)', background: 'var(--bg-secondary)' }}>
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
                  ) : memos.length > 0 && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>끝</span>
                  )}
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

        {/* ===== MAIN CONTENT ===== */}
        <div className="flex-1 overflow-auto p-4 flex flex-col" style={{ background: 'var(--bg)' }}>
          {/* ===== HOME DASHBOARD + MEMO INPUT ===== */}
          {tab === "input" && !selectedMemo && (() => {
            // 오늘/내일 일정
            const now = new Date();
            const today = now.toISOString().split('T')[0];
            const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
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
                <div className="card flex-1 flex flex-col" style={{ padding: '8px' }}>
                  <div className="card-header flex justify-between items-center" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>
                    <span>
                      {t("input.title")}
                      {loading && <span style={{ marginLeft: '8px', color: 'var(--text-muted)' }}>저장중...</span>}
                      {!loading && result && <span style={{ marginLeft: '8px', color: 'var(--success)' }}>✓ {result}</span>}
                    </span>
                    <div className="flex gap-2">
                      {inputText.trim() && (
                        <button
                          onClick={() => { setInputText(""); setResult(null); setError(null); }}
                          disabled={loading}
                          className="btn"
                          style={{ padding: '4px 10px', fontSize: '11px' }}
                        >
                          새로 작성
                        </button>
                      )}
                      <button
                        onClick={handleInput}
                        disabled={loading || !inputText.trim()}
                        className="btn btn-primary"
                        style={{ padding: '4px 12px', fontSize: '11px' }}
                      >
                        {loading ? '저장중...' : '저장'}
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && inputText.trim() && !loading) {
                        handleInput();
                      }
                    }}
                    placeholder={t("input.placeholder")}
                    className="input resize-none flex-1"
                    style={{ fontSize: '12px' }}
                    disabled={loading}
                  />
                  <div className="flex items-center justify-between" style={{ marginTop: '4px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      ⌘/Ctrl+Enter로 저장
                    </span>
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
                    GO
                  </button>
                </div>
                {result && (
                  <div className="code-block mt-2" style={{ padding: '8px', fontSize: '12px' }}>
                    <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>AI_RESPONSE</div>
                    <div>{renderMarkdown(result)}</div>
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
                    // 오늘/내일 체크
                    const now = new Date();
                    const today = now.toISOString().split('T')[0];
                    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
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
                                      {tx.tx_type === 'income' ? '↓' : '↑'}
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
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter Gemini API key..."
                  className="input mb-2"
                  style={{ fontSize: '11px', padding: '4px 8px' }}
                />
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

              {/* 버전 정보 */}
              <div style={{ textAlign: 'center', paddingTop: '16px', fontSize: '11px', color: 'var(--text-muted)' }}>
                졸라좋아 메모 {appVersion && `v${appVersion}`}
              </div>
            </div>
          )}

          {/* ===== MEMO VIEW & EDIT (실시간 저장) ===== */}
          {selectedMemo && (
            <div className="space-y-3">
              {/* 헤더: 닫기 & 삭제 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="tag" style={{ background: 'var(--accent)', color: '#ffffff', fontSize: '10px', padding: '2px 6px' }}>{editCategory}</span>
                  {saving && <span className="status status-warning" style={{ fontSize: '10px' }}>SAVING...</span>}
                </div>
                <div className="flex gap-1">
                  <button onClick={autoSave} className="btn btn-primary" style={{ padding: '4px 8px', fontSize: '10px' }}>{saving ? '...' : 'SAVE'}</button>
                  <button onClick={reanalyzeMemo} className="btn" style={{ padding: '4px 8px', fontSize: '10px', background: 'var(--accent)', color: '#fff' }} disabled={reanalyzing}>{reanalyzing ? '...' : 'AI'}</button>
                  <button onClick={deleteMemo} className="btn btn-danger" style={{ padding: '4px 8px', fontSize: '10px' }}>DEL</button>
                  <button onClick={() => setSelectedMemo(null)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }}>X</button>
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

              {/* 내용 (인라인 편집) */}
              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>CONTENT</div>
                <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} className="input h-40 resize-none" placeholder="Write your memo here..." style={{ fontSize: '12px' }} />
              </div>

              {/* 미리보기 */}
              {editContent && (
                <div className="card" style={{ padding: '8px' }}>
                  <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>PREVIEW</div>
                  <div style={{ fontSize: '12px' }}>{renderMarkdown(editContent)}</div>
                </div>
              )}

              {/* 메타 정보 */}
              <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                {selectedMemo.created_at} | {selectedMemo.updated_at}
              </div>
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}

export default App;
