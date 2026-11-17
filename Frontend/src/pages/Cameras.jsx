import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrainCircuit, Camera, Check, Copy, Download, Image, KeyRound, Plus, RefreshCw, Save, ShieldOff, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../auth/AuthContext';
import { getSocket } from '../api/socket';
import * as cameraApi from '../api/camera.api';
import * as devicesApi from '../api/devices.api';
import '../styles/admin.css';

const timestamp = (value) => (value ? new Date(value).toLocaleString('vi-VN') : '—');

function ago(value) {
  if (!value) return 'Chưa từng kết nối';
  const sec = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (sec < 60) return `${sec} giây trước`;
  if (sec < 3600) return `${Math.round(sec / 60)} phút trước`;
  if (sec < 86400) return `${Math.round(sec / 3600)} giờ trước`;
  return `${Math.round(sec / 86400)} ngày trước`;
}

const LIFE_LABEL = {
  REGISTERED: 'Đã đăng ký', PROVISIONED: 'Đã cấp token', ACTIVE: 'Hoạt động',
  FAULT: 'Lỗi', MAINTENANCE: 'Bảo trì', DECOMMISSIONED: 'Ngừng sử dụng',
};
const LIFE_CLASS = { ACTIVE: 'status-badge--ok', FAULT: 'status-badge--off', DECOMMISSIONED: 'status-badge--off' };
const TOKEN_LABEL = { NONE: 'Chưa cấp', ACTIVE: 'Còn hiệu lực', EXPIRED: 'Hết hạn', REVOKED: 'Đã thu hồi' };
const TOKEN_CLASS = { ACTIVE: 'status-badge--ok', EXPIRED: 'status-badge--off', REVOKED: 'status-badge--off' };

// Giống CAMERA_TRANSITIONS ở Backend (camera-lifecycle.service.js). REGISTERED → PROVISIONED bằng cách cấp token.
const TRANSITIONS = {
  REGISTERED: ['DECOMMISSIONED'],
  PROVISIONED: ['ACTIVE', 'FAULT', 'MAINTENANCE', 'DECOMMISSIONED'],
  ACTIVE: ['FAULT', 'MAINTENANCE', 'DECOMMISSIONED'],
  FAULT: ['ACTIVE', 'MAINTENANCE', 'DECOMMISSIONED'],
  MAINTENANCE: ['FAULT', 'ACTIVE', 'DECOMMISSIONED'],
  DECOMMISSIONED: [],
};
const ACTION_LABEL = { ACTIVE: 'Kích hoạt lại', FAULT: 'Đánh dấu lỗi', MAINTENANCE: 'Bảo trì', DECOMMISSIONED: 'Ngừng sử dụng' };

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API cần HTTPS hoặc localhost; fallback cho trang mở qua IP LAN.
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function downloadJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Địa chỉ điện thoại sẽ gọi tới: origin của API nếu VITE_API_URL là URL tuyệt đối, ngược lại origin trang web.
// Origin trang thường là localhost:5173 (Vite) → TokenDialog thay bằng IP LAN do Backend gợi ý.
function defaultServerUrl() {
  const base = (import.meta.env.VITE_API_URL || '').trim();
  try {
    if (/^https?:\/\//i.test(base)) return new URL(base).origin;
  } catch { /* bỏ qua, dùng origin trang */ }
  return window.location.origin;
}

// Địa chỉ điện thoại không dùng được: loopback (điện thoại hiểu là chính nó) hoặc cổng dev của Vite.
function serverUrlProblem(value) {
  let u;
  try { u = new URL(value.trim()); } catch { return value.trim() ? 'Địa chỉ không hợp lệ, cần dạng http(s)://host[:port].' : ''; }
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1?\])/i.test(u.hostname)) {
    return 'localhost chỉ dùng được khi agent chạy trên chính máy này. Điện thoại cần IP LAN hoặc tên miền.';
  }
  if (u.port === '5173') return 'Cổng 5173 là Vite (web dev). Agent nên gọi thẳng cổng Backend, thường là 3000.';
  return '';
}

