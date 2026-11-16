import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Pencil, ShieldOff, ShieldCheck, Router, X, Save, KeyRound, Ticket, Copy, Check } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import * as nodesApi from '../api/nodes.api';
import { getSocket } from '../api/socket';
import '../styles/admin.css';

function NodeDialog({ initial, onClose, onSave }) {
  const [form,setForm]=useState({name:initial?.name||'',macAddress:initial?.macAddress||'',firmwareVersion:initial?.firmwareVersion||'',hardwareVersion:initial?.hardwareVersion||'',heartbeatTimeoutSec:initial?.heartbeatTimeoutSec||60});
  const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const set=(k,v)=>setForm((s)=>({...s,[k]:v}));
  const submit=async(e)=>{e.preventDefault();setBusy(true);setError('');try{await onSave(form);onClose();}catch(err){setError(err.message||'Không lưu được Node');}finally{setBusy(false);}};
  return <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)onClose();}}><form className="modal-card" onSubmit={submit}>
    <div className="modal-heading"><div><h2>{initial?'Cập nhật Node ESP32':'Thêm Node ESP32'}</h2><p>{initial?`Mã Node: ${initial.nodeCode}`:'Đăng ký bo ESP32 bằng MAC Wi-Fi.'}</p></div><button type="button" className="icon-button" onClick={onClose}><X size={18}/></button></div>
    {!initial&&<div className="notice notice--info">Nhập MAC Wi-Fi in từ Serial/đọc qua USB. Hệ thống trả về claim token một lần; tài khoản MQTT chỉ được cấp sau khi claim thành công.</div>}
    <div className="form-grid"><label>Tên Node<input required value={form.name} onChange={(e)=>set('name',e.target.value)} placeholder="Gateway khu A"/></label>{!initial&&<label>MAC Wi-Fi ESP32<input required value={form.macAddress} onChange={(e)=>set('macAddress',e.target.value)} placeholder="24:6F:28:AA:BB:CC" pattern="([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}"/></label>}<label>Firmware<input value={form.firmwareVersion} onChange={(e)=>set('firmwareVersion',e.target.value)} placeholder="v1.2.0"/></label><label>Hardware<input value={form.hardwareVersion} onChange={(e)=>set('hardwareVersion',e.target.value)} placeholder="ESP32-WROOM"/></label><label className="form-span-2">Timeout heartbeat (giây)<input type="number" min="1" max="3600" required value={form.heartbeatTimeoutSec} onChange={(e)=>set('heartbeatTimeoutSec',e.target.value)}/></label></div>
    {error&&<div className="notice notice--error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Hủy</button><button className="primary-button" disabled={busy}><Save size={15}/>{busy?'Đang lưu…':'Lưu Node'}</button></div>
  </form></div>;
}

function MqttCredentialsDialog({ credentials, nodeName, onClose }) {
  const [copied,setCopied]=useState('');
  if(!credentials)return null;
  const rows=[['Broker URL',credentials.brokerUrl],['Node ID',credentials.nodeCode],['Topic prefix',credentials.topicPrefix],['MQTT username',credentials.username],['MQTT password',credentials.password]];
  const copy=async(label,value)=>{try{await navigator.clipboard.writeText(String(value||''));setCopied(label);setTimeout(()=>setCopied(''),1800);}catch{setCopied('');}};
  const copyAll=()=>copy('Tất cả',rows.map(([k,v])=>`${k}: ${v}`).join('\n'));
  return <div className="modal-backdrop"><div className="modal-card">
    <div className="modal-heading"><div><h2>Tài khoản MQTT của Node</h2><p>{nodeName||credentials.nodeCode} — chỉ hiển thị mật khẩu ở lần cấp này</p></div><button type="button" className="icon-button" onClick={onClose}><X size={18}/></button></div>
    <div className="notice notice--success">Đã cấp tài khoản MQTT riêng và giới hạn quyền theo Topic của Node. Hãy sao chép thông tin và lưu vào cấu hình kết nối của ESP32 ngay bây giờ.</div>
    <div className="credentials-list">{rows.map(([label,value])=><div className="credential-row" key={label}><label>{label}</label><div><code>{value||'—'}</code><button type="button" className="icon-action" title={`Sao chép ${label}`} onClick={()=>copy(label,value)}><Copy size={14}/></button></div></div>)}</div>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={copyAll}>{copied==='Tất cả'?<Check size={15}/>:<Copy size={15}/>} Sao chép tất cả</button><button type="button" className="primary-button" onClick={onClose}>Tôi đã lưu thông tin</button></div>
    {copied&&<small className="muted-text">Đã sao chép {copied==='Tất cả'?'toàn bộ thông tin':copied}.</small>}
  </div></div>;
}

