import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Users from './pages/Users';
import Nodes from './pages/Nodes';
import Alerts from './pages/Alerts';
import AIAnalyses from './pages/AIAnalyses';
import Diseases from './pages/Diseases';
import Cameras from './pages/Cameras';
import Audit from './pages/Audit';
import Login from './pages/Login';
import './styles/admin.css';

function RequireAuth({ children, roles }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="app-loading">Đang xác thực phiên đăng nhập…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}
function AppRoutes() {
  return <Routes>
    <Route path="/login" element={<Login/>}/>
    <Route element={<RequireAuth><Layout/></RequireAuth>}>
      <Route index element={<Dashboard/>}/>
      <Route path="devices" element={<Devices/>}/>
      <Route path="nodes" element={<RequireAuth roles={['admin']}><Nodes/></RequireAuth>}/>
      <Route path="users" element={<RequireAuth roles={['admin']}><Users/></RequireAuth>}/>
      <Route path="alerts" element={<Alerts/>}/>
      <Route path="diseases" element={<Diseases/>}/>
      <Route path="cameras" element={<Cameras/>}/>
        <Route path="ai" element={<AIAnalyses/>}/>
      <Route path="audit" element={<RequireAuth roles={['admin']}><Audit/></RequireAuth>}/>
      <Route path="*" element={<Navigate to="/" replace/>}/>
    </Route>
  </Routes>;
}
export default function App() { return <AuthProvider><AppRoutes/></AuthProvider>; }
