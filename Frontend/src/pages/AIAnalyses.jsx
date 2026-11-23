import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Image, RefreshCw, X } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { getSocket } from '../api/socket';
import * as analysesApi from '../api/analyses.api';
import '../styles/admin.css';

const timestamp = (value) => value ? new Date(value).toLocaleString('vi-VN') : '—';
const percent = (value) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '—';

export default function AIAnalyses() {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const deviceId = searchParams.get('deviceId') || '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await analysesApi.list({ limit: 100, ...(deviceId ? { deviceId } : {}) });
      setRows(response.data || []);
      setError('');
    } catch (err) {
      setError(err.message || 'Không tải được lịch sử AI');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const socket = getSocket();
    const refresh = () => load();
    socket.on('analysis:new', refresh);
    return () => socket.off('analysis:new', refresh);
  }, [load]);

  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    setDetail(null);
    setImageUrl('');
    if (selected === null) return undefined;
    setDetailLoading(true);

    analysesApi.getDetail(selected).then(async (response) => {
      if (!alive) return;
      setDetail(response);
      if (response.imageUrl) {
        if (/^https?:\/\//i.test(response.imageUrl)) {
          setImageUrl(response.imageUrl);
        } else {
          const blob = await analysesApi.getImage(selected);
          if (alive) {
            objectUrl = URL.createObjectURL(blob);
            setImageUrl(objectUrl);
          }
        }
      }
    }).catch((err) => {
      if (alive) setError(err.message || 'Không tải được chi tiết phân tích');
    }).finally(() => {
      if (alive) setDetailLoading(false);
    });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selected]);

  const visible = rows.filter((analysis) =>
    `${analysis.diseaseName || ''} ${analysis.modelLabel || ''}`
      .toLowerCase().includes(query.trim().toLowerCase()));
  const predictions = Array.isArray(detail?.data?.predictions) ? detail.data.predictions : [];

  return <div className="entity-page">
    <PageHeader title="AI Chẩn Đoán" subtitle="Lịch sử nhận diện và các thông số do mô hình AI trả về">
      <button className="secondary-button" onClick={load} disabled={loading}><RefreshCw size={14}/> Làm mới</button>
    </PageHeader>
    {error && <div className="notice notice--error">{error}<button type="button" onClick={() => setError('')}>×</button></div>}

    <div className={`entity-workspace ${detail ? 'with-side-panel' : ''}`}>
      <section className="entity-content">
        <div className="toolbar">
          <input className="table-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm theo tên nhận diện hoặc nhãn model…"/>
          {deviceId && <button className="secondary-button compact-button" onClick={() => setSearchParams({})}>Thiết bị #{deviceId} <X size={12}/></button>}
          <span className="filter-count">{visible.length} kết quả</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Thời gian nhận diện</th><th>Tên nhận diện</th><th>Độ tin cậy</th><th>Model</th><th>Ảnh</th></tr></thead>
            <tbody>
              {visible.map((analysis) => <tr key={analysis.id} className={String(selected) === String(analysis.id) ? 'selected-row' : ''} onClick={() => setSelected(analysis.id)}>
                <td>{timestamp(analysis.capturedAt)}</td>
                <td><strong>{analysis.diseaseName || 'Chưa xác định'}</strong><small className="table-sub">{analysis.modelLabel || '—'}</small></td>
                <td><span className={`confidence ${Number(analysis.confidence) >= 0.85 ? 'confidence--high' : 'confidence--medium'}`}>{percent(analysis.confidence)}</span></td>
                <td>{analysis.modelVersion || '—'}</td>
                <td>{(analysis.imageUrl || analysis.imagePath) ? <span className="inline-label"><Image size={14}/> Có ảnh</span> : <span className="muted-text">Không có ảnh</span>}</td>
              </tr>)}
            </tbody>
          </table>
          {loading && <div className="empty-state">Đang tải kết quả nhận diện…</div>}
          {!loading && !visible.length && <div className="empty-state"><Activity size={24}/>Chưa có lịch sử nhận diện. Kết quả mới sẽ xuất hiện khi Camera gửi ảnh qua HTTP.</div>}
        </div>
      </section>

      {detail && <aside className="side-detail ai-detail">
        <div className="side-detail__heading"><div><h2>{detail.data?.diseaseName || 'Chi tiết nhận diện'}</h2><p>{timestamp(detail.data?.capturedAt)}</p></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Đóng chi tiết"><X size={16}/></button></div>
        {detailLoading ? <div className="empty-state">Đang tải chi tiết…</div> : <>
          <div className="ai-image-box">{imageUrl ? <img src={imageUrl} alt="Ảnh được gửi kèm kết quả nhận diện"/> : <div className="image-placeholder"><Image size={28}/><span>Không có ảnh cho kết quả này</span></div>}</div>
          <div className="analysis-facts">
            <div><span>Tên nhận diện</span><strong>{detail.data?.diseaseName || '—'}</strong></div>
            <div><span>Độ tin cậy</span><strong>{percent(detail.data?.confidence)}</strong></div>
            <div><span>Phiên bản model</span><strong>{detail.data?.modelVersion || '—'}</strong></div>
            <div><span>Thời gian xử lý</span><strong>{detail.data?.inferenceMs != null ? `${detail.data.inferenceMs} ms` : '—'}</strong></div>
            <div><span>Camera / Thiết bị</span><strong>{detail.data?.device?.name || detail.data?.device?.deviceCode || 'Tải lên ngoài'}</strong></div>
            <div><span>Mã sự kiện</span><strong>{detail.data?.eventId || '—'}</strong></div>
          </div>
          {predictions.length > 0 && <section className="prediction-results"><h3>Các lớp dự đoán</h3><div className="prediction-list">{predictions.map((item, index) => <div className="prediction-row" key={`${item.class_id ?? item.label ?? 'prediction'}-${index}`}><span>{item.label_vi || item.label || `Lớp ${index + 1}`}</span><strong>{percent(item.confidence)}</strong></div>)}</div></section>}
        </>}
      </aside>}
    </div>
  </div>;
}
