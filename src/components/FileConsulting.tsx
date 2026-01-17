import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface FileInfo {
  path: string;
  name: string;
  size: number;
  file_type: string;
  extension: string;
  modified: string;
}

interface TypeStats {
  count: number;
  total_size: number;
  percentage: number;
}

interface DuplicateGroup {
  size: number;
  files: string[];
}

interface FolderAnalysis {
  path: string;
  name: string;
  total_size: number;
  file_count: number;
  folder_count: number;
}

interface FileConsultingResult {
  total_scanned: number;
  total_size: number;
  total_folders: number;
  recommendations: string[];
  duplicates: DuplicateGroup[];
  large_files: FileInfo[];
  old_files: FileInfo[];
  type_summary: Record<string, TypeStats>;
  folders: FolderAnalysis[];
  videos: FileInfo[];
}

interface TreeNode {
  name: string;
  path: string;
  is_folder: boolean;
  children: TreeNode[];
  file_count: number;
  size: number;
  status: string; // "scanning", "complete"
}

interface FolderRenameSuggestion {
  original_path: string;
  original_name: string;
  suggested_name: string;
  reason: string;
  selected: boolean;
}

interface ScanProgress {
  message: string;
  current_file: string | null;
  file_count: number;
  folder_count: number;
  total_size: number;
  recent_files: string[];
  phase: string;
  folder_tree: TreeNode[];
  current_path: string | null;
}

function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;

  if (bytes >= TB) {
    return `${(bytes / TB).toFixed(2)} TB`;
  } else if (bytes >= GB) {
    return `${(bytes / GB).toFixed(2)} GB`;
  } else if (bytes >= MB) {
    return `${(bytes / MB).toFixed(2)} MB`;
  } else if (bytes >= KB) {
    return `${(bytes / KB).toFixed(2)} KB`;
  } else {
    return `${bytes} B`;
  }
}

