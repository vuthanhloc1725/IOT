import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Check, Edit2, FlaskConical, Leaf, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../auth/AuthContext';
import * as catalogApi from '../api/catalog.api';
import '../styles/admin.css';

const TYPE_LABEL = { BIOLOGICAL: 'Sinh học', CHEMICAL: 'Hóa học' };
const EMPTY_DISEASE = { modelLabel: '', nameVi: '', nameEn: '', isHealthy: false };
const EMPTY_TREATMENT = {
  name: '', type: 'BIOLOGICAL', instructions: '', activeIngredient: '',
  dosageText: '', intervalDays: '', sourceReference: '',
};

function ErrorNotice({ children, onClose }) {
  if (!children) return null;
  return <div className="notice notice--error">{children}<button type="button" onClick={onClose} aria-label="Đóng thông báo">×</button></div>;
}

function DiseaseModal({ initial, onClose, onSubmit, busy }) {
  const [form, setForm] = useState(initial || EMPTY_DISEASE);
  const editing = Boolean(initial?.id);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event) => {
    event.preventDefault();
    onSubmit({
      modelLabel: form.modelLabel.trim(),
      nameVi: form.nameVi.trim(),
      nameEn: String(form.nameEn || '').trim() || null,
      isHealthy: Boolean(form.isHealthy),
    });
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal-card" onSubmit={submit}>
      <div className="modal-heading"><div><h2>{editing ? 'Cập nhật bệnh' : 'Thêm bệnh mới'}</h2><p>Nhãn model phải khớp chính xác với nhãn mà dịch vụ AI trả về.</p></div><button className="icon-button" type="button" onClick={onClose}><X size={16}/></button></div>
      <div className="form-grid">
        <label className="form-span-2">Tên bệnh (tiếng Việt)<input required maxLength={120} value={form.nameVi} onChange={(e) => update('nameVi', e.target.value)} placeholder="Ví dụ: Bệnh mốc sương"/></label>
        <label className="form-span-2">Nhãn AI / Model label<input required maxLength={100} value={form.modelLabel} onChange={(e) => update('modelLabel', e.target.value)} placeholder="Ví dụ: Tomato___Late_blight"/><small className="field-hint">Dùng để ánh xạ kết quả dự đoán sang danh mục bệnh.</small></label>
        <label className="form-span-2">Tên tiếng Anh (không bắt buộc)<input maxLength={120} value={form.nameEn || ''} onChange={(e) => update('nameEn', e.target.value)} placeholder="Tomato late blight"/></label>
        <label className="checkbox-label form-span-2"><input type="checkbox" checked={Boolean(form.isHealthy)} onChange={(e) => update('isHealthy', e.target.checked)}/> Đây là nhãn lá khỏe mạnh (không có phương pháp điều trị)</label>
      </div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Hủy</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Đang lưu…' : editing ? 'Lưu thay đổi' : 'Tạo bệnh'}</button></div>
    </form>
  </div>;
}

function TreatmentModal({ initial, disease, onClose, onSubmit, busy }) {
  const [form, setForm] = useState(initial || EMPTY_TREATMENT);
  const editing = Boolean(initial?.id);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event) => {
    event.preventDefault();
    onSubmit({
      diseaseId: disease.id,
      name: String(form.name || '').trim(),
      type: form.type,
      instructions: String(form.instructions || '').trim(),
      activeIngredient: String(form.activeIngredient || '').trim() || null,
      dosageText: String(form.dosageText || '').trim() || null,
      intervalDays: form.intervalDays === '' ? null : Number(form.intervalDays),
      sourceReference: String(form.sourceReference || '').trim(),
    });
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal-card" onSubmit={submit}>
      <div className="modal-heading"><div><h2>{editing ? 'Cập nhật phương pháp' : 'Thêm phương pháp điều trị'}</h2><p>Phương pháp sẽ được gắn với bệnh: <strong>{disease.nameVi}</strong></p></div><button className="icon-button" type="button" onClick={onClose}><X size={16}/></button></div>
      <div className="form-grid">
        <label className="form-span-2">Tên phương pháp<input required maxLength={150} value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Ví dụ: Loại bỏ lá bệnh và vệ sinh vườn"/></label>
        <label>Nhóm điều trị<select value={form.type} onChange={(e) => update('type', e.target.value)}><option value="BIOLOGICAL">Sinh học</option><option value="CHEMICAL">Hóa học</option></select></label>
        <label>Chu kỳ (ngày)<input type="number" min="1" step="1" value={form.intervalDays ?? ''} onChange={(e) => update('intervalDays', e.target.value)} placeholder="Không bắt buộc"/></label>
        {form.type === 'CHEMICAL' && <label className="form-span-2">Hoạt chất<input required maxLength={120} value={form.activeIngredient || ''} onChange={(e) => update('activeIngredient', e.target.value)} placeholder="Tên hoạt chất"/></label>}
        <label className="form-span-2">Hướng dẫn điều trị<textarea required rows="4" value={form.instructions || ''} onChange={(e) => update('instructions', e.target.value)} placeholder="Mô tả các bước / cách áp dụng phương pháp…"/></label>
        <label className="form-span-2">Liều lượng / cách sử dụng<input maxLength={150} value={form.dosageText || ''} onChange={(e) => update('dosageText', e.target.value)} placeholder="Không bắt buộc"/></label>
        <label className="form-span-2">Tài liệu tham khảo<input required value={form.sourceReference || ''} onChange={(e) => update('sourceReference', e.target.value)} placeholder="URL hoặc tên tài liệu / nguồn khuyến nông"/></label>
      </div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Hủy</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Đang lưu…' : editing ? 'Lưu thay đổi' : 'Thêm phương pháp'}</button></div>
    </form>
  </div>;
}