function CopyButton({ text, label = 'Sao chép' }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="secondary-button compact-button" onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1500); } }}>
      {done ? <Check size={13} /> : <Copy size={13} />}{done ? 'Đã chép' : label}
    </button>
  );
}

function RegisterDialog({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', location: '', captureIntervalSeconds: 60, heartbeatIntervalSeconds: 60 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await cameraApi.registerCamera({
        name: form.name.trim(),
        location: form.location.trim() || undefined,
        captureIntervalSeconds: Number(form.captureIntervalSeconds),
        heartbeatIntervalSeconds: Number(form.heartbeatIntervalSeconds),
      });
      onSaved(res.data);
    } catch (err) {
      setError(err.message || 'Không tạo được Camera');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <form className="modal-card" onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <h2>Thêm Camera điện thoại</h2>
            <p>Backend sinh mã CAM-xxx. Bước tiếp theo: cấp token và dán cấu hình vào agent trên điện thoại.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="form-grid">
          <label className="form-span-2">Tên Camera<input required maxLength={100} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Camera điện thoại Nhà kính A" /></label>
          <label className="form-span-2">Vị trí<input maxLength={150} value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Nhà kính A" /></label>
          <label>Chu kỳ chụp (giây)<input type="number" min="5" max="86400" required value={form.captureIntervalSeconds} onChange={(e) => set('captureIntervalSeconds', e.target.value)} /></label>
          <label>Chu kỳ heartbeat (giây)<input type="number" min="10" max="3600" required value={form.heartbeatIntervalSeconds} onChange={(e) => set('heartbeatIntervalSeconds', e.target.value)} /></label>
          <small className="muted-text form-span-2">Camera bị coi là mất kết nối sau max(90 giây, 3 × chu kỳ heartbeat) không gửi tín hiệu.</small>
        </div>
        {error && <div className="notice notice--error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Hủy</button>
          <button className="primary-button" disabled={busy}><Save size={15} />{busy ? 'Đang lưu…' : 'Tạo Camera'}</button>
        </div>
      </form>
    </div>
  );
}

