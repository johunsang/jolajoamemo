import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body: string } | null>(null);
  const [updating, setUpdating] = useState(false);

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
      setApiKey(key);
      if (lang) { setLanguage(lang); i18n.changeLanguage(lang); }
      if (dark === "true") setDarkMode(true);
    } catch (e) { console.error(e); }
  };

  const toggleDarkMode = async () => {
    const newMode = !darkMode;
    setDarkMode(newMode);
    try {
      await invoke("save_setting", { key: "dark_mode", value: newMode.toString() });
    } catch (e) { console.error(e); }
  };

  const loadUsage = async () => {
    try { setUsage(await invoke<UsageStats>("get_usage")); } catch (e) { console.error(e); }
  };

  const loadMemos = async () => {
    try {
      const list = await invoke<Memo[]>("get_memos");
      setMemos(list);
      setExpandedCategories(new Set(list.map((m) => m.category || "etc")));
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
    if (!selectedMemo || !confirm(t("confirm.delete"))) return;
    try {
      await invoke("delete_memo", { id: selectedMemo.id });
      setSelectedMemo(null);
      loadMemos();
    } catch (e) { setError(String(e)); }
  };

  const deleteAllMemos = async () => {
    if (!confirm(t("confirm.deleteAll") || "정말로 모든 메모를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) return;
    if (!confirm("⚠️ 마지막 확인: 모든 데이터가 영구 삭제됩니다!")) return;
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

    memoList.forEach(memo => {
      const category = memo.category || "etc";
      const parts = category.split("/").filter(p => p.trim());

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
      <div className="h-20 flex items-center justify-between px-6" style={{ borderBottom: '3px solid var(--color-border)', background: 'var(--color-text)', color: 'var(--color-bg)' }}>
        <h1 className="text-xl font-bold uppercase tracking-wide ml-4">{t("app.title")}</h1>

        <nav className="flex gap-4">
          {[
            { id: "input" as Tab, label: t("nav.newMemo") },
            { id: "search" as Tab, label: t("nav.search") },
            { id: "settings" as Tab, label: t("nav.settings") },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => { setTab(item.id); setSelectedMemo(null); setResult(null); }}
              className={`px-8 py-4 text-lg font-bold uppercase ${
                tab === item.id && !selectedMemo
                  ? 'bg-[var(--color-bg)] text-[var(--color-text)]'
                  : 'hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]'
              }`}
              style={{ border: '3px solid var(--color-bg)' }}
            >
              [{item.id.toUpperCase()}]
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-4">
          {saving && <span className="text-sm opacity-70">(SAVING...)</span>}
          <button onClick={toggleDarkMode} className="px-5 py-2 text-base font-bold uppercase" style={{ border: '2px solid var(--color-bg)' }}>
            {darkMode ? '☀ LIGHT' : '☾ DARK'}
          </button>
        </div>
      </div>

      {/* ===== UPDATE BANNER ===== */}
      {updateAvailable && (
        <div className="flex items-center justify-between px-6 py-3" style={{ background: 'var(--color-accent)', color: '#ffffff' }}>
          <span className="font-bold uppercase">
            NEW VERSION {updateAvailable.version} AVAILABLE
          </span>
          <button
            onClick={installUpdate}
            disabled={updating}
            className="px-4 py-2 font-bold uppercase"
            style={{ background: '#ffffff', color: 'var(--color-accent)', border: 'none' }}
          >
            {updating ? 'UPDATING...' : 'UPDATE NOW'}
          </button>
        </div>
      )}

      {/* ===== MAIN LAYOUT ===== */}
      <div className="flex-1 flex overflow-hidden">
        {/* ===== LEFT SIDEBAR (카테고리) ===== */}
        <div className="w-80 flex flex-col overflow-hidden" style={{ borderRight: '3px solid var(--color-border)' }}>
          <div className="p-4" style={{ borderBottom: '2px solid var(--color-border)' }}>
            <p className="section-label">CATEGORIES ({memos.length})</p>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {Object.keys(categoryTree.children).length === 0 ? (
              <div className="p-4 text-center" style={{ border: '2px dashed var(--color-text-muted)' }}>
                <p style={{ color: 'var(--color-text-muted)' }} className="text-xs uppercase">No memos yet</p>
              </div>
            ) : (
              renderCategoryNode(categoryTree)
            )}
          </div>

          {usage && (
            <div className="p-3 text-xs" style={{ borderTop: '2px solid var(--color-border)', background: 'var(--color-bg-secondary)' }}>
              <div className="flex justify-between" style={{ color: 'var(--color-text-muted)' }}>
                <span>TOKENS: {usage.today_input_tokens + usage.today_output_tokens}</span>
                <span>${usage.today_cost_usd.toFixed(4)}</span>
              </div>
            </div>
          )}
        </div>

        {/* ===== MAIN CONTENT ===== */}
        <div className="flex-1 overflow-auto p-8" style={{ background: 'var(--color-bg-secondary)' }}>
          {/* ===== NEW MEMO ===== */}
          {tab === "input" && !selectedMemo && (
            <div>
              <div className="card">
                <div className="card-header">{t("input.title")}</div>
                <p className="mb-4 text-sm" style={{ color: 'var(--color-text-muted)' }}>{t("input.description")}</p>
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder={t("input.placeholder")}
                  className="input h-48 resize-none mb-4"
                  disabled={loading}
                />
                <div className="flex items-center gap-4">
                  <button onClick={handleInput} disabled={loading || !inputText.trim()} className="btn btn-primary">
                    {loading && <span className="loading-spinner mr-2" />}
                    {loading ? 'PROCESSING...' : 'SAVE'}
                  </button>
                  {(result || error) && (
                    <span className={`status ${error ? 'status-error' : 'status-success'}`}>
                      {error || result}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ===== SEARCH ===== */}
          {tab === "search" && !selectedMemo && (
            <div>
              <div className="card">
                <div className="card-header">{t("search.title")}</div>
                <p className="mb-4 text-sm" style={{ color: 'var(--color-text-muted)' }}>{t("search.description")}</p>
                <div className="flex gap-3 mb-4">
                  <input
                    type="text"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder={t("search.placeholder")}
                    className="input flex-1"
                    disabled={loading}
                  />
                  <button onClick={handleSearch} disabled={loading || !searchText.trim()} className="btn btn-primary">
                    {loading && <span className="loading-spinner mr-2" />}
                    GO
                  </button>
                </div>
                {result && (
                  <div className="code-block mt-4">
                    <div className="card-header">AI_RESPONSE</div>
                    <div className="mt-2">{renderMarkdown(result)}</div>
                  </div>
                )}
                {error && <p className="status status-error mt-4">{error}</p>}
              </div>
            </div>
          )}

          {/* ===== SETTINGS ===== */}
          {tab === "settings" && !selectedMemo && (
            <div className="space-y-6">
              <div className="card">
                <div className="card-header">API_KEY</div>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter Gemini API key..."
                  className="input mb-4"
                />
                <div className="code-block text-xs">
                  <p className="font-bold mb-2"># {t("settings.apiKeyGuide")}</p>
                  <ol className="list-decimal list-inside space-y-1" style={{ color: 'var(--color-text-secondary)' }}>
                    <li>$ open <a href="https://aistudio.google.com/apikey" target="_blank" style={{ color: 'var(--color-accent)' }}>aistudio.google.com/apikey</a></li>
                    <li>$ {t("settings.apiKeyStep2")}</li>
                    <li>$ {t("settings.apiKeyStep3")}</li>
                    <li>$ {t("settings.apiKeyStep4")}</li>
                  </ol>
                </div>
              </div>

              <div className="card">
                <div className="card-header">LANGUAGE</div>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className="input">
                  {languages.map((lang) => <option key={lang.code} value={lang.code}>{lang.name}</option>)}
                </select>
              </div>

              <button onClick={handleSaveSettings} className="btn btn-primary w-full">SAVE_SETTINGS</button>

              <div className="card">
                <div className="card-header">DATA_BACKUP</div>
                <div className="flex gap-3">
                  <button
                    onClick={async () => {
                      const json = await invoke<string>("export_db");
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(new Blob([json]));
                      a.download = `jolajoa_backup.json`;
                      a.click();
                    }}
                    className="btn btn-secondary flex-1"
                  >EXPORT</button>
                  <label className="flex-1">
                    <input
                      type="file"
                      accept=".json"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          await invoke("import_db", { jsonData: await file.text() });
                          loadMemos();
                        }
                        e.target.value = "";
                      }}
                    />
                    <div className="btn btn-secondary text-center cursor-pointer">IMPORT</div>
                  </label>
                </div>
              </div>

              <div className="card">
                <div className="card-header">DANGER_ZONE</div>
                <p className="text-sm mb-4" style={{ color: 'var(--color-text-muted)' }}>
                  ⚠️ 이 작업은 되돌릴 수 없습니다. 모든 메모가 영구적으로 삭제됩니다.
                </p>
                <button
                  onClick={deleteAllMemos}
                  className="btn btn-danger w-full"
                >
                  DELETE_ALL_MEMOS ({memos.length})
                </button>
              </div>

              {(result || error) && (
                <p className={`status ${error ? 'status-error' : 'status-success'}`}>{error || result}</p>
              )}
            </div>
          )}

          {/* ===== MEMO VIEW & EDIT (실시간 저장) ===== */}
          {selectedMemo && (
            <div className="space-y-6">
              {/* 헤더: 닫기 & 삭제 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="tag" style={{ background: 'var(--color-accent)', color: '#ffffff' }}>{editCategory}</span>
                  {saving && <span className="status status-warning">SAVING...</span>}
                </div>
                <div className="flex gap-2">
                  <button onClick={deleteMemo} className="btn btn-danger">DELETE</button>
                  <button onClick={() => setSelectedMemo(null)} className="btn btn-secondary">X</button>
                </div>
              </div>

              {/* 제목 (인라인 편집) */}
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full text-2xl font-bold uppercase bg-transparent border-b-2 focus:outline-none py-2"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                placeholder="TITLE..."
              />

              {/* 카테고리 & 태그 (인라인 편집) */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="section-label block mb-1">CATEGORY</label>
                  <div className="flex gap-2">
                    <select
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value)}
                      className="input flex-1"
                    >
                      {allCategories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                    <input
                      type="text"
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value)}
                      className="input flex-1"
                      placeholder="New..."
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <label className="section-label block mb-1">TAGS</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    className="input"
                    placeholder="tag1, tag2, tag3"
                  />
                </div>
              </div>

              {/* 내용 (인라인 편집) */}
              <div className="card">
                <div className="card-header">CONTENT</div>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="input h-64 resize-none"
                  placeholder="Write your memo here..."
                />
              </div>

              {/* 미리보기 */}
              {editContent && (
                <div className="card">
                  <div className="card-header">PREVIEW</div>
                  <div className="mt-2">{renderMarkdown(editContent)}</div>
                </div>
              )}

              {/* 메타 정보 */}
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                CREATED: {selectedMemo.created_at} | UPDATED: {selectedMemo.updated_at}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