function ClaimTokenDialog({ claim, onClose }) {
  const [copied,setCopied]=useState(false);
  if(!claim)return null;
  return <div className="modal-backdrop"><div className="modal-card"><div className="modal-heading"><div><h2>Đăng ký ESP32</h2><p>{claim.nodeCode} · {claim.macAddress}</p></div><button className="icon-button" type="button" onClick={onClose}><X size={18}/></button></div><div className="notice notice--info">Token chỉ hiển thị lần này và hết hạn sau 30 phút. Nhập token vào ô "Claim token" trên cổng cấu hình WiFi của ESP32 (hoặc gõ <code>claim Cắm đúng ESP32, chạy công cụ claim qua HTTPS; MQTT credentials được cấp sau bước này.lt;tokenCắm đúng ESP32, chạy công cụ claim qua HTTPS; MQTT credentials được cấp sau bước này.gt;</code> trên Serial). ESP32 tự gọi Backend để nhận tài khoản MQTT — không cần xóa Flash hay đối soát broker.</div><div className="credentials-list"><div className="credential-row"><label>Claim token</label><div><code>{claim.token}</code><button type="button" className="icon-action" title="Sao chép token" onClick={async()=>{await navigator.clipboard.writeText(claim.token);setCopied(true);}}>{copied?<Check size={14}/>:<Copy size={14}/>}</button></div></div></div><div className="modal-actions"><button className="primary-button" onClick={onClose}>Đã ghi nhận token</button></div></div></div>;
}

const errorCode = (e) => e?.body?.error?.code || e?.body?.code || '';
const errorText = (e, fallback) => {
  const code = errorCode(e);
  const msg = e?.message || fallback;
  return code ? `[${code}] ${msg}` : msg;
};

function mqttAccountStatus(node) {
  if (node.isRevoked) return 'Tài khoản đã khóa — có thể cấp claim token mới';
  if (node.macAddress && !node.claimedAt && node.claimConsumedAt) {
    return node.claimFailedAt
      ? 'Claim trước thất bại, có thể cấp lại token'
      : 'Claim đang xử lý (quá 1 phút sẽ cho cấp lại token)';
  }
  if (node.mqttAccountEnabled) return 'Tài khoản đang bật';
  if (node.macAddress && !node.claimedAt) return 'Chờ claim';
  return 'Chưa sẵn sàng';
}

