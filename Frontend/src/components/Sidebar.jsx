import { NavLink } from 'react-router-dom';
import { Wifi, LayoutDashboard, Cpu, Users, Bell, BrainCircuit, ScrollText, Router, LogOut } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import './Sidebar.css';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/devices', label: 'Thiết Bị', icon: Cpu },
  { to: '/nodes', label: 'Node ESP32', icon: Router, admin: true },
  { to: '/users', label: 'Người Dùng', icon: Users, admin: true },
  { to: '/alerts', label: 'Cảnh Báo', icon: Bell, badge: true },
  { to: '/ai', label: 'AI Chẩn Đoán', icon: BrainCircuit },
  { to: '/audit', label: 'Audit Log', icon: ScrollText, admin: true },
];
const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };
export default function Sidebar({ alertCount = 0 }) {
  const { user, logout } = useAuth();
  const items = NAV_ITEMS.filter((item) => !item.admin || user?.role === 'admin');
  return <aside className="sidebar">
    <div className="sidebar__brand"><div className="sidebar__logo"><Wifi size={18} strokeWidth={2.5}/></div><div><span className="sidebar__name">IoT Control</span><small className="sidebar__version">v2.4.1</small></div></div>
    <nav className="sidebar__nav">{items.map(({to,label,icon:Icon,end,badge})=><NavLink key={to} to={to} end={end} className="sidebar__link" title={label}><Icon size={18}/><span className="sidebar__label">{label}</span>{badge && alertCount>0 && <span className="sidebar__badge">{alertCount}</span>}</NavLink>)}</nav>
    <div className="sidebar__footer"><small className="sidebar__eyebrow">TÀI KHOẢN ĐANG ĐĂNG NHẬP</small><div className="sidebar__current-user"><span className="sidebar__avatar">{(user?.fullName || user?.username || 'U').slice(0,1).toUpperCase()}</span><div><strong>{user?.fullName || user?.username}</strong><small>{ROLE_LABEL[user?.role] || user?.role}</small></div></div><button className="sidebar__logout" onClick={logout}><LogOut size={15}/> Đăng xuất</button></div>
  </aside>;
}