function TokenDialog({ camera, onClose, onIssued }) {
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [hints, setHints] = useState([]);
  const [urlEdited, setUrlEdited] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const replacing = camera.token?.status === 'ACTIVE';
  const configText = useMemo(() => (result ? JSON.stringify(result.agentConfig, null, 2) : ''), [result]);
  const urlProblem = serverUrlProblem(serverUrl);

  // Lấy IP LAN của máy chạy Backend; nếu ô đang là localhost/:5173 mà người dùng chưa sửa thì tự thay.
  useEffect(() => {
    let alive = true;
    cameraApi.getServerHints().then((res) => {
      if (!alive) return;
      const list = res.data?.urls || [];
      setHints(list);
      if (list.length && !urlEdited && serverUrlProblem(defaultServerUrl())) setServerUrl(list[0].url);
    }).catch(() => { /* không có gợi ý thì người dùng nhập tay */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { serverUrl: serverUrl.trim() || undefined };
      if (expiresInDays !== '') body.expiresInDays = Number(expiresInDays);
      const res = await cameraApi.issueToken(camera.deviceCode, body);
      setResult(res.data);
      onIssued();
    } catch (err) {
      setError(err.message || 'Không cấp được token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <form className="modal-card camera-token-card" onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <h2>{result ? 'Token Camera đã được cấp' : `${replacing ? 'Cấp lại' : 'Cấp'} token cho ${camera.deviceCode}`}</h2>
            <p>{camera.name}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>

        {!result && <>
          <div className="form-grid">
            {replacing && <div className="notice notice--warning form-span-2">Camera đang có token còn hiệu lực. Cấp mới sẽ vô hiệu hoá token cũ ngay; agent trên điện thoại phải cập nhật cấu hình.</div>}
            <label className="form-span-2">Địa chỉ server điện thoại truy cập được
              <input required value={serverUrl} onChange={(e) => { setUrlEdited(true); setServerUrl(e.target.value); }} placeholder="https://iot.example.com hoặc http://192.168.1.10:3000" />
            </label>
            {hints.length > 0 && <div className="camera-hints form-span-2">
              <span className="muted-text">IP của máy chạy Backend:</span>
              {hints.map((h) => (
                <button key={h.url} type="button" className={`camera-hint${h.url === serverUrl.trim() ? ' is-active' : ''}`} title={h.iface} onClick={() => { setUrlEdited(true); setServerUrl(h.url); }}>{h.url}</button>
              ))}
            </div>}
            {urlProblem && <div className="notice notice--warning form-span-2">{urlProblem}</div>}
            <label>Hạn dùng (ngày, tuỳ chọn)<input type="number" min="1" max="365" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} placeholder="Không hết hạn" /></label>
            <small className="muted-text form-span-2">Dùng IP LAN hoặc tên miền của máy chạy Backend, không dùng localhost (điện thoại sẽ hiểu là chính nó).</small>
          </div>
          {error && <div className="notice notice--error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Hủy</button>
            <button className="primary-button" disabled={busy}><KeyRound size={15} />{busy ? 'Đang cấp…' : 'Cấp token'}</button>
          </div>
        </>}

        {result && <>
          <div className="notice notice--warning">Token chỉ hiển thị một lần. Hãy sao chép hoặc tải config.json ngay; đóng hộp thoại này sẽ không xem lại được.</div>
          <div className="camera-token-block">
            <span className="field-label">Token</span>
            <div className="camera-token-row"><code>{result.token}</code><CopyButton text={result.token} /></div>
          </div>
          <div className="camera-token-block">
            <div className="camera-token-row">
              <span className="field-label">phone-camera/config.json (phần kết nối)</span>
              <span className="camera-token-actions">
                <CopyButton text={configText} label="Sao chép JSON" />
                <button type="button" className="secondary-button compact-button" onClick={() => downloadJson('config.json', result.agentConfig)}><Download size={13} />Tải config.json</button>
              </span>
            </div>
            <pre className="camera-config-json">{configText}</pre>
          </div>
          <small className="muted-text">
            Upload: <code>{result.uploadUrl}</code><br />
            Heartbeat: <code>{result.heartbeatUrl}</code> mỗi {result.heartbeatIntervalSeconds} giây
            {result.expiresAt && <><br />Hết hạn: {timestamp(result.expiresAt)}</>}
          </small>
          <small className="muted-text">Trên điện thoại: gộp JSON này vào config.json của agent, chạy <code>python camera_agent.py --check-heartbeat</code>. Camera tự chuyển sang “Hoạt động” khi heartbeat đầu tiên tới server.</small>
          {result.warning && <div className="notice notice--info">{result.warning}</div>}
          <div className="modal-actions"><button type="button" className="primary-button" onClick={onClose}>Đã lưu token, đóng</button></div>
        </>}
      </form>
    </div>
  );
}

function MediaGallery({ camera, canAdmin, refreshKey }) {
  const [items, setItems] = useState([]);
  const [urls, setUrls] = useState({});
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    const created = [];
    setItems([]);
    setUrls({});
    setError('');
    cameraApi.listMedia({ cameraId: camera.deviceCode, limit: 12 }).then(async (res) => {
      if (!alive) return;
      const rows = res.data || [];
      setItems(rows);
      setTotal(res.meta?.total ?? rows.length);
      for (const m of rows) {
        try {
          const blob = await cameraApi.getMediaFile(m.eventId);
          if (!alive) return;
          const url = URL.createObjectURL(blob);
          created.push(url);
          setUrls((u) => ({ ...u, [m.eventId]: url }));
        } catch { /* file lỗi: giữ placeholder */ }
      }
    }).catch((e) => { if (alive) setError(e.message || 'Không tải được media'); });
    return () => { alive = false; created.forEach((u) => URL.revokeObjectURL(u)); };
  }, [camera.deviceCode, refreshKey, reload]);

  const remove = async (m) => {
    if (!window.confirm(`Xoá media ${m.eventId}?`)) return;
    try {
      await cameraApi.deleteMedia(m.eventId);
      setPreview(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e.message || 'Không xoá được media');
    }
  };

  return (
    <section className="camera-gallery-section">
      <div className="camera-section-title"><h3>Media lưu trên server</h3><span className="muted-text">{total} file</span></div>
      {error && <div className="notice notice--error">{error}</div>}
      {!error && items.length === 0 && <p className="muted-text">Chưa có ảnh lưu local. Ở chế độ AI + Cloudinary, ảnh nằm trong mục AI Chẩn Đoán.</p>}
      <div className="camera-gallery">
        {items.map((m) => (
          <button type="button" key={m.eventId} className="camera-thumb" onClick={() => setPreview(m)} title={m.eventId}>
            {urls[m.eventId]
              ? (m.mediaType === 'video' ? <video src={urls[m.eventId]} muted /> : <img src={urls[m.eventId]} alt={m.eventId} />)
              : <span className="image-placeholder"><Image size={18} /></span>}
            <time>{timestamp(m.capturedAt || m.receivedAt)}</time>
          </button>
        ))}
      </div>
      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal-card camera-preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div><h2>{timestamp(preview.capturedAt || preview.receivedAt)}</h2><p><code>{preview.eventId}</code> · {Math.round(preview.sizeBytes / 1024)} KB</p></div>
              <button type="button" className="icon-button" onClick={() => setPreview(null)}><X size={18} /></button>
            </div>
            {urls[preview.eventId] && (preview.mediaType === 'video'
              ? <video src={urls[preview.eventId]} controls className="camera-preview-media" />
              : <img src={urls[preview.eventId]} alt={preview.eventId} className="camera-preview-media" />)}
            {canAdmin && <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => remove(preview)}><Trash2 size={14} />Xoá</button></div>}
          </div>
        </div>
      )}
    </section>
  );
}

