import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [lastUsage, setLastUsage] = useState<{
    input: number;
    output: number;
    cost: number;
  } | null>(null);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [selectedMemo, setSelectedMemo] = useState<Memo | null>(null);

  useEffect(() => {
    loadSettings();
    loadUsage();
    loadMemos();
  }, []);

  const loadSettings = async () => {
    try {
      const key = await invoke<string>("get_setting", {
        key: "gemini_api_key",
      });
      const lang = await invoke<string>("get_setting", { key: "language" });
      setApiKey(key);
      if (lang) {
        setLanguage(lang);
        i18n.changeLanguage(lang);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const loadUsage = async () => {
    try {
      const stats = await invoke<UsageStats>("get_usage");
      setUsage(stats);
    } catch (e) {
      console.error(e);
    }
  };

  const loadMemos = async () => {
    try {
      const list = await invoke<Memo[]>("get_memos");
      setMemos(list);
    } catch (e) {
      console.error(e);
    }
  };

  const handleInput = async () => {
    if (!inputText.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await invoke<InputResult>("input_memo", {
        content: inputText,
      });
      setResult(res.message);
      setLastUsage({
        input: res.input_tokens,
        output: res.output_tokens,
        cost: res.cost_usd,
      });
      setInputText("");
      loadUsage();
      loadMemos();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchText.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await invoke<SearchResult>("search_memo", {
        question: searchText,
      });
      setResult(res.answer);
      setLastUsage({
        input: res.input_tokens,
        output: res.output_tokens,
        cost: res.cost_usd,
      });
      loadUsage();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    try {
      await invoke("save_setting", { key: "gemini_api_key", value: apiKey });
      await invoke("save_setting", { key: "language", value: language });
      i18n.changeLanguage(language);
      setResult(t("settings.saved"));
      setTimeout(() => setResult(null), 2000);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="h-screen flex bg-black text-white">
      {/* Sidebar - Memo List */}
      <div className="w-72 border-r border-white/20 flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b border-white/20">
          <h1 className="text-xl font-bold tracking-tight">JOLAJOA_MEMO</h1>
          {usage && (
            <div className="text-xs text-white/50 mt-1 font-mono">
              [{usage.today_input_tokens + usage.today_output_tokens} TOKENS / $
              {usage.today_cost_usd.toFixed(4)}]
            </div>
          )}
        </div>

        {/* Memo List */}
        <div className="flex-1 overflow-y-auto">
          {memos.length === 0 ? (
            <div className="p-4 text-white/30 text-sm">NO_MEMOS_YET</div>
          ) : (
            memos.map((memo) => (
              <div
                key={memo.id}
                onClick={() => setSelectedMemo(memo)}
                className={`p-3 border-b border-white/10 cursor-pointer hover:bg-white/5 transition ${
                  selectedMemo?.id === memo.id ? "bg-white text-black" : ""
                }`}
              >
                <div className="font-bold text-sm truncate">{memo.title}</div>
                <div
                  className={`text-xs mt-1 truncate ${selectedMemo?.id === memo.id ? "text-black/60" : "text-white/40"}`}
                >
                  {memo.summary || memo.formatted_content.slice(0, 50)}
                </div>
                <div
                  className={`text-xs mt-1 ${selectedMemo?.id === memo.id ? "text-black/40" : "text-white/20"}`}
                >
                  [{memo.category}]{" "}
                  {memo.tags && `#${memo.tags.split(", ").join(" #")}`}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Tab Bar */}
        <div className="flex border-b border-white/20">
          <button
            onClick={() => {
              setTab("input");
              setResult(null);
              setError(null);
              setSelectedMemo(null);
            }}
            className={`px-6 py-3 text-sm font-bold tracking-wide border-r border-white/20 transition ${
              tab === "input" ? "bg-white text-black" : "hover:bg-white/5"
            }`}
          >
            [INPUT]
          </button>
          <button
            onClick={() => {
              setTab("search");
              setResult(null);
              setError(null);
              setSelectedMemo(null);
            }}
            className={`px-6 py-3 text-sm font-bold tracking-wide border-r border-white/20 transition ${
              tab === "search" ? "bg-white text-black" : "hover:bg-white/5"
            }`}
          >
            [SEARCH]
          </button>
          <button
            onClick={() => {
              setTab("settings");
              setResult(null);
              setError(null);
              setSelectedMemo(null);
            }}
            className={`px-6 py-3 text-sm font-bold tracking-wide border-r border-white/20 transition ${
              tab === "settings" ? "bg-white text-black" : "hover:bg-white/5"
            }`}
          >
            [CONFIG]
          </button>
          <div className="flex-1" />
          {lastUsage && (
            <div className="px-4 py-3 text-xs text-white/40 font-mono">
              IN:{lastUsage.input} OUT:{lastUsage.output} $
              {lastUsage.cost.toFixed(6)}
            </div>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 flex">
          {/* Main Panel */}
          <div className="flex-1 p-6 flex flex-col">
            {tab === "input" && !selectedMemo && (
              <>
                <div className="text-xs text-white/40 mb-2 font-mono">
                  &gt; PASTE_ANYTHING_HERE
                </div>
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder={t("input.placeholder")}
                  className="flex-1 w-full bg-transparent border border-white/20 text-white placeholder-white/20 p-4 resize-none focus:outline-none focus:border-white font-mono text-sm"
                  disabled={loading}
                />
                <button
                  onClick={handleInput}
                  disabled={loading || !inputText.trim()}
                  className="mt-4 w-full bg-white text-black font-bold py-3 hover:bg-white/90 transition disabled:opacity-30 disabled:cursor-not-allowed tracking-wide"
                >
                  {loading ? "[ANALYZING...]" : "[SAVE]"}
                </button>
                {(result || error) && (
                  <div
                    className={`mt-4 p-3 border text-sm font-mono ${error ? "border-red-500 text-red-500" : "border-white/40 text-white/80"}`}
                  >
                    {error || result}
                  </div>
                )}
              </>
            )}

            {tab === "search" && !selectedMemo && (
              <>
                <div className="text-xs text-white/40 mb-2 font-mono">
                  &gt; ASK_ANYTHING
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder={t("search.placeholder")}
                    className="flex-1 bg-transparent border border-white/20 text-white placeholder-white/20 px-4 py-3 focus:outline-none focus:border-white font-mono text-sm"
                    disabled={loading}
                  />
                  <button
                    onClick={handleSearch}
                    disabled={loading || !searchText.trim()}
                    className="bg-white text-black font-bold px-6 hover:bg-white/90 transition disabled:opacity-30 disabled:cursor-not-allowed tracking-wide"
                  >
                    {loading ? "[...]" : "[GO]"}
                  </button>
                </div>

                {result && (
                  <div className="mt-4 flex-1 border border-white/20 p-4 text-sm font-mono overflow-auto whitespace-pre-wrap">
                    {result}
                  </div>
                )}
                {error && (
                  <div className="mt-4 p-3 border border-red-500 text-red-500 text-sm font-mono">
                    {error}
                  </div>
                )}
              </>
            )}

            {tab === "settings" && !selectedMemo && (
              <div className="max-w-md">
                <div className="text-xs text-white/40 mb-4 font-mono">
                  &gt; CONFIGURATION
                </div>

                <div className="mb-6">
                  <label className="block text-xs text-white/60 mb-2 font-mono">
                    GEMINI_API_KEY
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter API key..."
                    className="w-full bg-transparent border border-white/20 text-white placeholder-white/20 px-4 py-3 focus:outline-none focus:border-white font-mono text-sm"
                  />
                </div>

                <div className="mb-6">
                  <label className="block text-xs text-white/60 mb-2 font-mono">
                    LANGUAGE
                  </label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full bg-black border border-white/20 text-white px-4 py-3 focus:outline-none focus:border-white font-mono text-sm"
                  >
                    {languages.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.name}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={handleSaveSettings}
                  className="w-full bg-white text-black font-bold py-3 hover:bg-white/90 transition tracking-wide"
                >
                  [SAVE_CONFIG]
                </button>

                {/* DB Export/Import */}
                <div className="mt-8 pt-6 border-t border-white/20">
                  <div className="text-xs text-white/40 mb-4 font-mono">
                    &gt; DATA_BACKUP
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        try {
                          const json = await invoke<string>("export_db");
                          const blob = new Blob([json], {
                            type: "application/json",
                          });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `jolajoa_backup_${new Date().toISOString().split("T")[0]}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                          setResult("DB exported successfully!");
                        } catch (e) {
                          setError(String(e));
                        }
                      }}
                      className="flex-1 border border-white/20 text-white font-bold py-3 hover:bg-white hover:text-black transition tracking-wide"
                    >
                      [EXPORT]
                    </button>

                    <label className="flex-1">
                      <input
                        type="file"
                        accept=".json"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          try {
                            const text = await file.text();
                            const count = await invoke<number>("import_db", {
                              jsonData: text,
                            });
                            setResult(`${count} memos imported!`);
                            loadMemos();
                          } catch (err) {
                            setError(String(err));
                          }
                          e.target.value = "";
                        }}
                      />
                      <div className="border border-white/20 text-white font-bold py-3 hover:bg-white hover:text-black transition tracking-wide text-center cursor-pointer">
                        [IMPORT]
                      </div>
                    </label>
                  </div>
                </div>

                {result && (
                  <div className="mt-4 p-3 border border-white/40 text-white/80 text-sm font-mono">
                    {result}
                  </div>
                )}
                {error && (
                  <div className="mt-4 p-3 border border-red-500 text-red-500 text-sm font-mono">
                    {error}
                  </div>
                )}
              </div>
            )}

            {/* Selected Memo Detail */}
            {selectedMemo && (
              <div className="flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="text-xs text-white/40 font-mono">
                      &gt; MEMO_DETAIL
                    </div>
                    <h2 className="text-xl font-bold mt-1">
                      {selectedMemo.title}
                    </h2>
                  </div>
                  <button
                    onClick={() => setSelectedMemo(null)}
                    className="px-4 py-2 border border-white/20 text-sm font-mono hover:bg-white hover:text-black transition"
                  >
                    [CLOSE]
                  </button>
                </div>

                <div className="text-xs text-white/40 font-mono mb-2">
                  [{selectedMemo.category}]{" "}
                  {selectedMemo.tags &&
                    `#${selectedMemo.tags.split(", ").join(" #")}`}
                </div>

                <div className="flex-1 border border-white/20 p-4 overflow-auto">
                  <div className="text-xs text-white/40 font-mono mb-2">
                    // FORMATTED_CONTENT
                  </div>
                  <div className="whitespace-pre-wrap font-mono text-sm">
                    {selectedMemo.formatted_content}
                  </div>
                </div>

                <div className="mt-4 p-3 border border-white/10 text-xs text-white/30 font-mono">
                  CREATED: {selectedMemo.created_at} | UPDATED:{" "}
                  {selectedMemo.updated_at}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
