import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

type Tab = "input" | "search" | "settings";

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
  const [selectedMemo, setSelectedMemo] = useState<Memo | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editTags, setEditTags] = useState("");
  const [saving, setSaving] = useState(false);

  const [draggedMemo, setDraggedMemo] = useState<Memo | null>(null);
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body: string; showDetails?: boolean } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [opacity, setOpacity] = useState(100);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadSettings();
    loadUsage();
    loadMemos();
    checkForUpdates();
  }, []);

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

  const changeOpacity = async (val: number) => {
    setOpacity(val);
    try {
      document.body.style.opacity = `${val / 100}`;
      await invoke("save_setting", { key: "opacity", value: val.toString() });
    } catch (e) { console.error(e); }
  };

  const loadUsage = async () => {
    try { setUsage(await invoke<UsageStats>("get_usage")); } catch (e) { console.error(e); }
  };

  const loadMemos = async () => {
    try {
      const list = await invoke<Memo[]>("get_memos");
      setMemos(list);
      // 카테고리 기본 닫힘 상태
      setExpandedCategories(new Set());
    } catch (e) { console.error(e); }
  };

  const handleInput = async () => {
    if (!inputText.trim()) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await invoke<InputResult>("input_memo", { content: inputText });
      setResult(res.message);
      setInputText("");
      loadUsage(); loadMemos();
    } catch (e) { setError(String(e)); }
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
      await invoke("save_setting", { key: "language", value: language });
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
                        border: `1px solid ${selectedMemo?.id === memo.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                        background: selectedMemo?.id === memo.id ? 'var(--color-accent)' : 'var(--color-bg)',
                        color: selectedMemo?.id === memo.id ? '#ffffff' : 'var(--color-text)'
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
    <div className="h-screen flex flex-col" style={{ background: 'var(--color-bg)' }}>
      {/* ===== TOP NAV BAR ===== */}
      <div className="h-9 flex items-center justify-between px-3" style={{ borderBottom: '2px solid var(--color-border)', background: 'var(--color-text)', color: 'var(--color-bg)' }}>
        <div className="flex items-center gap-2">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="px-2 py-1 text-sm font-bold" style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}>
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <span className="text-sm font-bold uppercase">{t("app.title")}</span>
        </div>

        <nav className="flex gap-1">
          {[
            { id: "input" as Tab, label: "NEW" },
            { id: "search" as Tab, label: "SEARCH" },
            { id: "settings" as Tab, label: "SET" },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => { setTab(item.id); setSelectedMemo(null); setResult(null); }}
              className="px-3 py-1 text-xs font-bold uppercase"
              style={{
                background: tab === item.id && !selectedMemo ? 'var(--color-bg)' : 'var(--color-bg)',
                color: tab === item.id && !selectedMemo ? 'var(--color-accent)' : 'var(--color-text)',
                border: tab === item.id && !selectedMemo ? '2px solid var(--color-accent)' : '2px solid var(--color-border)'
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {saving && <span className="text-sm opacity-70">...</span>}
          <button onClick={toggleAlwaysOnTop} className="px-2 py-1 text-sm" style={{ background: alwaysOnTop ? 'var(--color-accent)' : 'transparent', color: alwaysOnTop ? '#fff' : 'inherit' }} title="Always on Top">
            📌
          </button>
          <button onClick={() => changeOpacity(opacity >= 100 ? 70 : 100)} className="px-2 py-1 text-sm" style={{ background: opacity < 100 ? 'var(--color-accent)' : 'transparent', color: opacity < 100 ? '#fff' : 'inherit' }} title={`Opacity ${opacity}%`}>
            👁
          </button>
          <button onClick={toggleDarkMode} className="px-2 py-1 text-sm" style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}>
            {darkMode ? '☀' : '☾'}
          </button>
          <a
            href="https://github.com/johunsang/jolajoamemo/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1 text-sm font-bold"
            style={{ background: '#ff0000', color: '#ffffff', textDecoration: 'none' }}
          >
            FEEDBACK
          </a>
        </div>
      </div>

      {/* ===== UPDATE BANNER ===== */}
      {updateAvailable && (
        <div style={{ background: 'var(--color-accent)', color: '#ffffff' }}>
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
                style={{ background: '#ffffff', color: 'var(--color-accent)', border: 'none' }}
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
      <div className="flex-1 flex overflow-hidden">
        {/* ===== LEFT SIDEBAR (카테고리) ===== */}
        {sidebarOpen && (
        <div className="w-44 flex flex-col overflow-hidden" style={{ borderRight: '2px solid var(--color-border)' }}>
          <div className="px-2 py-1 flex justify-between items-center" style={{ borderBottom: '1px solid var(--color-border)' }}>
            <p className="section-label">MEMOS ({memos.length})</p>
            <button
              onClick={() => {
                if (expandedCategories.size > 0) {
                  setExpandedCategories(new Set());
                } else {
                  setExpandedCategories(new Set(allCategories));
                }
              }}
              className="text-xs px-1"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {expandedCategories.size > 0 ? '[-]' : '[+]'}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {Object.keys(categoryTree.children).length === 0 ? (
              <div className="p-4 text-center" style={{ border: '2px dashed var(--color-text-muted)' }}>
                <p style={{ color: 'var(--color-text-muted)' }} className="text-xs uppercase">No memos yet</p>
              </div>
            ) : (
              renderCategoryNode(categoryTree)
            )}
          </div>

          {usage && (
            <div className="px-2 py-1" style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)', fontSize: '10px' }}>
              <div className="flex justify-between" style={{ color: 'var(--color-text-muted)' }}>
                <span>{usage.today_input_tokens + usage.today_output_tokens}tk</span>
                <span>${usage.today_cost_usd.toFixed(3)}</span>
              </div>
            </div>
          )}
        </div>
        )}

        {/* ===== MAIN CONTENT ===== */}
        <div className="flex-1 overflow-auto p-4" style={{ background: 'var(--color-bg-secondary)' }}>
          {/* ===== NEW MEMO ===== */}
          {tab === "input" && !selectedMemo && (
            <div className="card" style={{ padding: '8px' }}>
              <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>
                {t("input.title")}
                {loading && <span style={{ marginLeft: '8px', color: 'var(--color-warning)' }}>저장중...</span>}
                {!loading && result && <span style={{ marginLeft: '8px', color: 'var(--color-success)' }}>✓</span>}
              </div>
              <textarea
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  // 자동 저장: 2초 후 저장
                  if (e.target.value.trim().length > 10) {
                    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
                    saveTimeoutRef.current = setTimeout(() => {
                      if (e.target.value.trim().length > 10) handleInput();
                    }, 2000);
                  }
                }}
                placeholder={t("input.placeholder")}
                className="input resize-none"
                style={{ fontSize: '12px', height: '120px' }}
                disabled={loading}
              />
              {error && <p style={{ fontSize: '10px', color: 'var(--color-error)', marginTop: '4px' }}>{error}</p>}
            </div>
          )}

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
                    style={{ fontSize: '12px', padding: '4px 8px' }}
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

          {/* ===== SETTINGS ===== */}
          {tab === "settings" && !selectedMemo && (
            <div className="space-y-3">
              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>API_KEY</div>
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
                  <ol className="list-decimal list-inside space-y-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                    <li>$ open <a href="https://aistudio.google.com/apikey" target="_blank" style={{ color: 'var(--color-accent)' }}>aistudio.google.com/apikey</a></li>
                    <li>$ {t("settings.apiKeyStep2")}</li>
                    <li>$ {t("settings.apiKeyStep3")}</li>
                  </ol>
                </div>
              </div>

              <div className="card" style={{ padding: '8px' }}>
                <div className="card-header" style={{ fontSize: '10px', marginBottom: '4px', paddingBottom: '4px' }}>LANGUAGE</div>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className="input" style={{ fontSize: '11px', padding: '4px 6px' }}>
                  {languages.map((lang) => <option key={lang.code} value={lang.code}>{lang.name}</option>)}
                </select>
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
                    DELETE_ALL ({memos.length})
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
                  <span className="tag" style={{ background: 'var(--color-accent)', color: '#ffffff', fontSize: '10px', padding: '2px 6px' }}>{editCategory}</span>
                  {saving && <span className="status status-warning" style={{ fontSize: '10px' }}>SAVING...</span>}
                </div>
                <div className="flex gap-1">
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
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
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
              <div style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
                {selectedMemo.created_at} | {selectedMemo.updated_at}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