export default function Diseases() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin';
  const [diseases, setDiseases] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [diseaseModal, setDiseaseModal] = useState(null);
  const [treatmentModal, setTreatmentModal] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await catalogApi.listDiseases();
      const rows = response.data || [];
      setDiseases(rows);
      setSelectedId((current) => current && rows.some((item) => String(item.id) === String(current))
        ? current : (rows[0]?.id ?? null));
      setError('');
    } catch (err) {
      setError(err.message || 'Không tải được danh mục bệnh');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filteredDiseases = useMemo(() => diseases.filter((disease) =>
    `${disease.nameVi || ''} ${disease.nameEn || ''} ${disease.modelLabel || ''}`
      .toLowerCase().includes(query.trim().toLowerCase())), [diseases, query]);
  const selectedDisease = diseases.find((disease) => String(disease.id) === String(selectedId)) || null;

  const saveDisease = async (payload) => {
    setBusy(true);
    try {
      if (diseaseModal?.id) {
        await catalogApi.updateDisease(diseaseModal.id, payload);
        setNotice('Đã cập nhật thông tin bệnh.');
        setSelectedId(diseaseModal.id);
      } else {
        const response = await catalogApi.createDisease(payload);
        setNotice('Đã tạo bệnh mới.');
        setSelectedId(response.data?.id ?? null);
      }
      setDiseaseModal(null);
      await load();
    } catch (err) {
      setError(err.message || 'Không lưu được thông tin bệnh');
    } finally {
      setBusy(false);
    }
  };

  const removeDisease = async (disease) => {
    if (!window.confirm(`Bạn có chắc muốn xóa bệnh “${disease.nameVi}”? Chỉ xóa được khi bệnh không có phương pháp điều trị và chưa được dùng trong lịch sử AI.`)) return;
    setBusy(true);
    try {
      await catalogApi.deleteDisease(disease.id);
      setNotice('Đã xóa bệnh.');
      setSelectedId(null);
      await load();
    } catch (err) {
      setError(err.message || 'Không xóa được bệnh');
    } finally {
      setBusy(false);
    }
  };

  const saveTreatment = async (payload) => {
    setBusy(true);
    try {
      if (treatmentModal?.id) {
        await catalogApi.updateTreatment(treatmentModal.id, payload);
        setNotice('Đã cập nhật phương pháp điều trị.');
      } else {
        await catalogApi.createTreatment(payload);
        setNotice('Đã thêm phương pháp điều trị.');
      }
      setTreatmentModal(null);
      await load();
    } catch (err) {
      setError(err.message || 'Không lưu được phương pháp điều trị');
    } finally {
      setBusy(false);
    }
  };

  const removeTreatment = async (treatment) => {
    if (!window.confirm(`Xóa phương pháp “${treatment.name}”?`)) return;
    setBusy(true);
    try {
      await catalogApi.deleteTreatment(treatment.id);
      setNotice('Đã xóa phương pháp điều trị.');
      await load();
    } catch (err) {
      setError(err.message || 'Không xóa được phương pháp điều trị');
    } finally {
      setBusy(false);
    }
  };

  return <div className="entity-page">
    <PageHeader title="Danh mục bệnh" subtitle="Quản lý bệnh cây trồng và nhiều phương pháp điều trị thuộc từng bệnh">
      <button className="secondary-button" onClick={load} disabled={loading}><RefreshCw size={14}/> Làm mới</button>
      {canManage && <button className="primary-button" onClick={() => setDiseaseModal({ ...EMPTY_DISEASE })}><Plus size={15}/> Thêm bệnh</button>}
    </PageHeader>

    <ErrorNotice onClose={() => setError('')}>{error}</ErrorNotice>
    {notice && <div className="notice notice--success"><Check size={14}/>{notice}<button type="button" onClick={() => setNotice('')}>×</button></div>}

    <div className={`entity-workspace disease-workspace ${selectedDisease ? 'with-side-panel' : ''}`}>
      <section className="entity-content">
        <div className="toolbar">
          <div className="disease-search"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm tên bệnh hoặc nhãn AI…"/></div>
          <span className="filter-count">{filteredDiseases.length} bệnh</span>
        </div>
        <div className="table-wrap">
          <table className="data-table disease-table">
            <thead><tr><th>Bệnh</th><th>Nhãn AI</th><th>Phương pháp</th><th>Phân loại</th></tr></thead>
            <tbody>
              {filteredDiseases.map((disease) => <tr key={disease.id} className={String(selectedId) === String(disease.id) ? 'selected-row' : ''} onClick={() => setSelectedId(disease.id)}>
                <td><strong>{disease.nameVi}</strong><small className="table-sub">{disease.nameEn || '—'}</small></td>
                <td><code>{disease.modelLabel}</code></td>
                <td>{disease.treatments?.length || 0}</td>
                <td><span className={`disease-kind ${disease.isHealthy ? 'disease-kind--healthy' : 'disease-kind--ill'}`}>{disease.isHealthy ? 'Lá khỏe mạnh' : 'Bệnh'}</span></td>
              </tr>)}
            </tbody>
          </table>
          {loading && <div className="empty-state">Đang tải danh mục bệnh…</div>}
          {!loading && !filteredDiseases.length && <div className="empty-state"><BookOpen size={23}/>Không có bệnh phù hợp với nội dung tìm kiếm.</div>}
        </div>
        <p className="catalog-footnote">Chọn một bệnh trong danh sách để xem và quản lý các phương pháp điều trị tương ứng.</p>
      </section>

      {selectedDisease && <aside className="side-detail disease-detail">
        <div className="side-detail__heading">
          <div><span className="detail-eyebrow">THÔNG TIN BỆNH</span><h2>{selectedDisease.nameVi}</h2><p>{selectedDisease.modelLabel}</p></div>
          <button className="icon-button" onClick={() => setSelectedId(null)} aria-label="Đóng chi tiết"><X size={16}/></button>
        </div>
        <div className="disease-meta"><div><span>Tên tiếng Anh</span><strong>{selectedDisease.nameEn || '—'}</strong></div><div><span>Loại nhãn</span><strong>{selectedDisease.isHealthy ? 'Lá khỏe mạnh' : 'Bệnh cây trồng'}</strong></div></div>
        {canManage && <div className="disease-toolbar">
          <button className="secondary-button compact-button" onClick={() => setDiseaseModal({ ...selectedDisease })}><Edit2 size={12}/> Sửa bệnh</button>
          <button className="danger-button compact-button" onClick={() => removeDisease(selectedDisease)} disabled={busy}><Trash2 size={12}/> Xóa bệnh</button>
        </div>}
        <div className="treatment-heading"><div><h3><FlaskConical size={15}/> Phương pháp điều trị</h3><span>{selectedDisease.treatments?.length || 0} phương pháp</span></div>
          {canManage && !selectedDisease.isHealthy && <button className="primary-button compact-button" onClick={() => setTreatmentModal({ ...EMPTY_TREATMENT })}><Plus size={13}/> Thêm</button>}
        </div>
        {selectedDisease.isHealthy ? <div className="empty-state disease-empty"><Leaf size={22}/>Đây là nhãn lá khỏe mạnh nên không có phương pháp điều trị.</div> : (selectedDisease.treatments || []).length === 0
          ? <div className="empty-state disease-empty">Chưa có phương pháp điều trị cho bệnh này.</div>
          : <div className="treatment-card-list">{selectedDisease.treatments.map((treatment) => <article className="treatment-card" key={treatment.id}>
            <div className="treatment-card__top"><div><span className={`treatment-type treatment-type--${treatment.type?.toLowerCase()}`}>{TYPE_LABEL[treatment.type] || treatment.type}</span><h4>{treatment.name}</h4></div>
              {canManage && <div className="row-actions"><button className="icon-action" title="Sửa phương pháp" onClick={() => setTreatmentModal({ ...treatment })}><Edit2 size={14}/></button><button className="icon-action danger" title="Xóa phương pháp" onClick={() => removeTreatment(treatment)} disabled={busy}><Trash2 size={14}/></button></div>}
            </div>
            <p>{treatment.instructions}</p>
            {treatment.activeIngredient && <div className="treatment-detail-line"><span>Hoạt chất</span><strong>{treatment.activeIngredient}</strong></div>}
            {treatment.dosageText && <div className="treatment-detail-line"><span>Liều lượng</span><strong>{treatment.dosageText}</strong></div>}
            {treatment.intervalDays && <div className="treatment-detail-line"><span>Chu kỳ</span><strong>{treatment.intervalDays} ngày</strong></div>}
            <small className="treatment-source">Nguồn: {treatment.sourceReference}</small>
          </article>)}</div>}
        {!canManage && <p className="catalog-footnote">Bạn có quyền xem danh mục. Chỉ Admin được thêm, sửa hoặc xóa dữ liệu.</p>}
      </aside>}
    </div>

    {diseaseModal && <DiseaseModal initial={diseaseModal} onClose={() => setDiseaseModal(null)} onSubmit={saveDisease} busy={busy}/>}
    {treatmentModal && selectedDisease && <TreatmentModal initial={treatmentModal} disease={selectedDisease} onClose={() => setTreatmentModal(null)} onSubmit={saveTreatment} busy={busy}/>}
  </div>;
}