export default function Cameras() {
  const { user } = useAuth();
  const canAdmin = user?.role === 'admin';
  const [cameras, setCameras] = useState([]);
  const [storage, setStorage] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(null); // 'register' | 'token'
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await cameraApi.listCameras();
      setCameras(res.data || []);
      setStorage(res.meta?.storage || '');
      setError('');
    } catch (e) {
      setError(e.message || 'Không tải được danh sách Camera');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Online/offline tính theo thời gian: tải lại định kỳ để badge tự đổi khi Camera ngừng heartbeat.
  useEffect(() => {
    const poll = setInterval(load, 30000);
    const tick = setInterval(() => setTick((n) => n + 1), 10000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [load]);

  useEffect(() => {
    const s = getSocket();
    let timer;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(load, 350); };
    const onAnalysis = () => { refresh(); setRefreshKey((n) => n + 1); };
    s.on('device:update', refresh);
    s.on('alert:new', refresh);
    s.on('analysis:new', onAnalysis);
    return () => { clearTimeout(timer); s.off('device:update', refresh); s.off('alert:new', refresh); s.off('analysis:new', onAnalysis); };
  }, [load]);

  const selected = cameras.find((c) => c.id === selectedId) || null;
  const onlineCount = cameras.filter((c) => c.isOnline).length;

  const run = async (fn, okMessage) => {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await fn();
      setNotice(okMessage);
      await load();
    } catch (e) {
      setError(e.message || 'Thao tác thất bại');
    } finally {
      setBusy(false);
    }
  };

  const revoke = (c) => {
    if (!window.confirm(`Thu hồi token của ${c.deviceCode}? Agent trên điện thoại sẽ bị từ chối ngay.`)) return;
    run(() => cameraApi.revokeToken(c.deviceCode), `Đã thu hồi token ${c.deviceCode}`);
  };

  const changeLifecycle = (c, to) => {
    if (to === 'DECOMMISSIONED' && !window.confirm(`Ngừng sử dụng ${c.deviceCode}? Token sẽ bị thu hồi và không thể kích hoạt lại.`)) return;
    run(() => devicesApi.changeLifecycle(c.id, to), `${c.deviceCode}: ${LIFE_LABEL[to] || to}`);
  };

  return (
    <div className="entity-page">
      <PageHeader title="Camera" subtitle="Điện thoại chạy agent chụp ảnh lá, gửi qua HTTP bằng camera token">
        <button className="secondary-button" onClick={load}><RefreshCw size={14} /> Làm mới</button>
        {canAdmin && <button className="primary-button" onClick={() => setDialog('register')}><Plus size={15} /> Thêm Camera</button>}
      </PageHeader>

      {error && <div className="notice notice--error">{error}<button onClick={() => setError('')}>×</button></div>}
      {notice && <div className="notice notice--success">{notice}<button onClick={() => setNotice('')}>×</button></div>}
      {storage && (
        <div className="notice notice--info">
          Chế độ lưu ảnh: {storage === 'ai-cloudinary' ? 'AI + Cloudinary (kết quả xem ở AI Chẩn Đoán)' : 'Lưu trên đĩa server (chưa cấu hình AI/Cloudinary)'}
        </div>
      )}

      <div className={`entity-workspace ${selected ? 'with-side-panel camera-workspace' : ''}`}>
        <div className="entity-content">
          <div className="toolbar"><span className="filter-count">{cameras.length} Camera · {onlineCount} trực tuyến</span></div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Mã</th><th>Tên / Vị trí</th><th>Kết nối</th><th>Vòng đời</th><th>Token</th><th>Ảnh gần nhất</th><th>Ảnh / AI</th></tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="muted-text">Đang tải…</td></tr>}
                {!loading && cameras.length === 0 && (
                  <tr><td colSpan={7} className="muted-text">{canAdmin ? 'Chưa có Camera. Bấm “Thêm Camera” để bắt đầu.' : 'Bạn chưa được gán Camera nào.'}</td></tr>
                )}
                {cameras.map((c) => (
                  <tr key={c.id} onClick={() => setSelectedId(c.id)} className={selectedId === c.id ? 'selected-row' : ''}>
                    <td><code>{c.deviceCode}</code></td>
                    <td><strong>{c.name}</strong><small className="table-sub">{c.location || '—'}</small></td>
                    <td>
                      <span className={`device-state device-state--${c.isOnline ? 'online' : 'offline'}`}>
                        {c.isOnline ? <Wifi size={13} /> : <WifiOff size={13} />}{c.isOnline ? 'Trực tuyến' : 'Ngoại tuyến'}
                      </span>
                      <small className="table-sub">{ago(c.lastSeenAt)}</small>
                    </td>
                    <td><span className={`status-badge ${LIFE_CLASS[c.lifecycle] || 'status-badge--warn'}`}>{LIFE_LABEL[c.lifecycle] || c.lifecycle}</span></td>
                    <td><span className={`status-badge ${TOKEN_CLASS[c.token?.status] || 'status-badge--warn'}`}>{TOKEN_LABEL[c.token?.status] || '—'}</span></td>
                    <td>{c.lastMediaAt ? ago(c.lastMediaAt) : '—'}</td>
                    <td>{c.mediaCount ?? 0} / {c.analysisCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {selected && (
          <aside className="side-detail camera-detail">
            <div className="side-detail__heading">
              <div><h2><Camera size={16} /> {selected.name}</h2><p><code>{selected.deviceCode}</code> · {selected.location || 'Chưa ghi vị trí'}</p></div>
              <button className="icon-button" onClick={() => setSelectedId(null)}><X size={16} /></button>
            </div>

            <dl className="camera-facts">
              <dt>Kết nối</dt><dd>{selected.isOnline ? 'Trực tuyến' : 'Ngoại tuyến'} · {ago(selected.lastSeenAt)}</dd>
              <dt>Heartbeat</dt><dd>mỗi {selected.heartbeatIntervalSeconds}s, offline sau {selected.offlineAfterSec}s</dd>
              <dt>Chu kỳ chụp</dt><dd>{selected.config?.captureIntervalSeconds ? `${selected.config.captureIntervalSeconds}s` : '—'}</dd>
              <dt>Vòng đời</dt><dd>{LIFE_LABEL[selected.lifecycle] || selected.lifecycle}{selected.lifecycleChangedAt && ` · ${timestamp(selected.lifecycleChangedAt)}`}</dd>
              <dt>Token</dt><dd>{TOKEN_LABEL[selected.token?.status]}{selected.token?.createdAt && ` · cấp ${timestamp(selected.token.createdAt)}`}{selected.token?.expiresAt && ` · hết hạn ${timestamp(selected.token.expiresAt)}`}</dd>
              <dt>Ảnh gần nhất</dt><dd>{timestamp(selected.lastMediaAt)}</dd>
              <dt>Đã nhận</dt><dd>{selected.mediaCount ?? 0} file local · {selected.analysisCount ?? 0} kết quả AI</dd>
            </dl>

            {selected.lifecycle === 'REGISTERED' && <div className="notice notice--info">Bước tiếp theo: cấp token rồi cấu hình agent trên điện thoại.</div>}
            {selected.lifecycle === 'PROVISIONED' && <div className="notice notice--info">Đã có token, đang chờ điện thoại gửi heartbeat đầu tiên.</div>}
            {['FAULT', 'MAINTENANCE'].includes(selected.lifecycle) && <div className="notice notice--warning">Server đang tạm từ chối ảnh; agent giữ ảnh trong hàng đợi và gửi lại khi kích hoạt lại.</div>}

            {canAdmin && selected.lifecycle !== 'DECOMMISSIONED' && (
              <div className="camera-actions">
                <button className="primary-button compact-button" disabled={busy} onClick={() => setDialog('token')}>
                  <KeyRound size={13} />{selected.token?.status === 'ACTIVE' ? 'Cấp lại token' : 'Cấp token'}
                </button>
                {selected.token?.status === 'ACTIVE' && (
                  <button className="secondary-button compact-button" disabled={busy} onClick={() => revoke(selected)}><ShieldOff size={13} />Thu hồi token</button>
                )}
                {(TRANSITIONS[selected.lifecycle] || []).map((to) => (
                  <button key={to} className="secondary-button compact-button" disabled={busy || (to === 'ACTIVE' && !selected.isOnline)}
                    title={to === 'ACTIVE' && !selected.isOnline ? 'Camera cần đang trực tuyến mới kích hoạt lại được' : undefined}
                    onClick={() => changeLifecycle(selected, to)}>
                    {ACTION_LABEL[to]}
                  </button>
                ))}
              </div>
            )}

            <Link className="secondary-button compact-button camera-ai-link" to={`/ai?deviceId=${selected.id}`}>
              <BrainCircuit size={13} />Xem {selected.analysisCount ?? 0} kết quả AI của Camera này
            </Link>

            <MediaGallery camera={selected} canAdmin={canAdmin} refreshKey={refreshKey} />
          </aside>
        )}
      </div>

      {dialog === 'register' && (
        <RegisterDialog
          onClose={() => setDialog(null)}
          onSaved={async (cam) => {
            setDialog(null);
            setNotice(`Đã tạo ${cam.deviceCode}. Bấm “Cấp token” để kết nối điện thoại.`);
            await load();
            setSelectedId(cam.id);
          }}
        />
      )}
      {dialog === 'token' && selected && <TokenDialog camera={selected} onClose={() => setDialog(null)} onIssued={load} />}
    </div>
  );
}