// 트리 뷰 컴포넌트
function TreeView({ nodes, currentPath, depth }: { nodes: TreeNode[], currentPath: string | null, depth: number }) {
  const colors = ["#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e"];
  const getColor = (d: number) => colors[d % colors.length];

  return (
    <div style={{ paddingLeft: depth > 0 ? "16px" : "0" }}>
      {nodes.map((node) => {
        const isCurrentlyScanning = currentPath?.startsWith(node.path);
        const hasSize = node.size > 0;

        return (
          <div key={node.path} style={{ marginBottom: "4px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 8px",
                borderRadius: "6px",
                background: isCurrentlyScanning ? "rgba(99, 102, 241, 0.2)" : "transparent",
                borderLeft: `3px solid ${getColor(depth)}`,
                animation: isCurrentlyScanning ? "fadeIn 0.3s ease-out" : "none",
                transition: "all 0.3s ease"
              }}
            >
              {/* 폴더 아이콘 */}
              <span style={{
                fontSize: "14px",
                animation: isCurrentlyScanning ? "pulse 1s infinite" : "none"
              }}>
                {node.status === "scanning" ? "📂" : "✅"}
              </span>

              {/* 폴더 이름 */}
              <span style={{
                color: isCurrentlyScanning ? "#a5b4fc" : "#e2e8f0",
                fontWeight: isCurrentlyScanning ? 600 : 400,
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }}>
                {node.name}
              </span>

              {/* 통계 */}
              {hasSize && (
                <span style={{
                  fontSize: "10px",
                  color: "#64748b",
                  background: "rgba(0,0,0,0.3)",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  whiteSpace: "nowrap"
                }}>
                  {node.file_count}개 · {formatSize(node.size)}
                </span>
              )}

              {/* 스캔 중 표시 */}
              {isCurrentlyScanning && (
                <span style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "#22c55e",
                  animation: "blink 0.5s infinite"
                }} />
              )}
            </div>

            {/* 자식 폴더 */}
            {node.children.length > 0 && (
              <TreeView nodes={node.children} currentPath={currentPath} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function FileConsulting() {
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<FileConsultingResult | null>(null);
  const [aiConsulting, setAiConsulting] = useState<string>("");
  const [isGettingAiConsulting, setIsGettingAiConsulting] = useState(false);
  const [activeTab, setActiveTab] = useState<"summary" | "folders" | "large" | "old" | "duplicates" | "media" | "rename">("summary");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{path: string, name: string} | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  // 폴더명 변경 제안
  const [renameSuggestions, setRenameSuggestions] = useState<FolderRenameSuggestion[]>([]);
  const [isGettingRenameSuggestions, setIsGettingRenameSuggestions] = useState(false);
  const [renameExecuting, setRenameExecuting] = useState(false);

  // 스캔 취소
  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => {
    const unlisten = listen<ScanProgress>("consulting-progress", (event) => {
      setProgress(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const cancelScan = async () => {
    try {
      setIsCancelling(true);
      await invoke("cancel_scan");
    } catch (error) {
      console.error("스캔 취소 오류:", error);
    }
  };

  const selectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "분석할 폴더 선택",
      });

      if (selected && typeof selected === "string") {
        setSelectedPath(selected);
        // 폴더 선택 시 바로 스캔 시작
        startScanWithPath(selected);
      }
    } catch (error) {
      console.error("폴더 선택 오류:", error);
    }
  };

  const startScanWithPath = async (path: string) => {
    setIsScanning(true);
    setIsCancelling(false);
    setProgress({
      message: "스캔 준비 중...",
      current_file: null,
      file_count: 0,
      folder_count: 0,
      total_size: 0,
      recent_files: [],
      phase: "scanning",
      folder_tree: [],
      current_path: null
    });
    setResult(null);
    setAiConsulting("");
    setSelectedFiles(new Set());

    try {
      const scanResult = await invoke<FileConsultingResult>("scan_for_consulting", {
        path: path,
      });
      setResult(scanResult);
    } catch (error) {
      alert(`스캔 오류: ${error}`);
    } finally {
      setIsScanning(false);
      setIsCancelling(false);
      setProgress(null);
    }
  };

  const startScan = async () => {
    if (!selectedPath) {
      alert("폴더를 먼저 선택해주세요");
      return;
    }

    setIsScanning(true);
    setIsCancelling(false);
    setProgress({
      message: "스캔 준비 중...",
      current_file: null,
      file_count: 0,
      folder_count: 0,
      total_size: 0,
      recent_files: [],
      phase: "scanning",
      folder_tree: [],
      current_path: null
    });
    setResult(null);
    setAiConsulting("");
    setSelectedFiles(new Set());

    try {
      const scanResult = await invoke<FileConsultingResult>("scan_for_consulting", {
        path: selectedPath,
      });
      setResult(scanResult);
    } catch (error) {
      alert(`스캔 오류: ${error}`);
    } finally {
      setIsScanning(false);
      setIsCancelling(false);
      setProgress(null);
    }
  };

  // AI 분석 가능 여부 (파일 10000개 이하, 100GB 이하)
  const canUseAiConsulting = result && result.total_scanned <= 10000 && result.total_size <= 100 * 1024 * 1024 * 1024;

  const getAiConsulting = async () => {
    if (!result) return;

    if (!canUseAiConsulting) {
      alert("파일이 너무 많거나 용량이 커서 AI 분석을 사용할 수 없습니다.\n(파일 10,000개 이하, 100GB 이하만 지원)");
      return;
    }

    setIsGettingAiConsulting(true);
    try {
      const consulting = await invoke<string>("get_ai_file_consulting", { result });
      setAiConsulting(consulting);
    } catch (error) {
      alert(`AI 컨설팅 오류: ${error}`);
    } finally {
      setIsGettingAiConsulting(false);
    }
  };

  const openFile = async (path: string) => {
    try {
      await invoke("open_file_path", { path });
    } catch (error) {
      alert(`파일 열기 오류: ${error}`);
    }
  };

  const openInFinder = async (path: string) => {
    try {
      await invoke("open_in_finder", { path });
    } catch (error) {
      alert(`Finder 열기 오류: ${error}`);
    }
  };

  const deleteFile = async (path: string, toTrash: boolean = true) => {
    try {
      const message = await invoke<string>("delete_file_or_folder", { path, toTrash });
      alert(message);
      // 결과에서 삭제된 파일 제거
      if (result) {
        setResult({
          ...result,
          large_files: result.large_files.filter(f => f.path !== path),
          old_files: result.old_files.filter(f => f.path !== path),
        });
      }
      setDeleteConfirm(null);
    } catch (error) {
      alert(`삭제 오류: ${error}`);
    }
  };

  const toggleFileSelection = (path: string) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const deleteSelectedFiles = async () => {
    if (selectedFiles.size === 0) return;

    if (!confirm(`${selectedFiles.size}개 파일을 휴지통으로 이동하시겠습니까?`)) return;

    let successCount = 0;
    const pathsToDelete = new Set(selectedFiles);
    for (const path of pathsToDelete) {
      try {
        await invoke<string>("delete_file_or_folder", { path, toTrash: true });
        successCount++;
      } catch (error) {
        console.error(`삭제 실패: ${path}`, error);
      }
    }

    alert(`${successCount}개 파일 삭제 완료`);
    setSelectedFiles(new Set());

    // 결과 새로고침
    if (result) {
      setResult({
        ...result,
        large_files: result.large_files.filter(f => !pathsToDelete.has(f.path)),
        old_files: result.old_files.filter(f => !pathsToDelete.has(f.path)),
        videos: result.videos.filter(f => !pathsToDelete.has(f.path)),
      });
    }
  };

  const selectAllFiles = (files: FileInfo[]) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      files.forEach(f => newSet.add(f.path));
      return newSet;
    });
  };

  const deselectAllFiles = (files: FileInfo[]) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      files.forEach(f => newSet.delete(f.path));
      return newSet;
    });
  };

  const isAllSelected = (files: FileInfo[]) => {
    return files.length > 0 && files.every(f => selectedFiles.has(f.path));
  };

  const getSelectedSize = () => {
    if (!result) return 0;
    const allFiles = [...result.large_files, ...result.old_files, ...result.videos];
    return allFiles.filter(f => selectedFiles.has(f.path)).reduce((sum, f) => sum + f.size, 0);
  };

  const downloadChartAsImage = async () => {
    if (!chartRef.current) return;

    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(chartRef.current, {
        backgroundColor: "#0f172a",
        scale: 2,
      });

      const link = document.createElement("a");
      link.download = `file-analysis-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch (error) {
      console.error("차트 이미지 다운로드 오류:", error);
      alert("이미지 다운로드에 실패했습니다.");
    }
  };

  // 폴더명 변경 제안 받기
  const getRenameSuggestions = async () => {
    if (!selectedPath || !result) return;

    setIsGettingRenameSuggestions(true);
    try {
      // 스캔된 폴더들의 경로 목록 수집 (최대 50개)
      const folderPaths = progress?.folder_tree
        ? collectFolderPaths(progress.folder_tree).slice(0, 50)
        : [];

      if (folderPaths.length === 0) {
        alert("분석할 폴더가 없습니다.");
        return;
      }

      const suggestions = await invoke<FolderRenameSuggestion[]>("get_folder_rename_suggestions", {
        folderNames: folderPaths
      });

      setRenameSuggestions(suggestions.map(s => ({ ...s, selected: true })));
      setActiveTab("rename");
    } catch (error) {
      console.error("폴더명 제안 오류:", error);
      alert(`폴더명 제안 가져오기 실패: ${error}`);
    } finally {
      setIsGettingRenameSuggestions(false);
    }
  };

  // 트리에서 모든 폴더 경로 수집
  const collectFolderPaths = (nodes: TreeNode[]): string[] => {
    let paths: string[] = [];
    for (const node of nodes) {
      if (node.is_folder) {
        paths.push(node.path);
        if (node.children) {
          paths = paths.concat(collectFolderPaths(node.children));
        }
      }
    }
    return paths;
  };

  // 폴더명 변경 실행
  const executeRename = async () => {
    const selectedSuggestions = renameSuggestions.filter(s => s.selected);
    if (selectedSuggestions.length === 0) {
      alert("변경할 폴더를 선택해주세요.");
      return;
    }

    setRenameExecuting(true);
    let successCount = 0;
    let failCount = 0;

    for (const suggestion of selectedSuggestions) {
      try {
        await invoke("rename_folder", {
          oldPath: suggestion.original_path,
          newName: suggestion.suggested_name
        });
        successCount++;
      } catch (error) {
        console.error(`폴더명 변경 실패: ${suggestion.original_name}`, error);
        failCount++;
      }
    }

    setRenameExecuting(false);
    alert(`폴더명 변경 완료: 성공 ${successCount}개, 실패 ${failCount}개`);

    // 성공한 항목 제거
    setRenameSuggestions(prev =>
      prev.filter(s => !selectedSuggestions.find(sel => sel.original_path === s.original_path))
    );
  };

  // 제안 선택 토글
  const toggleSuggestionSelection = (path: string) => {
    setRenameSuggestions(prev =>
      prev.map(s => s.original_path === path ? { ...s, selected: !s.selected } : s)
    );
  };

  // 모든 제안 선택/해제
  const toggleAllSuggestions = (selected: boolean) => {
    setRenameSuggestions(prev => prev.map(s => ({ ...s, selected })));
  };

  // Calculate chart data
  const chartData = result
    ? Object.entries(result.type_summary)
        .sort((a, b) => b[1].total_size - a[1].total_size)
        .map(([type, stats], index) => ({
          type,
          size: stats.total_size,
          count: stats.count,
          percentage: stats.percentage,
          color: [
            "#FF6384",
            "#36A2EB",
            "#FFCE56",
            "#4BC0C0",
            "#9966FF",
            "#FF9F40",
            "#C9CBCF",
            "#7BC043",
          ][index % 8],
        }))
    : [];

  // Calculate folder data sorted by size
  const folderData = result?.folders
    ? [...result.folders]
        .sort((a, b) => b.total_size - a.total_size)
        .slice(0, 15)
        .map((folder, index) => ({
          ...folder,
          percentage: result.total_size > 0 ? (folder.total_size / result.total_size) * 100 : 0,
          color: [
            "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
            "#22c55e", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6",
            "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899"
          ][index % 15],
        }))
    : [];

  return (
    <div style={{ padding: "20px", maxWidth: "1200px", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: "20px" }}>
        <h2 style={{ margin: 0, color: "#fff" }}>🗂️ 파일 컨설팅</h2>
      </div>

      {/* 폴더 선택 */}
      <div
        style={{
          background: "var(--bg-secondary)",
          padding: "20px",
          borderRadius: "12px",
          marginBottom: "20px",
          border: "1px solid var(--border)"
        }}
      >
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            onClick={selectFolder}
            disabled={isScanning}
            style={{
              padding: "12px 24px",
              background: isScanning ? "var(--bg-tertiary)" : "linear-gradient(135deg, #4a4af0 0%, #6366f1 100%)",
              border: "none",
              borderRadius: "8px",
              color: isScanning ? "var(--text-secondary)" : "white",
              cursor: isScanning ? "not-allowed" : "pointer",
              fontWeight: "bold",
            }}
          >
            {isScanning ? "스캔 중..." : "📁 폴더 선택 및 분석"}
          </button>
          <span style={{ color: "var(--text-secondary)", flex: 1, fontSize: "13px" }}>
            {selectedPath || "폴더를 선택하면 자동으로 분석이 시작됩니다"}
          </span>
          {result && !isScanning && (
            <button
              onClick={startScan}
              style={{
                padding: "10px 16px",
                background: "rgba(99, 102, 241, 0.2)",
                border: "1px solid rgba(99, 102, 241, 0.3)",
                borderRadius: "8px",
                color: "#a5b4fc",
                cursor: "pointer",
                fontSize: "13px"
              }}
            >
              🔄 다시 스캔
            </button>
          )}
        </div>
      </div>

      {/* 스캔 중 애니메이션 - 트리 구조 */}
      {isScanning && progress && (
        <div
          style={{
            background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
            padding: "24px",
            borderRadius: "16px",
            marginBottom: "20px",
            border: "1px solid rgba(99, 102, 241, 0.3)",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* 배경 애니메이션 */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "linear-gradient(90deg, transparent, rgba(99, 102, 241, 0.1), transparent)",
              animation: "scanLine 2s linear infinite",
            }}
          />

          {/* 헤더 */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px", position: "relative", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  animation: "pulse 1.5s ease-in-out infinite",
                }}
              >
                <span style={{ fontSize: "20px" }}>🔍</span>
              </div>
              <div>
                <div style={{ color: "#fff", fontWeight: 700, fontSize: "16px" }}>
                  {isCancelling ? "스캔 중단 중..." : "파일 시스템 스캔 중"}
                </div>
                <div style={{ color: "#94a3b8", fontSize: "12px" }}>{progress.message}</div>
              </div>
            </div>
            <button
              onClick={cancelScan}
              disabled={isCancelling}
              style={{
                padding: "10px 20px",
                background: isCancelling ? "rgba(239, 68, 68, 0.3)" : "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
                color: "#fff",
                border: "none",
                borderRadius: "8px",
                cursor: isCancelling ? "not-allowed" : "pointer",
                fontWeight: 600,
                fontSize: "14px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                opacity: isCancelling ? 0.7 : 1,
                transition: "all 0.2s ease",
              }}
            >
              <span>{isCancelling ? "⏳" : "⏹"}</span>
              {isCancelling ? "중단 중..." : "스캔 중지"}
            </button>
          </div>

          {/* 실시간 통계 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "16px",
              marginBottom: "20px",
              position: "relative",
            }}
          >
            <div
              style={{
                background: "rgba(59, 130, 246, 0.1)",
                padding: "16px",
                borderRadius: "12px",
                textAlign: "center",
                border: "1px solid rgba(59, 130, 246, 0.2)",
              }}
            >
              <div style={{ fontSize: "28px", fontWeight: 700, color: "#3b82f6", fontFamily: "monospace" }}>
                {progress.file_count.toLocaleString()}
              </div>
              <div style={{ color: "#94a3b8", fontSize: "11px", marginTop: "4px" }}>파일 발견</div>
            </div>
            <div
              style={{
                background: "rgba(16, 185, 129, 0.1)",
                padding: "16px",
                borderRadius: "12px",
                textAlign: "center",
                border: "1px solid rgba(16, 185, 129, 0.2)",
              }}
            >
              <div style={{ fontSize: "28px", fontWeight: 700, color: "#10b981", fontFamily: "monospace" }}>
                {formatSize(progress.total_size)}
              </div>
              <div style={{ color: "#94a3b8", fontSize: "11px", marginTop: "4px" }}>총 용량</div>
            </div>
            <div
              style={{
                background: "rgba(245, 158, 11, 0.1)",
                padding: "16px",
                borderRadius: "12px",
                textAlign: "center",
                border: "1px solid rgba(245, 158, 11, 0.2)",
              }}
            >
              <div style={{ fontSize: "28px", fontWeight: 700, color: "#f59e0b", fontFamily: "monospace" }}>
                {progress.folder_count.toLocaleString()}
              </div>
              <div style={{ color: "#94a3b8", fontSize: "11px", marginTop: "4px" }}>폴더 탐색</div>
            </div>
          </div>

          {/* 트리 구조 시각화 */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
            position: "relative"
          }}>
            {/* 폴더 트리 */}
            <div>
              <div style={{ color: "#64748b", fontSize: "11px", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "1px" }}>
                📂 폴더 구조
              </div>
              <div
                style={{
                  background: "rgba(0, 0, 0, 0.3)",
                  borderRadius: "8px",
                  padding: "12px",
                  fontFamily: "monospace",
                  fontSize: "12px",
                  maxHeight: "250px",
                  overflow: "auto",
                }}
              >
                {progress.folder_tree.length > 0 ? (
                  <TreeView nodes={progress.folder_tree} currentPath={progress.current_path} depth={0} />
                ) : (
                  <div style={{ color: "#64748b", textAlign: "center", padding: "20px" }}>
                    <div style={{ fontSize: "24px", marginBottom: "8px" }}>🔄</div>
                    폴더 탐색 중...
                  </div>
                )}
              </div>
            </div>

            {/* 최근 스캔된 파일 목록 */}
            <div>
              <div style={{ color: "#64748b", fontSize: "11px", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "1px" }}>
                📄 최근 발견 파일
              </div>
              <div
                style={{
                  background: "rgba(0, 0, 0, 0.3)",
                  borderRadius: "8px",
                  padding: "12px",
                  fontFamily: "monospace",
                  fontSize: "11px",
                  maxHeight: "250px",
                  overflow: "hidden",
                }}
              >
                {progress.recent_files.length > 0 ? (
                  progress.recent_files.map((file, idx) => (
                    <div
                      key={idx}
                      style={{
                        color: idx === progress.recent_files.length - 1 ? "#22c55e" : "#94a3b8",
                        padding: "6px 0",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        animation: idx === progress.recent_files.length - 1 ? "fadeIn 0.3s ease-out" : "none",
                        borderBottom: "1px solid rgba(255,255,255,0.05)"
                      }}
                    >
                      <span style={{ color: idx === progress.recent_files.length - 1 ? "#22c55e" : "#6366f1" }}>{"📄"}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file}</span>
                      {idx === progress.recent_files.length - 1 && (
                        <span
                          style={{
                            display: "inline-block",
                            width: "6px",
                            height: "6px",
                            borderRadius: "50%",
                            background: "#22c55e",
                            animation: "blink 1s infinite",
                            marginLeft: "auto",
                            flexShrink: 0
                          }}
                        />
                      )}
                    </div>
                  ))
                ) : (
                  <div style={{ color: "#64748b", textAlign: "center", padding: "20px" }}>스캔 준비 중...</div>
                )}
              </div>
            </div>
          </div>

          {/* 프로그레스 바 */}
          <div style={{ marginTop: "16px" }}>
            <div
              style={{
                height: "4px",
                background: "rgba(99, 102, 241, 0.2)",
                borderRadius: "2px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  background: "linear-gradient(90deg, #6366f1, #8b5cf6, #6366f1)",
                  backgroundSize: "200% 100%",
                  animation: "progressWave 1.5s linear infinite",
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 결과 */}
      {result && (
        <>
          {/* 프로페셔널 리포트 헤더 */}
          <div
            ref={chartRef}
            style={{
              background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
              padding: "30px",
              borderRadius: "20px",
              marginBottom: "20px",
              border: "1px solid rgba(99, 102, 241, 0.2)",
            }}
          >
            {/* 리포트 타이틀 */}
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "30px",
              paddingBottom: "20px",
              borderBottom: "1px solid rgba(255,255,255,0.1)"
            }}>
              <div>
                <h2 style={{ margin: 0, color: "#fff", fontSize: "24px", fontWeight: 700 }}>
                  📊 저장소 분석 리포트
                </h2>
                <p style={{ margin: "8px 0 0 0", color: "#64748b", fontSize: "13px" }}>
                  {new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })} 분석 완료
                </p>
              </div>
              <button
                onClick={downloadChartAsImage}
                style={{
                  padding: "10px 20px",
                  background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
                  border: "none",
                  borderRadius: "10px",
                  color: "white",
                  cursor: "pointer",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px"
                }}
              >
                📥 리포트 저장
              </button>
            </div>

            {/* 핵심 지표 카드 */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "16px",
              marginBottom: "30px"
            }}>
              <div style={{
                background: "linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(59, 130, 246, 0.05) 100%)",
                padding: "20px",
                borderRadius: "16px",
                border: "1px solid rgba(59, 130, 246, 0.3)"
              }}>
                <div style={{ color: "#64748b", fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>총 파일</div>
                <div style={{ fontSize: "32px", fontWeight: 700, color: "#3b82f6", fontFamily: "monospace" }}>
                  {result.total_scanned.toLocaleString()}
                </div>
                <div style={{ color: "#94a3b8", fontSize: "11px", marginTop: "4px" }}>개 발견</div>
              </div>
              <div style={{
                background: "linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(16, 185, 129, 0.05) 100%)",
                padding: "20px",
                borderRadius: "16px",
                border: "1px solid rgba(16, 185, 129, 0.3)"
              }}>
                <div style={{ color: "#64748b", fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>총 용량</div>
                <div style={{ fontSize: "32px", fontWeight: 700, color: "#10b981", fontFamily: "monospace" }}>
                  {formatSize(result.total_size)}
                </div>
                <div style={{ color: "#94a3b8", fontSize: "11px", marginTop: "4px" }}>사용 중</div>
              </div>
              <div style={{
                background: "linear-gradient(135deg, rgba(245, 158, 11, 0.2) 0%, rgba(245, 158, 11, 0.05) 100%)",
                padding: "20px",
                borderRadius: "16px",
                border: "1px solid rgba(245, 158, 11, 0.3)"
              }}>
                <div style={{ color: "#64748b", fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>폴더</div>
                <div style={{ fontSize: "32px", fontWeight: 700, color: "#f59e0b", fontFamily: "monospace" }}>
                  {result.total_folders.toLocaleString()}
                </div>
                <div style={{ color: "#94a3b8", fontSize: "11px", marginTop: "4px" }}>개 탐색</div>
              </div>
              <div style={{
                background: "linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(239, 68, 68, 0.05) 100%)",
                padding: "20px",
                borderRadius: "16px",
                border: "1px solid rgba(239, 68, 68, 0.3)"
              }}>
                <div style={{ color: "#64748b", fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>대용량 파일</div>
                <div style={{ fontSize: "32px", fontWeight: 700, color: "#ef4444", fontFamily: "monospace" }}>
                  {result.large_files.length}
                </div>
                <div style={{ color: "#94a3b8", fontSize: "11px", marginTop: "4px" }}>개 감지</div>
              </div>
            </div>

            {/* 파일 유형별 분포 - 도넛 차트 스타일 */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "280px 1fr",
              gap: "30px",
              marginBottom: "30px"
            }}>
              {/* 도넛 차트 시각화 */}
              <div style={{ position: "relative", width: "250px", height: "250px", margin: "0 auto" }}>
                <svg viewBox="0 0 100 100" style={{ transform: "rotate(-90deg)" }}>
                  {chartData.reduce((acc, item, idx) => {
                    const prevOffset = idx === 0 ? 0 : acc.offset;
                    const dashArray = (item.percentage * 2.827).toFixed(2);
                    const dashOffset = -(prevOffset * 2.827);
                    acc.elements.push(
                      <circle
                        key={item.type}
                        cx="50"
                        cy="50"
                        r="45"
                        fill="none"
                        stroke={item.color}
                        strokeWidth="10"
                        strokeDasharray={`${dashArray} 283`}
                        strokeDashoffset={dashOffset}
                        style={{ transition: "all 0.5s ease" }}
                      />
                    );
                    acc.offset = prevOffset + item.percentage;
                    return acc;
                  }, { elements: [] as React.ReactNode[], offset: 0 }).elements}
                </svg>
                <div style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  textAlign: "center"
                }}>
                  <div style={{ fontSize: "28px", fontWeight: 700, color: "#fff" }}>
                    {chartData.length}
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>파일 유형</div>
                </div>
              </div>

              {/* 유형별 상세 목록 */}
              <div>
                <h4 style={{ margin: "0 0 16px 0", color: "#fff", fontSize: "16px" }}>📁 파일 유형별 용량</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {chartData.map((item) => (
                    <div key={item.type} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <div style={{
                        width: "12px",
                        height: "12px",
                        borderRadius: "3px",
                        background: item.color,
                        flexShrink: 0
                      }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                          <span style={{ color: "#fff", fontSize: "13px", fontWeight: 500 }}>{item.type}</span>
                          <span style={{ color: "#94a3b8", fontSize: "13px" }}>
                            {formatSize(item.size)} ({item.percentage.toFixed(1)}%)
                          </span>
                        </div>
                        <div style={{
                          height: "6px",
                          background: "rgba(255,255,255,0.1)",
                          borderRadius: "3px",
                          overflow: "hidden"
                        }}>
                          <div style={{
                            width: `${item.percentage}%`,
                            height: "100%",
                            background: `linear-gradient(90deg, ${item.color}, ${item.color}88)`,
                            borderRadius: "3px",
                            transition: "width 0.5s ease"
                          }} />
                        </div>
                      </div>
                      <div style={{
                        background: "rgba(255,255,255,0.05)",
                        padding: "4px 10px",
                        borderRadius: "6px",
                        color: "#94a3b8",
                        fontSize: "12px",
                        fontFamily: "monospace"
                      }}>
                        {item.count.toLocaleString()}개
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 폴더별 용량 분석 */}
            {folderData.length > 0 && (
              <div style={{
                background: "rgba(0,0,0,0.2)",
                padding: "20px",
                borderRadius: "16px",
                marginBottom: "20px"
              }}>
                <h4 style={{ margin: "0 0 16px 0", color: "#fff", fontSize: "16px" }}>📂 폴더별 용량 TOP 15</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {folderData.map((folder, idx) => (
                    <div key={folder.path} style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "12px",
                      background: "rgba(255,255,255,0.03)",
                      borderRadius: "10px",
                      border: "1px solid rgba(255,255,255,0.05)"
                    }}>
                      <div style={{
                        width: "28px",
                        height: "28px",
                        borderRadius: "6px",
                        background: folder.color,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        fontWeight: 700,
                        fontSize: "12px"
                      }}>
                        {idx + 1}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          color: "#fff",
                          fontSize: "13px",
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap"
                        }}>
                          {folder.name}
                        </div>
                        <div style={{
                          color: "#64748b",
                          fontSize: "11px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap"
                        }}>
                          {folder.path}
                        </div>
                      </div>
                      <div style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px"
                      }}>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ color: folder.color, fontWeight: 700, fontSize: "14px" }}>
                            {folder.percentage.toFixed(1)}%
                          </div>
                          <div style={{ color: "#64748b", fontSize: "11px" }}>
                            {formatSize(folder.total_size)}
                          </div>
                        </div>
                        <button
                          onClick={() => openInFinder(folder.path)}
                          style={{
                            padding: "6px 10px",
                            background: "rgba(99, 102, 241, 0.2)",
                            border: "1px solid rgba(99, 102, 241, 0.3)",
                            borderRadius: "6px",
                            color: "#a5b4fc",
                            cursor: "pointer",
                            fontSize: "12px"
                          }}
                        >
                          📂
                        </button>
                        <button
                          onClick={() => setDeleteConfirm({ path: folder.path, name: folder.name })}
                          style={{
                            padding: "6px 10px",
                            background: "rgba(239, 68, 68, 0.2)",
                            border: "1px solid rgba(239, 68, 68, 0.3)",
                            borderRadius: "6px",
                            color: "#fca5a5",
                            cursor: "pointer",
                            fontSize: "12px"
                          }}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 저장 공간 인사이트 */}
            <div style={{
              background: "rgba(0,0,0,0.2)",
              padding: "20px",
              borderRadius: "16px"
            }}>
              <h4 style={{ margin: "0 0 16px 0", color: "#fff", fontSize: "16px" }}>📈 저장 공간 인사이트</h4>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
                <div style={{
                  background: "rgba(99, 102, 241, 0.1)",
                  padding: "16px",
                  borderRadius: "12px",
                  border: "1px solid rgba(99, 102, 241, 0.2)"
                }}>
                  <div style={{ color: "#64748b", fontSize: "11px", marginBottom: "8px" }}>평균 파일 크기</div>
                  <div style={{ color: "#6366f1", fontSize: "20px", fontWeight: 700 }}>
                    {formatSize(Math.round(result.total_size / (result.total_scanned || 1)))}
                  </div>
                </div>
                <div style={{
                  background: "rgba(236, 72, 153, 0.1)",
                  padding: "16px",
                  borderRadius: "12px",
                  border: "1px solid rgba(236, 72, 153, 0.2)"
                }}>
                  <div style={{ color: "#64748b", fontSize: "11px", marginBottom: "8px" }}>가장 큰 파일 유형</div>
                  <div style={{ color: "#ec4899", fontSize: "20px", fontWeight: 700 }}>
                    {chartData[0]?.type || "-"}
                  </div>
                </div>
                <div style={{
                  background: "rgba(20, 184, 166, 0.1)",
                  padding: "16px",
                  borderRadius: "12px",
                  border: "1px solid rgba(20, 184, 166, 0.2)"
                }}>
                  <div style={{ color: "#64748b", fontSize: "11px", marginBottom: "8px" }}>중복 의심</div>
                  <div style={{ color: "#14b8a6", fontSize: "20px", fontWeight: 700 }}>
                    {result.duplicates.length}그룹
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* AI 컨설팅 섹션 */}
          <div
            style={{
              background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)",
              padding: "24px",
              borderRadius: "16px",
              marginBottom: "20px",
              border: "1px solid rgba(139, 92, 246, 0.3)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
              <h3 style={{ margin: 0, color: "#fff", fontSize: "18px" }}>🤖 AI 컨설팅</h3>
              <button
                onClick={getAiConsulting}
                disabled={isGettingAiConsulting || !canUseAiConsulting}
                style={{
                  padding: "10px 20px",
                  background: !canUseAiConsulting ? "rgba(100, 100, 100, 0.3)" : isGettingAiConsulting ? "rgba(139, 92, 246, 0.3)" : "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)",
                  border: "none",
                  borderRadius: "10px",
                  color: !canUseAiConsulting ? "#666" : "white",
                  cursor: (isGettingAiConsulting || !canUseAiConsulting) ? "not-allowed" : "pointer",
                  fontWeight: 600,
                }}
              >
                {!canUseAiConsulting ? "⚠️ 데이터 과다" : isGettingAiConsulting ? "분석 중..." : aiConsulting ? "🔄 다시 분석" : "✨ AI 분석 시작"}
              </button>
            </div>

            {!aiConsulting && !isGettingAiConsulting && (
              <div style={{
                textAlign: "center",
                padding: "40px",
                color: "#94a3b8"
              }}>
                {!canUseAiConsulting ? (
                  <>
                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>⚠️</div>
                    <div style={{ color: "#f59e0b" }}>파일이 너무 많거나 용량이 커서 AI 분석을 사용할 수 없습니다</div>
                    <div style={{ fontSize: "12px", marginTop: "8px" }}>(파일 10,000개 이하, 100GB 이하만 지원)</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>🧠</div>
                    <div>AI가 저장소를 분석하여 정리 권장사항을 알려드립니다</div>
                  </>
                )}
              </div>
            )}

            {isGettingAiConsulting && (
              <div style={{
                textAlign: "center",
                padding: "40px",
                color: "#a78bfa"
              }}>
                <div style={{ fontSize: "48px", marginBottom: "16px", animation: "pulse 1.5s infinite" }}>🔮</div>
                <div>AI가 분석 중입니다...</div>
              </div>
            )}

            {aiConsulting && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                {/* 삭제 권장 항목 */}
                <div style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  padding: "20px",
                  borderRadius: "12px",
                  border: "1px solid rgba(239, 68, 68, 0.2)"
                }}>
                  <h4 style={{ margin: "0 0 16px 0", color: "#ef4444", fontSize: "14px" }}>
                    🗑️ 삭제 권장 ({result.large_files.length + result.old_files.length}개 항목)
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "200px", overflow: "auto" }}>
                    {result.large_files.slice(0, 5).map((file, idx) => (
                      <div key={idx} style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px 12px",
                        background: "rgba(0,0,0,0.2)",
                        borderRadius: "8px"
                      }}>
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.path)}
                          onChange={() => toggleFileSelection(file.path)}
                          style={{ accentColor: "#ef4444" }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: "#fff", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {file.name}
                          </div>
                          <div style={{ color: "#f87171", fontSize: "11px" }}>{formatSize(file.size)}</div>
                        </div>
                        <button
                          onClick={() => setDeleteConfirm({ path: file.path, name: file.name })}
                          style={{
                            padding: "4px 8px",
                            background: "#ef4444",
                            border: "none",
                            borderRadius: "4px",
                            color: "white",
                            cursor: "pointer",
                            fontSize: "11px"
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    ))}
                  </div>
                  {selectedFiles.size > 0 && (
                    <button
                      onClick={deleteSelectedFiles}
                      style={{
                        marginTop: "12px",
                        width: "100%",
                        padding: "10px",
                        background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
                        border: "none",
                        borderRadius: "8px",
                        color: "white",
                        cursor: "pointer",
                        fontWeight: 600
                      }}
                    >
                      선택한 {selectedFiles.size}개 항목 삭제
                    </button>
                  )}
                </div>

                {/* 최적화 권장 */}
                <div style={{
                  background: "rgba(34, 197, 94, 0.1)",
                  padding: "20px",
                  borderRadius: "12px",
                  border: "1px solid rgba(34, 197, 94, 0.2)"
                }}>
                  <h4 style={{ margin: "0 0 16px 0", color: "#22c55e", fontSize: "14px" }}>
                    ✨ 최적화 권장
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {result.recommendations.map((rec, idx) => (
                      <div key={idx} style={{
                        padding: "10px 12px",
                        background: "rgba(0,0,0,0.2)",
                        borderRadius: "8px",
                        color: "#86efac",
                        fontSize: "12px",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "8px"
                      }}>
                        <span style={{ color: "#22c55e" }}>✓</span>
                        <span>{rec}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 선택된 파일 삭제 바 */}
          {selectedFiles.size > 0 && (
            <div style={{
              position: "sticky",
              top: 0,
              zIndex: 100,
              background: "linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)",
              padding: "16px 20px",
              borderRadius: "12px",
              marginBottom: "20px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              boxShadow: "0 4px 20px rgba(220, 38, 38, 0.4)"
            }}>
              <div style={{ color: "#fff" }}>
                <strong>{selectedFiles.size}개</strong> 파일 선택됨 ({formatSize(getSelectedSize())})
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={() => setSelectedFiles(new Set())}
                  style={{
                    padding: "8px 16px",
                    background: "rgba(255,255,255,0.2)",
                    border: "none",
                    borderRadius: "6px",
                    color: "white",
                    cursor: "pointer"
                  }}
                >
                  선택 해제
                </button>
                <button
                  onClick={deleteSelectedFiles}
                  style={{
                    padding: "8px 20px",
                    background: "#fff",
                    border: "none",
                    borderRadius: "6px",
                    color: "#dc2626",
                    cursor: "pointer",
                    fontWeight: 700
                  }}
                >
                  🗑️ 선택 항목 삭제
                </button>
              </div>
            </div>
          )}

          {/* 상세 탭 */}
          <div
            style={{
              background: "var(--bg-secondary)",
              padding: "20px",
              borderRadius: "12px",
              border: "1px solid var(--border)"
            }}
          >
            <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
              {[
                { key: "large", label: `📁 대용량 (${result.large_files.length})`, color: "#ef4444" },
                { key: "old", label: `🕐 오래된 파일 (${result.old_files.length})`, color: "#f59e0b" },
                { key: "media", label: `🎬 동영상 (${result.videos.length})`, color: "#22c55e" },
                { key: "duplicates", label: `📋 중복 (${result.duplicates.length})`, color: "#8b5cf6" },
                { key: "rename", label: `✏️ 폴더명 변경 (${renameSuggestions.length})`, color: "#06b6d4" },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key as typeof activeTab)}
                  style={{
                    padding: "10px 20px",
                    background: activeTab === tab.key ? tab.color : "var(--bg-tertiary)",
                    border: "none",
                    borderRadius: "8px",
                    color: "white",
                    cursor: "pointer",
                    transition: "all 0.2s ease"
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* 대용량 파일 */}
            {activeTab === "large" && (
              <div>
                {result.large_files.length === 0 ? (
                  <p style={{ color: "#888", textAlign: "center", padding: "40px" }}>대용량 파일이 없습니다.</p>
                ) : (
                  <>
                    {/* 전체 선택 버튼 */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", padding: "12px", background: "rgba(239, 68, 68, 0.1)", borderRadius: "8px" }}>
                      <div style={{ color: "#fca5a5" }}>
                        총 {result.large_files.length}개 파일 ({formatSize(result.large_files.reduce((sum, f) => sum + f.size, 0))})
                      </div>
                      <button
                        onClick={() => isAllSelected(result.large_files) ? deselectAllFiles(result.large_files) : selectAllFiles(result.large_files)}
                        style={{
                          padding: "8px 16px",
                          background: isAllSelected(result.large_files) ? "#ef4444" : "rgba(239, 68, 68, 0.3)",
                          border: "none",
                          borderRadius: "6px",
                          color: "white",
                          cursor: "pointer",
                          fontWeight: 600
                        }}
                      >
                        {isAllSelected(result.large_files) ? "✓ 전체 선택됨" : "☐ 전체 선택"}
                      </button>
                    </div>
                    {result.large_files.map((file, index) => (
                      <div
                        key={index}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          padding: "14px 16px",
                          background: selectedFiles.has(file.path) ? "rgba(239, 68, 68, 0.15)" : "var(--bg-tertiary)",
                          borderRadius: "10px",
                          marginBottom: "8px",
                          border: selectedFiles.has(file.path) ? "1px solid rgba(239, 68, 68, 0.4)" : "1px solid rgba(239, 68, 68, 0.1)",
                          cursor: "pointer"
                        }}
                        onClick={() => toggleFileSelection(file.path)}
                      >
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.path)}
                          onChange={() => {}}
                          style={{ width: "18px", height: "18px", marginRight: "12px", accentColor: "#ef4444" }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: "#fff", fontWeight: "500", marginBottom: "4px" }}>{file.name}</div>
                          <div style={{ color: "#64748b", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {file.path}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }} onClick={e => e.stopPropagation()}>
                          <span style={{ color: "#ef4444", fontWeight: "bold", fontSize: "14px" }}>
                            {formatSize(file.size)}
                          </span>
                          <button onClick={() => openFile(file.path)} style={{ padding: "6px 10px", background: "rgba(59, 130, 246, 0.2)", border: "none", borderRadius: "6px", color: "#93c5fd", cursor: "pointer", fontSize: "11px" }}>👁️</button>
                          <button onClick={() => openInFinder(file.path)} style={{ padding: "6px 10px", background: "rgba(99, 102, 241, 0.2)", border: "none", borderRadius: "6px", color: "#a5b4fc", cursor: "pointer", fontSize: "11px" }}>📂</button>
                          <button onClick={() => setDeleteConfirm({ path: file.path, name: file.name })} style={{ padding: "6px 10px", background: "rgba(239, 68, 68, 0.3)", border: "none", borderRadius: "6px", color: "#fca5a5", cursor: "pointer", fontSize: "11px" }}>🗑️</button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* 오래된 파일 */}
            {activeTab === "old" && (
              <div>
                {result.old_files.length === 0 ? (
                  <p style={{ color: "#888", textAlign: "center", padding: "40px" }}>1년 이상 된 대용량 파일이 없습니다.</p>
                ) : (
                  result.old_files.map((file, index) => (
                    <div
                      key={index}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "14px 16px",
                        background: "var(--bg-tertiary)",
                        borderRadius: "10px",
                        marginBottom: "8px",
                        border: "1px solid rgba(245, 158, 11, 0.1)"
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: "#fff", fontWeight: "500", marginBottom: "4px" }}>{file.name}</div>
                        <div style={{ color: "#64748b", fontSize: "12px" }}>
                          마지막 수정: {file.modified}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <span style={{ color: "#f59e0b", fontWeight: "bold", fontSize: "14px" }}>
                          {formatSize(file.size)}
                        </span>
                        <button
                          onClick={() => openFile(file.path)}
                          style={{
                            padding: "8px 12px",
                            background: "rgba(59, 130, 246, 0.2)",
                            border: "1px solid rgba(59, 130, 246, 0.3)",
                            borderRadius: "6px",
                            color: "#93c5fd",
                            cursor: "pointer",
                            fontSize: "12px"
                          }}
                        >
                          👁️ 보기
                        </button>
                        <button
                          onClick={() => openInFinder(file.path)}
                          style={{
                            padding: "8px 12px",
                            background: "rgba(99, 102, 241, 0.2)",
                            border: "1px solid rgba(99, 102, 241, 0.3)",
                            borderRadius: "6px",
                            color: "#a5b4fc",
                            cursor: "pointer",
                            fontSize: "12px"
                          }}
                        >
                          📂 위치
                        </button>
                        <button
                          onClick={() => setDeleteConfirm({ path: file.path, name: file.name })}
                          style={{
                            padding: "8px 12px",
                            background: "rgba(239, 68, 68, 0.2)",
                            border: "1px solid rgba(239, 68, 68, 0.3)",
                            borderRadius: "6px",
                            color: "#fca5a5",
                            cursor: "pointer",
                            fontSize: "12px"
                          }}
                        >
                          🗑️ 삭제
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* 중복 의심 파일 */}
            {activeTab === "duplicates" && (
              <div>
                {result.duplicates.length === 0 ? (
                  <p style={{ color: "#888", textAlign: "center", padding: "40px" }}>중복 의심 파일이 없습니다.</p>
                ) : (
                  result.duplicates.slice(0, 10).map((group, index) => (
                    <div
                      key={index}
                      style={{
                        padding: "16px",
                        background: "var(--bg-tertiary)",
                        borderRadius: "10px",
                        marginBottom: "12px",
                        border: "1px solid rgba(139, 92, 246, 0.1)"
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: "12px",
                          paddingBottom: "10px",
                          borderBottom: "1px solid rgba(255,255,255,0.1)"
                        }}
                      >
                        <span style={{ color: "#a78bfa", fontWeight: "bold" }}>
                          📦 크기: {formatSize(group.size)}
                        </span>
                        <span style={{ color: "#64748b" }}>{group.files.length}개 파일</span>
                      </div>
                      {group.files.map((file, fileIndex) => (
                        <div
                          key={fileIndex}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "10px 12px",
                            background: "var(--bg-secondary)",
                            borderRadius: "8px",
                            marginBottom: "6px",
                          }}
                        >
                          <span
                            style={{
                              color: "#ddd",
                              fontSize: "12px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              flex: 1,
                            }}
                          >
                            {file}
                          </span>
                          <div style={{ display: "flex", gap: "8px" }}>
                            <button
                              onClick={() => openInFinder(file)}
                              style={{
                                padding: "6px 10px",
                                background: "rgba(99, 102, 241, 0.2)",
                                border: "none",
                                borderRadius: "6px",
                                color: "#a5b4fc",
                                cursor: "pointer",
                                fontSize: "11px",
                              }}
                            >
                              📂
                            </button>
                            <button
                              onClick={() => setDeleteConfirm({ path: file, name: file.split('/').pop() || file })}
                              style={{
                                padding: "6px 10px",
                                background: "rgba(239, 68, 68, 0.2)",
                                border: "none",
                                borderRadius: "6px",
                                color: "#fca5a5",
                                cursor: "pointer",
                                fontSize: "11px",
                              }}
                            >
                              🗑️
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* 동영상 갤러리 */}
            {activeTab === "media" && (
              <div>
                {result.videos.length === 0 ? (
                  <p style={{ color: "#888", textAlign: "center", padding: "40px" }}>동영상 파일이 없습니다.</p>
                ) : (
                  <>
                    {/* 전체 선택 버튼 */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", padding: "12px", background: "rgba(34, 197, 94, 0.1)", borderRadius: "8px" }}>
                      <div style={{ color: "#86efac" }}>
                        🎬 {result.videos.length}개 동영상 ({formatSize(result.videos.reduce((sum, f) => sum + f.size, 0))})
                      </div>
                      <button
                        onClick={() => {
                          isAllSelected(result.videos) ? deselectAllFiles(result.videos) : selectAllFiles(result.videos);
                        }}
                        style={{
                          padding: "8px 16px",
                          background: isAllSelected(result.videos) ? "#22c55e" : "rgba(34, 197, 94, 0.3)",
                          border: "none",
                          borderRadius: "6px",
                          color: "white",
                          cursor: "pointer",
                          fontWeight: 600
                        }}
                      >
                        {isAllSelected(result.videos) ? "✓ 전체 선택됨" : "☐ 전체 선택"}
                      </button>
                    </div>

                    {/* 비디오 섹션 */}
                    {result.videos.length > 0 && (
                      <div>
                        <h4 style={{ margin: "0 0 12px 0", color: "#fff" }}>🎬 비디오 ({result.videos.length}개)</h4>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          {result.videos.map((file, idx) => (
                            <div
                              key={idx}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                padding: "12px 16px",
                                background: selectedFiles.has(file.path) ? "rgba(168, 85, 247, 0.15)" : "var(--bg-tertiary)",
                                borderRadius: "10px",
                                border: selectedFiles.has(file.path) ? "1px solid rgba(168, 85, 247, 0.4)" : "1px solid transparent",
                                cursor: "pointer"
                              }}
                              onClick={() => toggleFileSelection(file.path)}
                            >
                              <input type="checkbox" checked={selectedFiles.has(file.path)} onChange={() => {}} style={{ width: "18px", height: "18px", marginRight: "12px", accentColor: "#a855f7" }} />
                              <div style={{ width: "50px", height: "50px", background: "#1e1e3f", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", marginRight: "12px", fontSize: "24px" }}>🎬</div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: "#fff", fontSize: "13px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
                                <div style={{ color: "#64748b", fontSize: "11px" }}>{file.path}</div>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: "10px" }} onClick={e => e.stopPropagation()}>
                                <span style={{ color: "#a855f7", fontWeight: "bold", fontSize: "14px" }}>{formatSize(file.size)}</span>
                                <button onClick={() => openFile(file.path)} style={{ padding: "6px 10px", background: "rgba(59, 130, 246, 0.2)", border: "none", borderRadius: "6px", color: "#93c5fd", cursor: "pointer", fontSize: "11px" }}>▶️</button>
                                <button onClick={() => openInFinder(file.path)} style={{ padding: "6px 10px", background: "rgba(99, 102, 241, 0.2)", border: "none", borderRadius: "6px", color: "#a5b4fc", cursor: "pointer", fontSize: "11px" }}>📂</button>
                                <button onClick={() => setDeleteConfirm({ path: file.path, name: file.name })} style={{ padding: "6px 10px", background: "rgba(239, 68, 68, 0.3)", border: "none", borderRadius: "6px", color: "#fca5a5", cursor: "pointer", fontSize: "11px" }}>🗑️</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* 폴더명 변경 제안 */}
            {activeTab === "rename" && (
              <div>
                {renameSuggestions.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "40px" }}>
                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>✏️</div>
                    <p style={{ color: "#888", marginBottom: "20px" }}>
                      AI가 폴더명을 분석하여 더 인식하기 쉬운 이름을 제안해드립니다.
                    </p>
                    <button
                      onClick={getRenameSuggestions}
                      disabled={isGettingRenameSuggestions}
                      style={{
                        padding: "12px 24px",
                        background: isGettingRenameSuggestions ? "#64748b" : "linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)",
                        border: "none",
                        borderRadius: "8px",
                        color: "white",
                        cursor: isGettingRenameSuggestions ? "not-allowed" : "pointer",
                        fontWeight: 600,
                        fontSize: "14px"
                      }}
                    >
                      {isGettingRenameSuggestions ? "🔄 분석 중..." : "🤖 AI 폴더명 분석 시작"}
                    </button>
                  </div>
                ) : (
                  <>
                    {/* 헤더 */}
                    <div style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "16px",
                      padding: "12px",
                      background: "rgba(6, 182, 212, 0.1)",
                      borderRadius: "8px"
                    }}>
                      <div style={{ color: "#67e8f9" }}>
                        {renameSuggestions.filter(s => s.selected).length} / {renameSuggestions.length} 선택됨
                      </div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          onClick={() => toggleAllSuggestions(!renameSuggestions.every(s => s.selected))}
                          style={{
                            padding: "8px 16px",
                            background: "rgba(6, 182, 212, 0.3)",
                            border: "none",
                            borderRadius: "6px",
                            color: "white",
                            cursor: "pointer"
                          }}
                        >
                          {renameSuggestions.every(s => s.selected) ? "전체 해제" : "전체 선택"}
                        </button>
                        <button
                          onClick={executeRename}
                          disabled={renameExecuting || renameSuggestions.filter(s => s.selected).length === 0}
                          style={{
                            padding: "8px 16px",
                            background: renameExecuting ? "#64748b" : "linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)",
                            border: "none",
                            borderRadius: "6px",
                            color: "white",
                            cursor: renameExecuting ? "not-allowed" : "pointer",
                            fontWeight: 600
                          }}
                        >
                          {renameExecuting ? "변경 중..." : "✅ 선택한 폴더 이름 변경"}
                        </button>
                        <button
                          onClick={getRenameSuggestions}
                          disabled={isGettingRenameSuggestions}
                          style={{
                            padding: "8px 16px",
                            background: "rgba(99, 102, 241, 0.3)",
                            border: "none",
                            borderRadius: "6px",
                            color: "white",
                            cursor: "pointer"
                          }}
                        >
                          🔄 다시 분석
                        </button>
                      </div>
                    </div>

                    {/* 제안 목록 */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {renameSuggestions.map((suggestion) => (
                        <div
                          key={suggestion.original_path}
                          onClick={() => toggleSuggestionSelection(suggestion.original_path)}
                          style={{
                            background: suggestion.selected ? "rgba(6, 182, 212, 0.1)" : "rgba(255,255,255,0.03)",
                            padding: "16px",
                            borderRadius: "10px",
                            cursor: "pointer",
                            border: suggestion.selected ? "1px solid rgba(6, 182, 212, 0.3)" : "1px solid rgba(255,255,255,0.05)",
                            transition: "all 0.2s ease"
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                            <input
                              type="checkbox"
                              checked={suggestion.selected}
                              onChange={() => {}}
                              style={{ width: "18px", height: "18px", marginTop: "4px", accentColor: "#06b6d4" }}
                            />
                            <div style={{ flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
                                <span style={{ color: "#94a3b8", fontSize: "14px" }}>📁 {suggestion.original_name}</span>
                                <span style={{ color: "#06b6d4", fontSize: "16px" }}>→</span>
                                <span style={{ color: "#22c55e", fontSize: "14px", fontWeight: 600 }}>📂 {suggestion.suggested_name}</span>
                              </div>
                              <div style={{ color: "#64748b", fontSize: "12px", marginBottom: "6px" }}>
                                💡 {suggestion.reason}
                              </div>
                              <div style={{ color: "#475569", fontSize: "11px", fontFamily: "monospace" }}>
                                {suggestion.original_path}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* 삭제 확인 모달 */}
      {deleteConfirm && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000
        }}>
          <div style={{
            background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
            padding: "30px",
            borderRadius: "16px",
            maxWidth: "400px",
            width: "90%",
            border: "1px solid rgba(239, 68, 68, 0.3)"
          }}>
            <h3 style={{ margin: "0 0 16px 0", color: "#fff" }}>🗑️ 삭제 확인</h3>
            <p style={{ color: "#94a3b8", marginBottom: "20px", wordBreak: "break-all" }}>
              <strong style={{ color: "#fff" }}>{deleteConfirm.name}</strong>을(를) 삭제하시겠습니까?
            </p>
            <div style={{ display: "flex", gap: "12px" }}>
              <button
                onClick={() => deleteFile(deleteConfirm.path, true)}
                style={{
                  flex: 1,
                  padding: "12px",
                  background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
                  border: "none",
                  borderRadius: "8px",
                  color: "white",
                  cursor: "pointer",
                  fontWeight: 600
                }}
              >
                🗑️ 휴지통으로
              </button>
              <button
                onClick={() => deleteFile(deleteConfirm.path, false)}
                style={{
                  flex: 1,
                  padding: "12px",
                  background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
                  border: "none",
                  borderRadius: "8px",
                  color: "white",
                  cursor: "pointer",
                  fontWeight: 600
                }}
              >
                ⚠️ 영구 삭제
              </button>
            </div>
            <button
              onClick={() => setDeleteConfirm(null)}
              style={{
                marginTop: "12px",
                width: "100%",
                padding: "12px",
                background: "rgba(255,255,255,0.1)",
                border: "none",
                borderRadius: "8px",
                color: "#94a3b8",
                cursor: "pointer"
              }}
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* CSS 애니메이션 */}
      <style>{`
        @keyframes scanLine {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
          50% { transform: scale(1.05); box-shadow: 0 0 20px 10px rgba(99, 102, 241, 0.2); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(-10px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes progressWave {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