export default function Nodes(){
  const [recovering,setRecovering]=useState(null);const [nodes,setNodes]=useState([]);const [dialog,setDialog]=useState(false);const [credentials,setCredentials]=useState(null);const [claim,setClaim]=useState(null);const [credentialNodeName,setCredentialNodeName]=useState('');const [notice,setNotice]=useState('');const [error,setError]=useState('');const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{setLoading(true);try{const r=await nodesApi.list();setNodes(r.data||[]);setError('');}catch(e){setError(errorText(e,'Không tải được Node'));}finally{setLoading(false);}},[]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{const socket=getSocket();const refresh=()=>load();socket.on('node:status',refresh);return()=>socket.off('node:status',refresh);},[load]);
  const save=async(form)=>{if(dialog){await nodesApi.update(dialog.id,{name:form.name,firmwareVersion:form.firmwareVersion||null,hardwareVersion:form.hardwareVersion||null,heartbeatTimeoutSec:Number(form.heartbeatTimeoutSec)});setNotice(`Đã cập nhật Node ${dialog.nodeCode}.`);}else{const result=await nodesApi.create({name:form.name,macAddress:form.macAddress,firmwareVersion:form.firmwareVersion||null,hardwareVersion:form.hardwareVersion||null,heartbeatTimeoutSec:Number(form.heartbeatTimeoutSec)});const code=result.data?.nodeCode;setNotice(`Đã đăng ký ${code}; đang chờ claim qua USB.`);if(result.claimToken)setClaim({nodeCode:code,macAddress:result.data?.macAddress,token:result.claimToken});}await load();};
  // Node đã claim: Backend yêu cầu {reprovision:true} (xóa tài khoản MQTT cũ, ESP32 phải claim lại bằng token mới).
  const reissue=async(node)=>{
    const claimed=Boolean(node.claimedAt);
    const ask=(c)=>window.confirm(c
      ?`${node.nodeCode} đang dùng tài khoản MQTT đã claim. Cấp claim token mới sẽ XÓA tài khoản MQTT hiện tại; ESP32 mất kết nối cho tới khi nhập token mới (cổng cấu hình hoặc lệnh Serial "claim <token>"). Tiếp tục?`
      :`Cấp claim token mới cho ${node.nodeCode}? Token cũ sẽ hết hiệu lực.`);
    if(!ask(claimed))return;
    setError('');
    try{
      let result;
      try{result=await nodesApi.reissueClaimToken(node.id,claimed?{reprovision:true}:{});}
      catch(e){if(errorCode(e)!=='REPROVISION_CONFIRM_REQUIRED'||claimed||!ask(true))throw e;result=await nodesApi.reissueClaimToken(node.id,{reprovision:true});}
      setClaim({nodeCode:node.nodeCode,macAddress:node.macAddress,token:result.claimToken});
      setNotice(`Đã cấp lại claim token cho ${node.nodeCode}${result.brokerPurged?' (đã xóa tài khoản MQTT cũ trên broker)':''}.`);
      await load();
    }catch(e){setError(errorText(e,'Không cấp lại được token'));}
  };
  const reconcile=async(node)=>{
    setRecovering(node.id);setError('');setNotice('');
    try{const result=await nodesApi.reconcileClaim(node.id);await load();setNotice(node.isRevoked?'Broker xác nhận đã sạch; hãy bấm Khôi phục tài khoản MQTT để nhận token mới.':`${result.message||'Đã kiểm tra broker.'} Bấm biểu tượng chìa khóa để lấy token mới.`);}
    catch(e){setError(errorText(e,'Không kiểm tra được broker'));}
    finally{setRecovering(null);}
  };
  const revoke=async(node)=>{if(!window.confirm(`Thu hồi ${node.nodeCode}? Tài khoản MQTT riêng của Node sẽ bị vô hiệu hóa và phiên đang kết nối bị ngắt. Các Device trực thuộc sẽ không thể điều khiển qua Node này.`))return;try{await nodesApi.revoke(node.id);setNotice(`Đã thu hồi ${node.nodeCode}; tài khoản MQTT đã bị khóa.`);await load();}catch(e){setError(errorText(e,'Không thu hồi được Node'));}};
  const restore=async(node)=>{if(!window.confirm(`Khôi phục quyền kết nối cho ${node.nodeCode}? Node chỉ trực tuyến sau heartbeat mới.`))return;try{const result=await nodesApi.restore(node.id);setNotice(`Đã khôi phục ${node.nodeCode}; đang chờ Node kết nối và gửi heartbeat mới.`);if(result.claimToken)setClaim({nodeCode:node.nodeCode,macAddress:node.macAddress,token:result.claimToken});if(result.mqttCredentials){setCredentials(result.mqttCredentials);setCredentialNodeName(node.name||node.nodeCode);}await load();}catch(e){setError(errorText(e,'Không khôi phục được Node'));}};
  const rotate=async(node)=>{if(!window.confirm(`Cấp lại mật khẩu MQTT cho ${node.nodeCode}? Mật khẩu cũ sẽ bị vô hiệu hóa. Bạn phải cập nhật mật khẩu mới vào ESP32; Node có thể mất kết nối cho đến khi cập nhật xong.`))return;try{const result=await nodesApi.issueMqttCredentials(node.id);setCredentials(result.mqttCredentials);setCredentialNodeName(node.name||node.nodeCode);setNotice(`Đã cấp lại mật khẩu MQTT cho ${node.nodeCode}. Hãy cập nhật trên ESP32.`);await load();}catch(e){setError(errorText(e,'Không cấp lại được tài khoản MQTT'));}};
  return <div className="entity-page"><PageHeader title="Quản Lý Node ESP32" subtitle={`${nodes.length} Node — mỗi Node có một tài khoản MQTT riêng`}><button className="secondary-button" onClick={load}><RefreshCw size={14}/> Làm mới</button><button className="primary-button" onClick={()=>setDialog(null)}><Plus size={16}/> Thêm Node</button></PageHeader>
    {notice&&<div className="notice notice--success">{notice}<button onClick={()=>setNotice('')}>×</button></div>}{error&&<div className="notice notice--error">{error}<button onClick={()=>setError('')}>×</button></div>}
    <div className="table-wrap"><table className="data-table"><thead><tr><th>Node</th><th>Kết nối MQTT</th><th>Tài khoản MQTT</th><th>Firmware / Hardware</th><th>Heartbeat cuối</th><th>Timeout</th><th>Thiết bị</th><th>Thao tác</th></tr></thead><tbody>{nodes.map((n)=><tr key={n.id}><td><div className="user-name-cell"><span className="node-symbol"><Router size={17}/></span><div><strong>{n.name}</strong><small>{n.nodeCode}{n.macAddress?` · ${n.macAddress}`:''}</small></div></div></td><td><span className={`status-badge ${n.isRevoked?'status-badge--off':n.isOnline?'status-badge--ok':'status-badge--warn'}`}>{n.isRevoked?'Đã thu hồi':n.isOnline?'Trực tuyến':'Ngoại tuyến'}</span></td><td><code>{n.mqttUsername||'Chưa cấp'}</code><small className="table-sub">{mqttAccountStatus(n)}</small></td><td>{n.firmwareVersion||'—'}<small className="table-sub">{n.hardwareVersion||'Chưa rõ hardware'}</small></td><td>{n.lastHeartbeatAt?new Date(n.lastHeartbeatAt).toLocaleString('vi-VN'):'Chưa nhận heartbeat'}</td><td>{n.heartbeatTimeoutSec}s</td><td>{(n.devices||[]).length} thiết bị</td><td><div className="row-actions"><button className="icon-action" title="Sửa Node" onClick={()=>setDialog(n)}><Pencil size={14}/></button>{n.macAddress&&!n.claimedAt&&n.claimConsumedAt&&!n.claimFailedAt&&<button className="secondary-button" disabled={recovering!==null} onClick={()=>reconcile(n)}>{recovering===n.id?'Đang kiểm tra…':'Kiểm tra broker & mở lại claim'}</button>}{n.macAddress&&<button className="icon-action" title={n.claimedAt&&!n.isRevoked?'Cấp lại claim token (claim lại từ đầu, xóa tài khoản MQTT cũ)':'Cấp lại claim token'} onClick={()=>reissue(n)}><Ticket size={14}/></button>}{!n.isRevoked?<>{(n.claimedAt||!n.macAddress)&&<button className="icon-action" title="Cấp lại mật khẩu MQTT" onClick={()=>rotate(n)}><KeyRound size={14}/></button>}<button className="icon-action danger" title="Thu hồi Node và khóa MQTT" onClick={()=>revoke(n)}><ShieldOff size={14}/></button></>:<button className="icon-action" title="Khôi phục tài khoản MQTT" onClick={()=>restore(n)}><ShieldCheck size={14}/></button>}</div></td></tr>)}</tbody></table>{loading&&<div className="empty-state">Đang tải Node…</div>}{!loading&&!nodes.length&&<div className="empty-state">Chưa có Node. Thêm Node để hệ thống cấp tài khoản MQTT riêng.</div>}</div>
    {dialog!==false&&<NodeDialog key={dialog?.id||'new'} initial={dialog||null} onClose={()=>setDialog(false)} onSave={save}/>}
    <MqttCredentialsDialog credentials={credentials} nodeName={credentialNodeName} onClose={()=>setCredentials(null)}/>
    <ClaimTokenDialog claim={claim} onClose={()=>setClaim(null)}/>
  </div>;
}
