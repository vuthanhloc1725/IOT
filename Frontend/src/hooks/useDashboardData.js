import { useCallback, useEffect, useState } from 'react';
import * as dashboardApi from '../api/dashboard.api';
import * as devicesApi from '../api/devices.api';
import * as alertsApi from '../api/alerts.api';
import * as analysesApi from '../api/analyses.api';
import { getSocket } from '../api/socket';
import { summarizeAlerts, toDeviceCard, eventFromAlert } from '../api/mappers';

const EMPTY_SUMMARY = { critical: 0, warning: 0, info: 0 };
const REFRESH_EVENTS = ['alert:new', 'alert:update', 'device:update', 'analysis:new', 'node:status'];
export default function useDashboardData() {
  const [alertSummary, setAlertSummary] = useState(EMPTY_SUMMARY);
  const [aiDetections, setAiDetections] = useState(0);
  const [devices, setDevices] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const results = await Promise.allSettled([
      dashboardApi.getSummary(), devicesApi.list({ limit: 100 }), alertsApi.list({ limit: 8 }), analysesApi.list({ from: since, limit: 100 }),
    ]);
    if (results[0].status === 'fulfilled') setAlertSummary(summarizeAlerts(results[0].value.data?.openAlertsBySeverity || []));
    if (results[1].status === 'fulfilled') setDevices((results[1].value.data || []).map(toDeviceCard));
    if (results[2].status === 'fulfilled') setEvents((results[2].value.data || []).map(eventFromAlert));
    if (results[3].status === 'fulfilled') setAiDetections((results[3].value.data || []).length);
    const failures = results.filter((r) => r.status === 'rejected');
    setError(failures.length === results.length ? (failures[0]?.reason?.message || 'Không tải được dữ liệu dashboard') : '');
  }, []);

  useEffect(() => {
    load();
    const socket = getSocket(); let timer;
    const refresh = () => { window.clearTimeout(timer); timer = window.setTimeout(() => load(), 450); };
    REFRESH_EVENTS.forEach((event) => socket.on(event, refresh));
    return () => { window.clearTimeout(timer); REFRESH_EVENTS.forEach((event) => socket.off(event, refresh)); };
  }, [load]);
  return { alertSummary, aiDetections, devices, events, error, refresh: load };
}
