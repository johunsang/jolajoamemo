import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface CollectedData {
  url: string;
  title: string;
  tables: TableData[];
  numbers: NumberData[];
  lists: string[][];
  raw_text: string;
}

interface TableData {
  headers: string[];
  rows: string[][];
}

interface NumberData {
  label: string;
  value: string;
  unit?: string;
}

interface CollectionProgress {
  step: number;
  total: number;
  message: string;
  current_task?: string;
}

interface Props {
  showToast: (msg: string) => void;
}

export default function DataCollection({ showToast }: Props) {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isCollecting, setIsCollecting] = useState(false);
  const [progress, setProgress] = useState<CollectionProgress | null>(null);
  const [collectedData, setCollectedData] = useState<CollectedData[]>([]);
  const [selectedData, setSelectedData] = useState<number[]>([]);
  const [exportFormat, setExportFormat] = useState<'excel' | 'sheets'>('excel');
  const [isExporting, setIsExporting] = useState(false);
  const [isGoogleAuthed, setIsGoogleAuthed] = useState(false);
  const [totalStats, setTotalStats] = useState({ tables: 0, numbers: 0, lists: 0 });
  const [viewMode, setViewMode] = useState<'list' | 'detail' | 'chart'>('list');
  const [selectedDetailIndex, setSelectedDetailIndex] = useState<number | null>(null);
  const [lastExportedPath, setLastExportedPath] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    checkGoogleAuth();
    const unsubscribe = listen<CollectionProgress>('data-collection-progress', (event) => {
      setProgress(event.payload);
    });
    return () => {
      unsubscribe.then(unsub => unsub());
    };
  }, []);

  const checkGoogleAuth = async () => {
    try {
      const authed = await invoke<boolean>('check_google_auth');
      setIsGoogleAuthed(authed);
    } catch (e) {
      console.error('Auth check failed:', e);
    }
  };

  const startCollection = async () => {
    if (!searchQuery.trim()) {
      showToast('검색어를 입력하세요');
      return;
    }

    setIsCollecting(true);
    setCollectedData([]);
    setTotalStats({ tables: 0, numbers: 0, lists: 0 });
    setProgress({ step: 0, total: 100, message: '데이터 수집 준비 중...', current_task: 'init' });
    setViewMode('list');
    setSelectedDetailIndex(null);

    try {
      const results = await invoke<CollectedData[]>('run_data_collection', { query: searchQuery });

      // 필터링: 실제로 데이터가 있는 항목만 유지
      const filteredResults = results.filter(d =>
        d.tables.length > 0 || d.numbers.length > 0 || d.lists.length > 0
      );

      setCollectedData(filteredResults);
      setSelectedData(filteredResults.map((_, i) => i));

      // 통계 계산
      const stats = filteredResults.reduce((acc, d) => ({
        tables: acc.tables + d.tables.length,
        numbers: acc.numbers + d.numbers.length,
        lists: acc.lists + d.lists.length
      }), { tables: 0, numbers: 0, lists: 0 });
      setTotalStats(stats);

      showToast(`${filteredResults.length}개 페이지에서 데이터 수집 완료! (테이블 ${stats.tables}개, 숫자 ${stats.numbers}개)`);
    } catch (e) {
      showToast(`수집 실패: ${e}`);
    } finally {
      setIsCollecting(false);
      setProgress(null);
    }
  };

  const exportData = async () => {
    if (selectedData.length === 0) {
      showToast('내보낼 데이터를 선택하세요');
      return;
    }

    const dataToExport = selectedData.map(i => collectedData[i]);
    setIsExporting(true);

    try {
      if (exportFormat === 'excel') {
        const result = await invoke<string>('export_collected_data_excel', { data: dataToExport });
        setLastExportedPath(result);
        showToast(`엑셀 파일 저장됨: ${result}`);
      } else {
        if (!isGoogleAuthed) {
          showToast('Google 로그인이 필요합니다 (설정에서 연동)');
          return;
        }
        const result = await invoke<{ url: string }>('export_collected_data_sheets', {
          data: dataToExport,
          title: `데이터수집_${searchQuery}_${new Date().toLocaleDateString('ko-KR')}`
        });
        window.open(result.url, '_blank');
        showToast('Google Sheets로 내보내기 완료');
      }
    } catch (e) {
      showToast(`내보내기 실패: ${e}`);
    } finally {
      setIsExporting(false);
    }
  };

  const openExportedFile = async () => {
    if (!lastExportedPath) return;
    try {
      await invoke('open_file_path', { path: lastExportedPath });
    } catch (e) {
      showToast(`파일 열기 실패: ${e}`);
    }
  };

  const openInFinder = async () => {
    if (!lastExportedPath) return;
    try {
      await invoke('open_in_finder', { path: lastExportedPath });
    } catch (e) {
      showToast(`폴더 열기 실패: ${e}`);
    }
  };

  const downloadChartAsImage = async () => {
    if (!chartRef.current) return;

    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(chartRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
      });

      const link = document.createElement('a');
      link.download = `chart-${searchQuery}-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      showToast('차트 이미지 다운로드 완료');
    } catch (error) {
      console.error('차트 이미지 다운로드 오류:', error);
      showToast('이미지 다운로드에 실패했습니다.');
    }
  };

  const toggleSelect = (index: number) => {
    setSelectedData(prev =>
      prev.includes(index)
        ? prev.filter(i => i !== index)
        : [...prev, index]
    );
  };

  const selectAll = () => setSelectedData(collectedData.map((_, i) => i));
  const deselectAll = () => setSelectedData([]);

  // 숫자 데이터에서 차트 데이터 추출
  const chartData = collectedData.flatMap((d, idx) =>
    d.numbers.map(n => ({
      label: n.label.substring(0, 20),
      value: parseFloat(n.value.replace(/[^0-9.-]/g, '')) || 0,
      unit: n.unit || '',
      source: d.title.substring(0, 15) || `출처${idx + 1}`,
    }))
  ).filter(d => !isNaN(d.value) && d.value > 0).slice(0, 15);

  const maxValue = Math.max(...chartData.map(d => d.value), 1);

  // 색상 배열
  const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF', '#7BC043', '#FF5252', '#448AFF'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>
      {/* 검색 입력 영역 */}
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '20px',
        border: '1px solid var(--border)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <span style={{ fontSize: '20px' }}>🗃️</span>
          <span style={{ fontSize: '15px', fontWeight: 700 }}>AI 데이터 수집</span>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
          검색어를 입력하면 AI가 웹을 돌아다니며 테이블, 숫자, 리스트 등 모든 데이터를 자동으로 수집합니다.
        </p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="예: 2024년 스마트폰 판매량, 서울시 인구 통계, 주식 시세..."
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              fontSize: '13px'
            }}
            onKeyPress={(e) => {
              if (e.key === 'Enter' && searchQuery.trim() && !isCollecting) {
                startCollection();
              }
            }}
          />
          <button
            onClick={startCollection}
            disabled={isCollecting || !searchQuery.trim()}
            style={{
              padding: '12px 24px',
              background: isCollecting || !searchQuery.trim()
                ? 'var(--bg-tertiary)'
                : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              color: isCollecting || !searchQuery.trim() ? 'var(--text-secondary)' : 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: isCollecting || !searchQuery.trim() ? 'not-allowed' : 'pointer',
              minWidth: '140px'
            }}
          >
            {isCollecting ? '수집 중...' : '🔍 데이터 수집'}
          </button>
        </div>
      </div>

      {/* 진행 상황 */}
      {progress && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.1) 0%, rgba(5, 150, 105, 0.1) 100%)',
          borderRadius: '12px',
          padding: '16px',
          border: '1px solid rgba(16, 185, 129, 0.2)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <div style={{
              width: '16px',
              height: '16px',
              border: '2px solid #10b981',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }} />
            <span style={{ fontSize: '13px', fontWeight: 500 }}>{progress.message}</span>
          </div>
          <div style={{
            height: '4px',
            background: 'rgba(16, 185, 129, 0.2)',
            borderRadius: '2px',
            overflow: 'hidden'
          }}>
            <div style={{
              width: `${Math.min(progress.step / progress.total * 100, 100)}%`,
              height: '100%',
              background: '#10b981',
              transition: 'width 0.3s ease'
            }} />
          </div>
        </div>
      )}

      {/* 수집된 데이터 영역 */}
      {collectedData.length > 0 && (
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '20px',
          border: '1px solid var(--border)',
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}>
          {/* 헤더 & 탭 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '20px' }}>📊</span>
                <span style={{ fontSize: '15px', fontWeight: 700 }}>수집된 데이터</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <span style={{ padding: '4px 8px', background: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', borderRadius: '4px', fontSize: '11px' }}>
                  테이블 {totalStats.tables}개
                </span>
                <span style={{ padding: '4px 8px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', borderRadius: '4px', fontSize: '11px' }}>
                  숫자 {totalStats.numbers}개
                </span>
                <span style={{ padding: '4px 8px', background: 'rgba(168, 85, 247, 0.1)', color: '#a855f7', borderRadius: '4px', fontSize: '11px' }}>
                  리스트 {totalStats.lists}개
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {['list', 'chart', 'detail'].map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode as typeof viewMode)}
                  style={{
                    padding: '6px 12px',
                    background: viewMode === mode ? '#4a4af0' : 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: viewMode === mode ? 'white' : 'var(--text-primary)',
                    fontSize: '12px',
                    cursor: 'pointer'
                  }}
                >
                  {mode === 'list' ? '📋 목록' : mode === 'chart' ? '📊 차트' : '🔍 상세'}
                </button>
              ))}
            </div>
          </div>

          {/* 목록 보기 */}
          {viewMode === 'list' && (
            <>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{selectedData.length}/{collectedData.length} 선택</span>
                <button onClick={selectAll} style={{ padding: '4px 8px', fontSize: '11px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer', color: 'var(--text-primary)' }}>전체</button>
                <button onClick={deselectAll} style={{ padding: '4px 8px', fontSize: '11px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer', color: 'var(--text-primary)' }}>해제</button>
              </div>
              <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {collectedData.map((data, idx) => (
                  <div
                    key={idx}
                    onClick={() => toggleSelect(idx)}
                    style={{
                      padding: '14px',
                      background: selectedData.includes(idx)
                        ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.1) 0%, rgba(5, 150, 105, 0.05) 100%)'
                        : 'var(--bg-tertiary)',
                      borderRadius: '8px',
                      border: selectedData.includes(idx) ? '2px solid #10b981' : '1px solid var(--border)',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                      <input type="checkbox" checked={selectedData.includes(idx)} onChange={() => toggleSelect(idx)} style={{ width: '16px', height: '16px' }} />
                      <span style={{ fontWeight: 600, fontSize: '13px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.title || 'Untitled'}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedDetailIndex(idx); setViewMode('detail'); }}
                        style={{ padding: '4px 8px', fontSize: '11px', background: '#4a4af0', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer' }}
                      >
                        상세 보기
                      </button>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.url}</div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {data.tables.length > 0 && (
                        <span style={{ padding: '3px 6px', background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', borderRadius: '3px', fontSize: '10px', fontWeight: 500 }}>
                          📋 테이블 {data.tables.length}개 ({data.tables.reduce((a, t) => a + t.rows.length, 0)}행)
                        </span>
                      )}
                      {data.numbers.length > 0 && (
                        <span style={{ padding: '3px 6px', background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', borderRadius: '3px', fontSize: '10px', fontWeight: 500 }}>
                          🔢 숫자 {data.numbers.length}개
                        </span>
                      )}
                      {data.lists.length > 0 && (
                        <span style={{ padding: '3px 6px', background: 'rgba(168, 85, 247, 0.15)', color: '#a855f7', borderRadius: '3px', fontSize: '10px', fontWeight: 500 }}>
                          📝 리스트 {data.lists.length}개
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 차트 보기 */}
          {viewMode === 'chart' && (
            <div style={{ flex: 1, overflow: 'auto' }}>
              {chartData.length > 0 ? (
                <div ref={chartRef} style={{ background: '#1a1a2e', padding: '20px', borderRadius: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <h3 style={{ margin: 0, color: '#fff', fontSize: '16px' }}>📊 수집된 숫자 데이터 시각화</h3>
                    <button
                      onClick={downloadChartAsImage}
                      style={{
                        padding: '8px 16px',
                        background: '#4a4af0',
                        border: 'none',
                        borderRadius: '8px',
                        color: 'white',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      📥 이미지로 저장
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {chartData.map((item, idx) => (
                      <div key={idx}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ color: '#fff', fontSize: '12px' }}>{item.label}</span>
                          <span style={{ color: '#aaa', fontSize: '12px' }}>
                            {item.value.toLocaleString()} {item.unit}
                          </span>
                        </div>
                        <div style={{
                          background: '#333',
                          borderRadius: '4px',
                          height: '24px',
                          overflow: 'hidden'
                        }}>
                          <div style={{
                            background: colors[idx % colors.length],
                            width: `${(item.value / maxValue) * 100}%`,
                            height: '100%',
                            transition: 'width 0.5s ease',
                            display: 'flex',
                            alignItems: 'center',
                            paddingLeft: '8px'
                          }}>
                            <span style={{ color: '#fff', fontSize: '10px', fontWeight: 500 }}>{item.source}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                  <span style={{ fontSize: '48px' }}>📊</span>
                  <p>시각화할 숫자 데이터가 없습니다.</p>
                </div>
              )}
            </div>
          )}

          {/* 상세 보기 */}
          {viewMode === 'detail' && (
            <div style={{ flex: 1, overflow: 'auto' }}>
              {selectedDetailIndex !== null ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                    <button
                      onClick={() => { setSelectedDetailIndex(null); setViewMode('list'); }}
                      style={{ padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', cursor: 'pointer' }}
                    >
                      ← 목록으로
                    </button>
                    <h3 style={{ margin: 0, fontSize: '14px' }}>{collectedData[selectedDetailIndex].title}</h3>
                  </div>

                  {/* 테이블 */}
                  {collectedData[selectedDetailIndex].tables.length > 0 && (
                    <div style={{ marginBottom: '20px' }}>
                      <h4 style={{ fontSize: '13px', color: '#3b82f6', marginBottom: '12px' }}>📋 테이블 ({collectedData[selectedDetailIndex].tables.length}개)</h4>
                      {collectedData[selectedDetailIndex].tables.map((table, tIdx) => (
                        <div key={tIdx} style={{ marginBottom: '16px', overflow: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                            {table.headers.length > 0 && (
                              <thead>
                                <tr>
                                  {table.headers.map((h, hIdx) => (
                                    <th key={hIdx} style={{ padding: '8px', background: '#3b82f6', color: 'white', border: '1px solid var(--border)', textAlign: 'left' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                            )}
                            <tbody>
                              {table.rows.map((row, rIdx) => (
                                <tr key={rIdx}>
                                  {row.map((cell, cIdx) => (
                                    <td key={cIdx} style={{ padding: '8px', border: '1px solid var(--border)', background: rIdx % 2 === 0 ? 'var(--bg-tertiary)' : 'var(--bg-secondary)' }}>{cell}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 숫자 */}
                  {collectedData[selectedDetailIndex].numbers.length > 0 && (
                    <div style={{ marginBottom: '20px' }}>
                      <h4 style={{ fontSize: '13px', color: '#10b981', marginBottom: '12px' }}>🔢 숫자 데이터 ({collectedData[selectedDetailIndex].numbers.length}개)</h4>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
                        {collectedData[selectedDetailIndex].numbers.map((num, nIdx) => (
                          <div key={nIdx} style={{ padding: '12px', background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{num.label}</div>
                            <div style={{ fontSize: '18px', fontWeight: 700, color: '#10b981' }}>
                              {num.value} <span style={{ fontSize: '12px', fontWeight: 400 }}>{num.unit || ''}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 리스트 */}
                  {collectedData[selectedDetailIndex].lists.length > 0 && (
                    <div style={{ marginBottom: '20px' }}>
                      <h4 style={{ fontSize: '13px', color: '#a855f7', marginBottom: '12px' }}>📝 리스트 ({collectedData[selectedDetailIndex].lists.length}개)</h4>
                      {collectedData[selectedDetailIndex].lists.map((list, lIdx) => (
                        <ul key={lIdx} style={{ margin: '0 0 12px 0', padding: '0 0 0 20px' }}>
                          {list.map((item, iIdx) => (
                            <li key={iIdx} style={{ fontSize: '12px', marginBottom: '4px', color: 'var(--text-primary)' }}>{item}</li>
                          ))}
                        </ul>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                  <p>목록에서 항목을 선택하여 상세 내용을 확인하세요.</p>
                </div>
              )}
            </div>
          )}

          {/* 내보내기 */}
          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)', display: 'flex', gap: '12px', alignItems: 'center' }}>
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as 'excel' | 'sheets')}
              style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: '13px' }}
            >
              <option value="excel">Excel (.csv)</option>
              <option value="sheets">Google Sheets</option>
            </select>
            <button
              onClick={exportData}
              disabled={isExporting || selectedData.length === 0}
              style={{
                flex: 1,
                padding: '12px 24px',
                background: selectedData.length === 0 || isExporting
                  ? 'var(--bg-tertiary)'
                  : exportFormat === 'sheets'
                    ? 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)'
                    : 'linear-gradient(135deg, #217346 0%, #185c37 100%)',
                color: selectedData.length === 0 || isExporting ? 'var(--text-secondary)' : 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: selectedData.length === 0 || isExporting ? 'not-allowed' : 'pointer'
              }}
            >
              {isExporting ? '내보내는 중...' : exportFormat === 'sheets' ? '📊 Google Sheets로 내보내기' : '📥 Excel로 내보내기'}
            </button>
            {lastExportedPath && exportFormat === 'excel' && (
              <>
                <button
                  onClick={openExportedFile}
                  style={{
                    padding: '12px 16px',
                    background: '#4a4af0',
                    border: 'none',
                    borderRadius: '8px',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}
                >
                  📂 파일 열기
                </button>
                <button
                  onClick={openInFinder}
                  style={{
                    padding: '12px 16px',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}
                >
                  📁 폴더 열기
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 빈 상태 */}
      {!isCollecting && collectedData.length === 0 && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', gap: '16px' }}>
          <span style={{ fontSize: '48px' }}>🗃️</span>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 8px' }}>웹에서 데이터를 수집하세요</p>
            <p style={{ fontSize: '13px', margin: 0 }}>
              검색어를 입력하면 AI가 관련 웹페이지를 돌아다니며<br />
              테이블, 숫자, 리스트 등 모든 데이터를 자동으로 수집합니다.
            </p>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
