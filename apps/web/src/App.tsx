import { useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, BadgeCheck, Bell, CalendarDays, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleHelp, CirclePlay, Clock3, Cloud, Cpu, Database,
  FileVideo2, Film, Gauge, HardDrive, Headphones, LayoutDashboard, Link2, ListMusic,
  LoaderCircle, LockKeyhole, LogOut, Menu, Monitor, MoreHorizontal, Pencil, Play, Plus,
  Radio, RefreshCw, Search, Server, Settings, ShieldCheck, Sparkles, Square, Trash2,
  Upload, UserRound, Users, Video as VideoIcon, Wifi, X, Youtube, Zap,
} from 'lucide-react';
import { API, api, ApiError, uploadVideo } from './api';
import type {
  AdminOverview, Destination, Health, LiveSession, Notification, Page, Playlist,
  Schedule, User, Video, YoutubeStatus,
} from './types';

const navItems: Array<{ key: Page; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { key: 'videos', label: 'Video library', icon: Film },
  { key: 'playlists', label: 'Playlists', icon: ListMusic },
  { key: 'live', label: 'Live studio', icon: Radio },
  { key: 'schedule', label: 'Schedule', icon: CalendarDays },
  { key: 'youtube', label: 'YouTube', icon: Youtube },
  { key: 'settings', label: 'Settings', icon: Settings },
];

const pageNames: Record<Page, string> = {
  dashboard: 'Overview', videos: 'Video library', playlists: 'Playlists', live: 'Live studio',
  schedule: 'Schedule', youtube: 'YouTube connection', settings: 'Settings', admin: 'Admin console',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatDate(value: string | null | undefined, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '—';
  return formatDuration((Date.now() - new Date(startedAt).getTime()) / 1000);
}

function toastMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

type ToastState = { id: number; message: string; tone: 'success' | 'error' | 'info' };

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand-mark ${compact ? 'brand-mark-small' : ''}`} aria-label="Maya Cloud Live">
      <div className="brand-symbol"><span>M</span><i /></div>
      {!compact && <div className="brand-copy"><strong>maya</strong><small>CLOUD LIVE</small></div>}
    </div>
  );
}

function StatusBadge({ status, label }: { status: string; label?: string }) {
  const variant = status === 'live' || status === 'healthy' || status === 'ready' || status === 'connected'
    ? 'good'
    : status === 'failed' || status === 'error'
      ? 'bad'
      : ['queued', 'starting', 'reconnecting', 'stopping', 'scheduled', 'processing'].includes(status)
        ? 'warn'
        : 'neutral';
  const text = label || status.replaceAll('_', ' ');
  return <span className={`status-badge status-${variant}`}><i />{text}</span>;
}

function SectionTitle({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="section-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="section-title-action">{action}</div>}
    </div>
  );
}

function PrimaryButton({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button button-primary ${className}`} {...props}>{children}</button>;
}

function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal-card ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-header">
          <div><h3 id="modal-title">{title}</h3>{description && <p>{description}</p>}</div>
          <button className="icon-button subtle" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SignIn({ health, onLogin }: { health: Health | null; onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const preview = health?.mode === 'preview';

  useEffect(() => {
    if (preview) {
      setEmail('demo@mayastream.local');
      setPassword('MayaDemo!2026');
    }
  }, [preview]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } });
      onLogin(result.user);
    } catch (reason) {
      setError(toastMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <div className="auth-art">
        <div className="auth-glow auth-glow-one" /><div className="auth-glow auth-glow-two" />
        <BrandMark />
        <div className="auth-art-copy">
          <span className="live-kicker"><i /> SERVER-SIDE BROADCASTING</span>
          <h1>Your content.<br /><em>Always on air.</em></h1>
          <p>One calm control room for every stream. Your cloud worker keeps broadcasting, even when your phone is offline.</p>
          <div className="auth-art-stats">
            <div><strong>9:16</strong><span>VERTICAL</span></div><div><strong>16:9</strong><span>HORIZONTAL</span></div><div><strong>24/7</strong><span>READY BY DESIGN</span></div>
          </div>
        </div>
        <div className="auth-footnote"><ShieldCheck size={15} /> Your stream keys stay encrypted on the server.</div>
      </div>
      <div className="auth-panel">
        <div className="auth-mobile-brand"><BrandMark /></div>
        <div className="auth-card">
          <div className="auth-icon"><LockKeyhole size={20} /></div>
          <div className="eyebrow">WELCOME BACK</div>
          <h2>Sign in to Maya</h2>
          <p className="muted">Open your cloud broadcast workspace.</p>
          {preview && <div className="preview-credentials"><Sparkles size={16} /><span><strong>Local preview access</strong><small>Demo credentials are filled in for you.</small></span></div>}
          {error && <div className="form-error"><CircleHelp size={16} />{error}</div>}
          <form onSubmit={submit} className="stack-form">
            <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
            <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /></label>
            <PrimaryButton className="button-full" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={17} /> Signing in…</> : <>Sign in <ArrowRight size={17} /></>}</PrimaryButton>
          </form>
          <div className="auth-secure"><span /><small>Encrypted session · protected workspace</small></div>
        </div>
        <div className="auth-footer">Maya Cloud Live <span>·</span> Server-side streaming control</div>
      </div>
    </main>
  );
}

function Sidebar({ page, user, health, onNavigate, onLogout, open, onClose }: {
  page: Page; user: User; health: Health | null; onNavigate: (page: Page) => void; onLogout: () => void; open: boolean; onClose: () => void;
}) {
  return (
    <>
      {open && <button className="mobile-scrim" onClick={onClose} aria-label="Close menu" />}
      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand"><BrandMark /><button className="icon-button mobile-close" onClick={onClose} aria-label="Close menu"><X size={18} /></button></div>
        <div className="workspace-switcher"><div className="workspace-avatar">M</div><div><strong>My workspace</strong><small>Personal studio</small></div><ChevronDown size={14} /></div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map(({ key, label, icon: Icon }) => (
            <button key={key} className={`nav-item ${page === key ? 'nav-active' : ''}`} onClick={() => { onNavigate(key); onClose(); }}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
              {key === 'live' && <i className="nav-live-dot" />}
            </button>
          ))}
        </nav>
        {user.role === 'admin' && <>
          <div className="sidebar-label sidebar-label-admin">MANAGEMENT</div>
          <button className={`nav-item ${page === 'admin' ? 'nav-active' : ''}`} onClick={() => { onNavigate('admin'); onClose(); }}>
            <ShieldCheck size={18} strokeWidth={1.8} /><span>Admin console</span>
          </button>
        </>}
        <div className="sidebar-bottom">
          <div className={`worker-mini ${health?.mode === 'persistent' && health.workerOnline ? 'worker-ready' : ''}`}>
            <div className="worker-mini-top"><span className="worker-mini-icon"><Server size={15} /></span><span className="worker-live-indicator" /></div>
            <strong>{health?.mode === 'preview' ? 'Preview environment' : health?.workerOnline ? 'Worker connected' : 'Worker offline'}</strong>
            <small>{health?.mode === 'persistent' ? 'Cloud services available' : 'Streaming is not enabled'}</small>
            <div className="worker-mini-bar"><i /></div>
          </div>
          <div className="sidebar-account">
            <div className="user-avatar">{user.name.slice(0, 1).toUpperCase()}</div>
            <div className="user-account-copy"><strong>{user.name}</strong><small>{user.role === 'admin' ? 'Workspace admin' : 'Creator'}</small></div>
            <button className="icon-button subtle" onClick={onLogout} title="Sign out" aria-label="Sign out"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>
    </>
  );
}

function Header({ page, user, health, notifications, onMenu, onMarkRead, onToast }: {
  page: Page; user: User; health: Health | null; notifications: Notification[]; onMenu: () => void; onMarkRead: () => void; onToast: (message: string, tone?: ToastState['tone']) => void;
}) {
  const [noticeOpen, setNoticeOpen] = useState(false);
  const unread = notifications.filter((item) => !item.readAt).length;
  return (
    <header className="topbar">
      <div className="topbar-left"><button className="icon-button menu-button" onClick={onMenu} aria-label="Open menu"><Menu size={20} /></button><div><span className="topbar-crumb">MAYA STUDIO <ChevronRight size={12} /> WORKSPACE</span><h1>{pageNames[page]}</h1></div></div>
      <div className="topbar-actions">
        <div className={`connection-pill ${health?.status === 'ok' ? 'connection-good' : ''}`}><span />{health?.mode === 'preview' ? 'PREVIEW MODE' : health?.status === 'ok' ? 'SYSTEM ONLINE' : 'CONNECTING'}</div>
        <div className="notification-wrap">
          <button className={`icon-button notification-button ${unread ? 'has-unread' : ''}`} onClick={() => setNoticeOpen((value) => !value)} aria-label="Notifications"><Bell size={18} />{unread > 0 && <i />}</button>
          {noticeOpen && <div className="notice-popover">
            <div className="notice-heading"><div><strong>Notifications</strong><small>{unread ? `${unread} unread` : 'You are all caught up'}</small></div><button className="text-button" onClick={() => { onMarkRead(); setNoticeOpen(false); }}>Mark all read</button></div>
            {notifications.length === 0 ? <div className="notice-empty"><Bell size={18} /><span>Stream updates will show up here.</span></div> : notifications.slice(0, 5).map((item) => (
              <div className={`notice-item ${item.readAt ? '' : 'notice-unread'}`} key={item.id}><span className="notice-dot" /><div><strong>{item.title}</strong><p>{item.message}</p><small>{formatDate(item.createdAt, { hour: 'numeric', minute: '2-digit' })}</small></div></div>
            ))}
          </div>}
        </div>
        <div className="topbar-user"><div className="user-avatar small-avatar">{user.name.slice(0, 1).toUpperCase()}</div><span>{user.name.split(' ')[0]}</span><ChevronDown size={14} /></div>
      </div>
    </header>
  );
}

function Dashboard({ user, health, videos, playlists, session, sessions, destination, onNavigate, onSelectVideo, onStartVideo }: {
  user: User; health: Health | null; videos: Video[]; playlists: Playlist[]; session: LiveSession | null; sessions: LiveSession[]; destination: Destination | null;
  onNavigate: (page: Page) => void; onSelectVideo: (video: Video) => void; onStartVideo: (video: Video) => void;
}) {
  const readyVideos = videos.filter((video) => video.status === 'ready');
  const totalDuration = videos.reduce((total, video) => total + video.durationSeconds, 0);
  const isLive = session?.status === 'live';
  const active = session && ['live', 'starting', 'queued', 'reconnecting', 'stopping'].includes(session.status) ? session : null;
  const completed = sessions.filter((item) => item.status === 'ended').length;
  const name = user.name.split(' ')[0];
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="page-content dashboard-page">
      <section className={`welcome-banner ${active ? 'welcome-live' : ''}`}>
        <div className="welcome-orbit orbit-one" /><div className="welcome-orbit orbit-two" /><div className="welcome-orbit orbit-three" />
        <div className="welcome-copy">
          <div className="live-kicker"><span className={active ? 'kicker-dot is-live' : 'kicker-dot'} />{active ? 'BROADCAST IN PROGRESS' : 'YOUR BROADCAST CONTROL ROOM'}</div>
          <h2>{active ? <>You're on air,<br /><em>{name}.</em></> : <>{greeting},<br /><em>{name}.</em></>}</h2>
          <p>{active ? `${session?.liveType === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'} · ${session?.videoTitle || session?.playlistName || 'Your stream'} is running in the cloud.` : 'Your videos are ready. One click starts a stream that keeps running in the cloud.'}</p>
          <div className="welcome-actions">
            <PrimaryButton onClick={() => onNavigate('live')}>{active ? <><Radio size={17} /> Open live studio</> : <><span className="button-live-dot" /> Start a stream <ArrowRight size={16} /></>}</PrimaryButton>
            <button className="button button-ghost" onClick={() => onNavigate('videos')}><Upload size={16} /> Upload video</button>
          </div>
        </div>
        <div className="welcome-visual" aria-hidden="true">
          <div className="signal-rings"><div className="signal-ring signal-ring-outer" /><div className="signal-ring signal-ring-middle" /><div className="signal-ring signal-ring-inner"><Radio size={31} /></div><span className="signal-point point-one" /><span className="signal-point point-two" /><span className="signal-point point-three" /></div>
          <div className="floating-chip chip-a"><span className="chip-pulse" />{active ? 'LIVE' : 'MAYA CLOUD'}</div>
          <div className="floating-chip chip-b"><Wifi size={14} /> RTMP READY</div>
        </div>
      </section>

      {(health?.mode === 'preview' || (health?.mode === 'persistent' && !health.workerOnline)) && <div className="preview-notice"><Sparkles size={17} /><span><strong>{health?.mode === 'preview' ? 'Dashboard preview' : 'Streaming worker offline'}</strong> — {health?.mode === 'preview' ? 'Real broadcasting needs PostgreSQL, Redis, an FFmpeg worker and a configured YouTube destination.' : 'Start the FFmpeg worker before launching a stream.'}</span><button onClick={() => onNavigate('settings')}>View setup <ArrowRight size={14} /></button></div>}

      <div className="stats-grid">
        <StatCard icon={<Film size={18} />} label="READY VIDEOS" value={String(readyVideos.length).padStart(2, '0')} detail={`${videos.length} items in your library`} accent="mint" trend={<span className="stat-trend"><ArrowUpRight size={13} /> Library</span>} />
        <StatCard icon={<Clock3 size={18} />} label="CONTENT HOURS" value={(totalDuration / 3600).toFixed(1)} detail="Total playable runtime" accent="blue" trend={<span className="stat-trend stat-trend-blue"><Zap size={13} /> In the cloud</span>} />
        <StatCard icon={<ListMusic size={18} />} label="PLAYLISTS" value={String(playlists.length).padStart(2, '0')} detail="Sequential stream plans" accent="violet" trend={<span className="stat-trend stat-trend-violet"><Activity size={13} /> Loop ready</span>} />
        <StatCard icon={<Radio size={18} />} label="COMPLETED LIVES" value={String(completed).padStart(2, '0')} detail={active ? '1 session needs attention' : 'All sessions in one place'} accent="orange" trend={<span className={`stat-trend ${isLive ? '' : 'stat-trend-muted'}`}><span className="tiny-status-dot" /> {isLive ? 'On air' : 'Standby'}</span>} />
      </div>

      <div className="dashboard-grid-main">
        <section className="panel live-panel">
          <div className="panel-heading"><div><div className="eyebrow">LIVE OVERVIEW</div><h3>{active ? 'Current broadcast' : 'Ready when you are'}</h3></div><button className="icon-button subtle" onClick={() => onNavigate('live')} aria-label="Open live studio"><ArrowUpRight size={17} /></button></div>
          {active ? <div className="active-live-overview">
            <div className="active-live-preview"><div className="live-preview-ambient"><div className="preview-bars"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="preview-play"><Radio size={21} /></div></div><StatusBadge status={active.status} label={active.status === 'live' ? 'ON AIR' : active.status} /></div>
            <div className="active-live-info"><div className="live-title-row"><div><strong>{active.videoTitle || active.playlistName || 'Untitled stream'}</strong><small>{active.destination} · {active.liveType === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'}</small></div><button className="text-button" onClick={() => onNavigate('live')}>Manage <ArrowRight size={14} /></button></div>
              <div className="live-metrics"><Metric label="DURATION" value={formatUptime(active.startedAt)} /><Metric label="RESOLUTION" value={active.liveType === 'vertical' ? '1080 × 1920' : '1920 × 1080'} /><Metric label="HEALTH" value={active.healthStatus === 'healthy' ? 'Healthy' : active.healthStatus === 'warning' ? 'Reconnecting' : 'Starting'} good={active.healthStatus === 'healthy'} /></div>
            </div>
          </div> : <div className="empty-live-state"><div className="empty-live-icon"><Radio size={22} /></div><div><strong>No live session yet</strong><p>Choose a video, select a format, and let the server take it from here.</p></div><button className="small-outline-button" onClick={() => onNavigate('live')}>Open studio <ArrowRight size={14} /></button></div>}
          <div className="live-panel-footer"><div className="server-health"><span className={`health-indicator ${health?.mode === 'persistent' && health.workerOnline ? 'health-ok' : 'health-preview'}`} /><span>SERVER WORKER</span><strong>{health?.mode === 'preview' ? 'Preview only' : health?.workerOnline ? 'Ready' : 'Worker offline'}</strong></div><div className="footer-separator" /><div className="server-health"><span className={`health-indicator ${destination?.youtubeConnected || destination?.streamKeyConfigured ? 'health-ok' : 'health-preview'}`} /><span>DESTINATION</span><strong>{destination?.youtubeConnected ? destination.channelTitle : destination?.streamKeyConfigured ? 'RTMP configured' : 'Not connected'}</strong></div></div>
        </section>

        <section className="panel profiles-panel">
          <div className="panel-heading"><div><div className="eyebrow">STREAM PROFILES</div><h3>One platform, two formats</h3></div><span className="spark-icon"><Sparkles size={16} /></span></div>
          <button className="profile-card vertical-profile" onClick={() => onNavigate('live')}>
            <div className="profile-shape vertical-shape"><span /><i /><b /></div><div className="profile-copy"><strong>Vertical live</strong><small>9:16 · 1080 × 1920</small><small className="profile-use">Mobile · Shorts-style</small></div><ChevronRight size={17} />
          </button>
          <button className="profile-card horizontal-profile" onClick={() => onNavigate('live')}>
            <div className="profile-shape horizontal-shape"><span /><i /><b /></div><div className="profile-copy"><strong>Horizontal live</strong><small>16:9 · 1920 × 1080</small><small className="profile-use">TV · Desktop · Long-form</small></div><ChevronRight size={17} />
          </button>
          <div className="profile-note"><ShieldCheck size={15} /><span>Source is fitted to frame — no stretched faces.</span></div>
        </section>
      </div>

      <div className="dashboard-grid-bottom">
        <section className="panel recent-panel">
          <div className="panel-heading"><div><div className="eyebrow">YOUR LIBRARY</div><h3>Recently added</h3></div><button className="text-button" onClick={() => onNavigate('videos')}>View library <ArrowRight size={14} /></button></div>
          {videos.length === 0 ? <EmptyHint title="Your library is empty" text="Upload a video to create your first broadcast." action="Upload video" onClick={() => onNavigate('videos')} /> : <div className="recent-list">{videos.slice(0, 4).map((video, index) => <div className="recent-row" role="button" tabIndex={0} key={video.id} onClick={() => onSelectVideo(video)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectVideo(video); } }}><VideoCover video={video} index={index} compact /><div className="recent-meta"><strong>{video.title}</strong><small>{formatDuration(video.durationSeconds)} <span>·</span> {video.width} × {video.height}</small></div><span className={`orientation-tag ${video.liveType}`}>{video.liveType === 'vertical' ? '9:16' : '16:9'}</span><button className="row-action" onClick={(event) => { event.stopPropagation(); onStartVideo(video); }} aria-label={`Start ${video.title}`}><Play size={15} /></button></div>)}</div>}
        </section>
        <section className="panel setup-panel">
          <div className="panel-heading"><div><div className="eyebrow">QUICK SETUP</div><h3>Broadcast checklist</h3></div><BadgeCheck size={19} className="muted-icon" /></div>
          <div className="checklist">
            <ChecklistItem done={videos.length > 0} number="01" title="Add your first video" text={videos.length ? `${videos.length} videos in your library` : 'MP4, MOV or MKV · up to 5 GB'} onClick={() => onNavigate('videos')} />
            <ChecklistItem done={Boolean(destination?.youtubeConnected || destination?.streamKeyConfigured)} number="02" title="Connect YouTube" text={destination?.youtubeConnected ? destination.channelTitle || 'Account connected' : destination?.streamKeyConfigured ? 'Manual RTMP key saved' : 'OAuth or manual RTMP key'} onClick={() => onNavigate('youtube')} />
            <ChecklistItem done={health?.mode === 'persistent' && health.workerOnline} number="03" title="Start your cloud worker" text={health?.workerOnline ? 'Worker heartbeat received' : 'Needs PostgreSQL + Redis + FFmpeg worker'} onClick={() => onNavigate('settings')} />
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, detail, accent, trend }: { icon: ReactNode; label: string; value: string; detail: string; accent: string; trend: ReactNode }) {
  return <div className={`stat-card stat-${accent}`}><div className="stat-top"><div className="stat-icon">{icon}</div>{trend}</div><div className="stat-value">{value}</div><div className="stat-label">{label}</div><div className="stat-detail">{detail}</div><div className="stat-sparkline"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>;
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="metric"><span>{label}</span><strong className={good ? 'metric-good' : ''}>{value}</strong></div>;
}

function EmptyHint({ title, text, action, onClick }: { title: string; text: string; action?: string; onClick?: () => void }) {
  return <div className="empty-hint"><div className="empty-hint-icon"><FileVideo2 size={19} /></div><div><strong>{title}</strong><p>{text}</p></div>{action && <button className="text-button" onClick={onClick}>{action} <ArrowRight size={14} /></button>}</div>;
}

function ChecklistItem({ done, number, title, text, onClick }: { done: boolean; number: string; title: string; text: string; onClick: () => void }) {
  return <button className="checklist-item" onClick={onClick}><span className={`checklist-check ${done ? 'checklist-done' : ''}`}>{done ? <Check size={13} /> : number}</span><span className="checklist-copy"><strong>{title}</strong><small>{text}</small></span><ChevronRight size={15} /></button>;
}

function VideoCover({ video, index = 0, compact = false, onClick }: { video: Video; index?: number; compact?: boolean; onClick?: () => void }) {
  return (
    <div className={`video-cover cover-art-${index % 4} ${video.liveType === 'vertical' ? 'cover-vertical' : ''} ${compact ? 'cover-compact' : ''}`} onClick={onClick}>
      {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : <>
        <div className="cover-orb" /><div className="cover-horizon" /><div className="cover-sun" />
      </>}
      {!compact && <span className="cover-play"><Play size={16} fill="currentColor" /></span>}
      <span className="cover-duration">{formatDuration(video.durationSeconds)}</span>
    </div>
  );
}

function VideoLibrary({ videos, playlists, onUploaded, onEdit, onDelete, onPreview, onAddPlaylist, onStart }: {
  videos: Video[]; playlists: Playlist[]; onUploaded: (video: Video) => void; onEdit: (video: Video) => void; onDelete: (video: Video) => void; onPreview: (video: Video) => void; onAddPlaylist: (video: Video) => void; onStart: (video: Video) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'vertical' | 'horizontal'>('all');
  const [showUpload, setShowUpload] = useState(false);
  const filtered = useMemo(() => videos.filter((video) => {
    const matchesQuery = video.title.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (filter === 'all' || video.liveType === filter);
  }), [videos, query, filter]);
  return (
    <div className="page-content">
      <SectionTitle eyebrow="CONTENT MANAGEMENT" title="Video library" description={`${videos.length} videos · ${formatBytes(videos.reduce((sum, video) => sum + video.sizeBytes, 0))} stored`} action={<PrimaryButton onClick={() => setShowUpload(true)}><Plus size={17} /> Upload video</PrimaryButton>} />
      <div className="library-toolbar"><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your videos" /></div><div className="filter-tabs">{(['all', 'vertical', 'horizontal'] as const).map((item) => <button key={item} className={filter === item ? 'filter-active' : ''} onClick={() => setFilter(item)}>{item === 'all' ? 'All videos' : item === 'vertical' ? 'Vertical' : 'Horizontal'}</button>)}</div></div>
      {filtered.length === 0 ? <section className="panel empty-library"><div className="empty-library-mark"><Film size={25} /></div><h3>{query ? 'No matching videos' : 'Your library is ready for its first upload'}</h3><p>{query ? 'Try another title or change the orientation filter.' : 'Upload your source video once. Maya stores it securely and inspects the format before it can go live.'}</p><PrimaryButton onClick={() => setShowUpload(true)}><Upload size={16} /> Upload a video</PrimaryButton></section> : <div className="video-grid">{filtered.map((video, index) => <VideoCard key={video.id} video={video} index={index} playlists={playlists} onEdit={() => onEdit(video)} onDelete={() => onDelete(video)} onPreview={() => onPreview(video)} onAddPlaylist={() => onAddPlaylist(video)} onStart={() => onStart(video)} />)}</div>}
      {showUpload && <Modal title="Add a video" description="Upload once, then reuse it in live sessions and playlists." onClose={() => setShowUpload(false)} wide><UploadForm onUploaded={(video) => { onUploaded(video); setShowUpload(false); }} /></Modal>}
    </div>
  );
}

function VideoCard({ video, index, playlists, onEdit, onDelete, onPreview, onAddPlaylist, onStart }: {
  video: Video; index: number; playlists: Playlist[]; onEdit: () => void; onDelete: () => void; onPreview: () => void; onAddPlaylist: () => void; onStart: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article className="video-card">
      <div className="video-card-cover"><VideoCover video={video} index={index} onClick={video.previewAvailable ? onPreview : undefined} /><button className="video-menu-trigger" onClick={() => setMenuOpen((value) => !value)} aria-label="Video actions"><MoreHorizontal size={18} /></button>
        {menuOpen && <div className="video-menu"><button onClick={() => { onEdit(); setMenuOpen(false); }}><Pencil size={14} /> Edit details</button><button onClick={() => { onAddPlaylist(); setMenuOpen(false); }} disabled={playlists.length === 0}><ListMusic size={14} /> Add to playlist</button><button className="menu-danger" onClick={() => { onDelete(); setMenuOpen(false); }}><Trash2 size={14} /> Delete video</button></div>}
      </div>
      <div className="video-card-body"><div className="video-card-heading"><div><h3 title={video.title}>{video.title}</h3><p>{formatDate(video.createdAt)}</p></div><StatusBadge status={video.status} /></div>
        <div className="video-specs"><span><Monitor size={13} />{video.width} × {video.height}</span><span><Clock3 size={13} />{video.fps ? `${video.fps} fps` : '— fps'}</span><span className={`orientation-tag ${video.liveType}`}>{video.liveType === 'vertical' ? '9:16' : '16:9'}</span></div>
        <div className="video-format-line"><span>{video.videoCodec?.toUpperCase() || 'VIDEO'}{video.audioCodec ? ` · ${video.audioCodec.toUpperCase()}` : ' · SILENT'}</span><span>{formatBytes(video.sizeBytes)}</span></div>
      </div>
      <div className="video-card-actions"><button onClick={onPreview} disabled={!video.previewAvailable} title={video.previewAvailable ? 'Play preview' : 'No preview file in demo catalog'}><Play size={14} /> Play</button><button onClick={onAddPlaylist} disabled={!playlists.length}><ListMusic size={14} /> Playlist</button><button className="video-go-live" onClick={onStart}><Radio size={14} /> Start live</button></div>
    </article>
  );
}

function UploadForm({ onUploaded }: { onUploaded: (video: Video) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [liveType, setLiveType] = useState<'vertical' | 'horizontal'>('horizontal');
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  const chooseFile = (picked: File | null) => {
    if (!picked) return;
    setFile(picked);
    if (!title) setTitle(picked.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    setError('');
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) { setError('Select a video file first.'); return; }
    if (file.size > 5 * 1024 ** 3) { setError('This file exceeds the 5 GB upload limit.'); return; }
    setBusy(true); setProgress(0); setError('');
    try {
      const video = await uploadVideo(file, { title, description, liveType, loopEnabled }, setProgress);
      onUploaded(video);
    } catch (reason) {
      setError(toastMessage(reason));
    } finally { setBusy(false); }
  };

  return (
    <form className="upload-form" onSubmit={submit}>
      <div className={`upload-dropzone ${dragging ? 'dropzone-active' : ''} ${file ? 'dropzone-has-file' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0] || null); }} onClick={() => inputRef.current?.click()}>
        <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/x-matroska,.mp4,.mov,.mkv" onChange={(event) => chooseFile(event.target.files?.[0] || null)} hidden />
        <div className="upload-cloud-icon">{file ? <FileVideo2 size={22} /> : <Upload size={21} />}</div>
        {file ? <><strong>{file.name}</strong><span>{formatBytes(file.size)} · {file.type || 'Video file'} · Ready to upload</span></> : <><strong>Drop your video here, or <em>browse files</em></strong><span>MP4, MOV or MKV · Up to 5 GB</span></>}
      </div>
      {file && <div className="selected-file-row"><div className="selected-file-icon"><FileVideo2 size={17} /></div><div><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div><button type="button" className="icon-button subtle" onClick={() => setFile(null)} aria-label="Remove selected file"><X size={16} /></button></div>}
      <div className="upload-fields"><label>Video title<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} placeholder="Give your video a title" /></label><label>Description <span className="optional-label">OPTIONAL</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} rows={3} placeholder="Add a short description" /></label></div>
      <div className="upload-options"><div><div className="field-label">LIVE TYPE</div><div className="choice-toggle">{(['vertical', 'horizontal'] as const).map((type) => <button type="button" key={type} className={liveType === type ? 'choice-selected' : ''} onClick={() => setLiveType(type)}><span className={`orientation-mini ${type}`} />{type === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'}</button>)}</div></div><div><div className="field-label">DEFAULT PLAYBACK</div><button className={`toggle-row ${loopEnabled ? 'toggle-enabled' : ''}`} type="button" onClick={() => setLoopEnabled((value) => !value)}><span className={`switch ${loopEnabled ? 'switch-on' : ''}`} /><span><strong>Loop video</strong><small>{loopEnabled ? 'Repeat by default when starting live' : 'Stop at the end by default'}</small></span></button></div></div>
      {busy && <div className="upload-progress"><div className="upload-progress-copy"><span>{progress >= 100 ? 'Inspecting and saving video…' : `Uploading video… ${progress}%`}</span><span>{progress}%</span></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><small>Upload progress is shown here. Media inspection runs securely on the server.</small></div>}
      {error && <div className="form-error"><CircleHelp size={15} />{error}</div>}
      <div className="modal-actions"><span className="upload-safe-note"><ShieldCheck size={14} /> Private cloud storage</span><button type="button" className="button button-ghost" onClick={() => inputRef.current?.click()} disabled={busy}>Choose file</button><PrimaryButton type="submit" disabled={busy || !file}>{busy ? <><LoaderCircle size={16} className="spin" /> Processing</> : <><Upload size={16} /> Upload video</>}</PrimaryButton></div>
    </form>
  );
}

function PlaylistsPage({ videos, playlists, onRefresh, onToast }: { videos: Video[]; playlists: Playlist[]; onRefresh: () => void; onToast: (message: string, tone?: ToastState['tone']) => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [loop, setLoop] = useState(true);
  const [busy, setBusy] = useState(false);
  const readyVideos = videos.filter((video) => video.status === 'ready');
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected.length) { onToast('Choose at least one ready video.', 'error'); return; }
    setBusy(true);
    try {
      await api('/playlists', { method: 'POST', body: { name, videoIds: selected, loopEnabled: loop } });
      onRefresh(); setShowCreate(false); setName(''); setSelected([]); onToast('Playlist created.', 'success');
    } catch (error) { onToast(toastMessage(error), 'error'); }
    finally { setBusy(false); }
  };
  const remove = async (playlist: Playlist) => {
    if (!window.confirm(`Delete “${playlist.name}”? This does not delete the videos.`)) return;
    try { await api(`/playlists/${playlist.id}`, { method: 'DELETE' }); onRefresh(); onToast('Playlist deleted.', 'success'); }
    catch (error) { onToast(toastMessage(error), 'error'); }
  };
  return (
    <div className="page-content">
      <SectionTitle eyebrow="SEQUENTIAL STREAMING" title="Playlists" description="Queue videos in order, then choose whether the playlist repeats." action={<PrimaryButton onClick={() => setShowCreate(true)}><Plus size={17} /> New playlist</PrimaryButton>} />
      {playlists.length === 0 ? <section className="panel empty-library"><div className="empty-library-mark playlist-empty"><ListMusic size={25} /></div><h3>Build your first playlist</h3><p>Arrange videos into a continuous sequence for long-form or 24/7 live sessions.</p><PrimaryButton onClick={() => setShowCreate(true)}><Plus size={16} /> Create playlist</PrimaryButton></section> : <div className="playlist-grid">{playlists.map((playlist, index) => <article className="playlist-card" key={playlist.id}><div className={`playlist-art playlist-art-${index % 3}`}><div className="playlist-art-lines"><i /><i /><i /><i /></div><div className="playlist-art-count"><ListMusic size={15} /> {playlist.videos.length} ITEMS</div><button className="playlist-play-button" onClick={() => onToast('Select this playlist in Live Studio to start streaming.', 'info')} aria-label="Select playlist"><Play size={18} fill="currentColor" /></button></div><div className="playlist-card-info"><div className="playlist-card-title"><div><h3>{playlist.name}</h3><p>{playlist.videos.reduce((sum, video) => sum + video.durationSeconds, 0) ? formatDuration(playlist.videos.reduce((sum, video) => sum + video.durationSeconds, 0)) : 'No runtime'}</p></div><button className="icon-button subtle" onClick={() => remove(playlist)} title="Delete playlist"><Trash2 size={16} /></button></div><div className="playlist-item-list">{playlist.videos.slice(0, 3).map((video, itemIndex) => <div key={video.id}><span className="playlist-index">{String(itemIndex + 1).padStart(2, '0')}</span><span>{video.title}</span><small>{formatDuration(video.durationSeconds)}</small></div>)}{playlist.videos.length > 3 && <small className="more-items">+{playlist.videos.length - 3} more videos</small>}</div><div className="playlist-card-footer"><span className={`loop-state ${playlist.loopEnabled ? 'loop-on' : ''}`}><RefreshCw size={13} /> Loop {playlist.loopEnabled ? 'on' : 'off'}</span><span>{formatDate(playlist.createdAt)}</span></div></div></article>)}</div>}
      {showCreate && <Modal title="Create playlist" description="Videos play in the order you select them." onClose={() => setShowCreate(false)}><form className="stack-form modal-form" onSubmit={create}><label>Playlist name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="e.g. Evening ambience" /></label><div className="field-label">ADD READY VIDEOS <span className="optional-label">{selected.length} SELECTED</span></div><div className="select-video-list">{readyVideos.length === 0 ? <p className="muted">Upload a ready video first.</p> : readyVideos.map((video) => <label className="select-video-row" key={video.id}><input type="checkbox" checked={selected.includes(video.id)} onChange={(event) => setSelected((items) => event.target.checked ? [...items, video.id] : items.filter((id) => id !== video.id))} /><span className="select-video-art"><VideoIcon size={15} /></span><span><strong>{video.title}</strong><small>{formatDuration(video.durationSeconds)} · {video.width} × {video.height}</small></span></label>)}</div><button className={`toggle-row ${loop ? 'toggle-enabled' : ''}`} type="button" onClick={() => setLoop((value) => !value)}><span className={`switch ${loop ? 'switch-on' : ''}`} /><span><strong>Loop playlist</strong><small>Restart from the first video at the end</small></span></button><div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setShowCreate(false)}>Cancel</button><PrimaryButton type="submit" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} Create playlist</PrimaryButton></div></form></Modal>}
    </div>
  );
}

function LiveStudio({ health, videos, playlists, session, destination, initialVideoId, onClearDraft, onRefresh, onToast }: {
  health: Health | null; videos: Video[]; playlists: Playlist[]; session: LiveSession | null; destination: Destination | null;
  initialVideoId: string | null; onClearDraft: () => void; onRefresh: () => void; onToast: (message: string, tone?: ToastState['tone']) => void;
}) {
  const [sourceType, setSourceType] = useState<'video' | 'playlist'>(initialVideoId ? 'video' : 'video');
  const [sourceId, setSourceId] = useState(initialVideoId || '');
  const [liveType, setLiveType] = useState<'vertical' | 'horizontal'>('horizontal');
  const [loop, setLoop] = useState(false);
  const [skipFailed, setSkipFailed] = useState(false);
  const [privacy, setPrivacy] = useState<'unlisted' | 'public' | 'private'>('unlisted');
  const [busy, setBusy] = useState(false);
  const active = session && ['live', 'starting', 'queued', 'reconnecting', 'stopping'].includes(session.status) ? session : null;
  const persistent = health?.mode === 'persistent' && health.workerOnline;
  const selectedVideo = videos.find((video) => video.id === sourceId);
  const selectedPlaylist = playlists.find((playlist) => playlist.id === sourceId);
  const destinationReady = destination?.mode === 'youtube_api' ? destination.youtubeConnected : destination?.streamKeyConfigured;

  useEffect(() => {
    if (initialVideoId) {
      setSourceType('video'); setSourceId(initialVideoId);
      const chosen = videos.find((video) => video.id === initialVideoId);
      if (chosen) { setLiveType(chosen.liveType); setLoop(chosen.loopEnabled); }
      onClearDraft();
    }
  }, [initialVideoId, videos, onClearDraft]);
  useEffect(() => {
    if (sourceType === 'video' && selectedVideo) setLoop(selectedVideo.loopEnabled);
    if (sourceType === 'playlist' && selectedPlaylist) setLoop(selectedPlaylist.loopEnabled);
  }, [sourceId, sourceType]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!sourceId) { onToast('Choose a video or playlist first.', 'error'); return; }
    setBusy(true);
    try {
      await api('/live', { method: 'POST', body: { [sourceType === 'video' ? 'videoId' : 'playlistId']: sourceId, liveType, loopEnabled: loop, skipFailedVideos: sourceType === 'playlist' && skipFailed, privacyStatus: privacy } });
      onToast('Stream queued. The server worker is preparing your video.', 'success');
      onRefresh();
    } catch (error) { onToast(toastMessage(error), 'error'); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!active) return;
    setBusy(true);
    try { await api(`/live/${active.id}/stop`, { method: 'POST' }); onToast('Stop request sent to the worker.', 'info'); onRefresh(); }
    catch (error) { onToast(toastMessage(error), 'error'); }
    finally { setBusy(false); }
  };
  const restart = async () => {
    if (!active) return;
    setBusy(true);
    try { await api(`/live/${active.id}/restart`, { method: 'POST' }); onToast('Restart request sent.', 'info'); onRefresh(); }
    catch (error) { onToast(toastMessage(error), 'error'); }
    finally { setBusy(false); }
  };
  const outputSize = active?.liveType === 'vertical' || liveType === 'vertical' ? '1080 × 1920' : '1920 × 1080';
  return (
    <div className="page-content live-page">
      <SectionTitle eyebrow="BROADCAST CONTROL" title="Live studio" description="Start, monitor and recover server-side broadcasts from one place." action={active ? <StatusBadge status={active.status} label={active.status === 'live' ? 'LIVE NOW' : active.status.toUpperCase()} /> : undefined} />
      {(health?.mode === 'preview' || (health?.mode === 'persistent' && !health.workerOnline)) && <div className="preview-notice live-preview-notice"><Cloud size={18} /><span><strong>{health?.mode === 'preview' ? 'Preview mode is read-only for streaming.' : 'The FFmpeg worker is offline.'}</strong> {health?.mode === 'preview' ? 'Configure persistent services and a YouTube destination to start a real server-side broadcast.' : 'Start the worker service before creating a live session.'}</span></div>}
      {active ? <section className={`panel current-stream-card ${active.status === 'live' ? 'stream-is-live' : ''}`}>
        <div className="current-stream-top"><div className="current-stream-title"><div className={`stream-cover-mark ${active.liveType}`}><Radio size={22} /></div><div><div className="eyebrow">CURRENT SESSION · {active.liveType === 'vertical' ? 'VERTICAL 9:16' : 'HORIZONTAL 16:9'}</div><h3>{active.videoTitle || active.playlistName || 'Your broadcast'}</h3><p>{active.destination} <span>·</span> {active.loopEnabled ? 'Loop enabled' : 'Stops at the end'}{active.skipFailedVideos ? ' · Skip failed items' : ''}</p></div></div><StatusBadge status={active.status} label={active.status === 'live' ? 'LIVE' : active.status.toUpperCase()} /></div>
        <div className="current-stream-metrics"><Metric label="LIVE DURATION" value={formatUptime(active.startedAt)} good={active.status === 'live'} /><Metric label="OUTPUT" value={active.liveType === 'vertical' ? '1080 × 1920' : '1920 × 1080'} /><Metric label="FRAME RATE" value={active.fps ? `${active.fps} FPS` : 'Waiting…'} /><Metric label="BITRATE" value={active.bitrateKbps ? `${active.bitrateKbps.toLocaleString()} KB/S` : 'Waiting…'} /><Metric label="DROPPED FRAMES" value={active.droppedFrames === null ? '—' : String(active.droppedFrames)} good={active.droppedFrames === 0} /></div>
        <div className="stream-health-row"><div className="stream-health-icon"><Activity size={17} /></div><div><strong>Stream health</strong><small>{active.healthStatus === 'healthy' ? 'FFmpeg is sending video to the ingest endpoint.' : active.healthStatus === 'warning' ? 'Worker is recovering the ingest connection.' : 'Waiting for the first confirmed frames.'}</small></div><StatusBadge status={active.healthStatus} label={active.healthStatus === 'healthy' ? 'Healthy' : active.healthStatus === 'warning' ? 'Warning' : 'Connecting'} /></div>
        {active.errorMessage && <div className="form-error"><CircleHelp size={15} />{active.errorMessage}</div>}
        <div className="current-stream-actions"><span><Server size={15} /> Cloud worker · {active.reconnectAttempts ? `${active.reconnectAttempts} reconnects` : 'worker assigned'}</span><div><button className="button button-ghost" onClick={restart} disabled={busy || ['queued', 'stopping'].includes(active.status)}><RefreshCw size={15} /> Restart stream</button><button className="button button-stop" onClick={stop} disabled={busy || active.status === 'stopping'}><Square size={14} fill="currentColor" /> Stop live</button></div></div>
      </section> : <div className="live-builder-grid">
        <form className="panel live-builder" onSubmit={start}>
          <div className="panel-heading"><div><div className="eyebrow">NEW BROADCAST</div><h3>Build your stream</h3></div><span className="builder-step">01 <span>/</span> 03</span></div>
          <div className="live-form-section"><div className="field-heading"><span className="step-number">01</span><div><strong>Choose your source</strong><small>One video or an ordered playlist</small></div></div>
            <div className="source-switch"><button type="button" className={sourceType === 'video' ? 'source-selected' : ''} onClick={() => { setSourceType('video'); setSourceId(''); }}>Single video</button><button type="button" className={sourceType === 'playlist' ? 'source-selected' : ''} onClick={() => { setSourceType('playlist'); setSourceId(''); }}>Playlist</button></div>
            {sourceType === 'video' ? <select value={sourceId} onChange={(event) => { const video = videos.find((item) => item.id === event.target.value); setSourceId(event.target.value); if (video) { setLiveType(video.liveType); setLoop(video.loopEnabled); } }} required><option value="">Select a ready video</option>{videos.filter((video) => video.status === 'ready').map((video) => <option key={video.id} value={video.id}>{video.title} · {formatDuration(video.durationSeconds)}</option>)}</select> : <select value={sourceId} onChange={(event) => { setSourceId(event.target.value); const playlist = playlists.find((item) => item.id === event.target.value); if (playlist) setLoop(playlist.loopEnabled); }} required><option value="">Select a playlist</option>{playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name} · {playlist.videos.length} videos</option>)}</select>}
            {(selectedVideo || selectedPlaylist) && <div className="selected-source-summary"><span className="selected-source-icon">{sourceType === 'video' ? <VideoIcon size={16} /> : <ListMusic size={16} />}</span><div><strong>{selectedVideo?.title || selectedPlaylist?.name}</strong><small>{selectedVideo ? `${formatDuration(selectedVideo.durationSeconds)} · ${selectedVideo.width} × ${selectedVideo.height}` : `${selectedPlaylist?.videos.length || 0} videos · ${formatDuration(selectedPlaylist?.videos.reduce((sum, item) => sum + item.durationSeconds, 0) || 0)}`}</small></div><StatusBadge status="ready" /></div>}
          </div>
          <div className="live-form-section"><div className="field-heading"><span className="step-number">02</span><div><strong>Select live format</strong><small>Output is fitted without distortion</small></div></div>
            <div className="live-type-cards"><button type="button" className={`live-type-card ${liveType === 'vertical' ? 'live-type-selected' : ''}`} onClick={() => setLiveType('vertical')}><span className="frame-art frame-vertical"><i /><b /></span><span><strong>Vertical</strong><small>9:16 · 1080 × 1920</small></span>{liveType === 'vertical' && <CheckCircle2 size={17} />}</button><button type="button" className={`live-type-card ${liveType === 'horizontal' ? 'live-type-selected' : ''}`} onClick={() => setLiveType('horizontal')}><span className="frame-art frame-horizontal"><i /><b /></span><span><strong>Horizontal</strong><small>16:9 · 1920 × 1080</small></span>{liveType === 'horizontal' && <CheckCircle2 size={17} />}</button></div>
          </div>
          <div className="live-form-section"><div className="field-heading"><span className="step-number">03</span><div><strong>Playback settings</strong><small>How the server handles video completion</small></div></div>
            <button type="button" className={`toggle-row ${loop ? 'toggle-enabled' : ''}`} onClick={() => setLoop((value) => !value)}><span className={`switch ${loop ? 'switch-on' : ''}`} /><span><strong>Loop continuously</strong><small>{loop ? 'Restart from the beginning when finished' : 'End the stream when this source finishes'}</small></span></button>
            {sourceType === 'playlist' && <button type="button" className={`toggle-row ${skipFailed ? 'toggle-enabled' : ''}`} onClick={() => setSkipFailed((value) => !value)}><span className={`switch ${skipFailed ? 'switch-on' : ''}`} /><span><strong>Skip failed playlist videos</strong><small>{skipFailed ? 'Unavailable or unprocessable items are logged and skipped' : 'Stop the stream if a playlist video is unavailable'}</small></span></button>}
            <div className="privacy-select"><label>Broadcast visibility<select value={privacy} onChange={(event) => setPrivacy(event.target.value as typeof privacy)}><option value="unlisted">Unlisted · link only</option><option value="public">Public</option><option value="private">Private</option></select></label></div>
          </div>
          <div className="live-builder-footer"><div className="destination-ready"><span className={`health-indicator ${destinationReady ? 'health-ok' : 'health-preview'}`} /><span><strong>{destinationReady ? (destination?.youtubeConnected ? destination.channelTitle : 'YouTube RTMP ready') : 'Destination required'}</strong><small>{destination?.mode === 'youtube_api' ? 'Official YouTube Live API' : 'Manual RTMP/RTMPS'}</small></span></div><PrimaryButton type="submit" className="start-live-button" disabled={busy || !persistent || !destinationReady || !sourceId}><span className="button-live-dot" />{busy ? 'Preparing…' : loop ? 'START 24/7 LIVE' : 'START LIVE'} <ArrowRight size={16} /></PrimaryButton></div>
        </form>
        <aside className="live-side-column">
          <div className="panel destination-card"><div className="panel-heading"><div><div className="eyebrow">DESTINATION</div><h3>YouTube Live</h3></div><Youtube size={20} className="youtube-red" /></div><div className="destination-card-body"><div className="youtube-channel-icon"><Youtube size={20} /></div><div><strong>{destination?.youtubeConnected ? destination.channelTitle : destination?.streamKeyConfigured ? 'Manual stream key saved' : 'No destination connected'}</strong><small>{destination?.youtubeConnected ? 'Official account integration' : destination?.streamKeyConfigured ? 'Encrypted on the server' : 'Connect a channel or add an RTMP key'}</small></div><span className={`health-indicator ${destinationReady ? 'health-ok' : 'health-preview'}`} /></div><button className="destination-manage-link" onClick={() => { window.location.hash = '#youtube'; window.dispatchEvent(new CustomEvent('maya:navigate', { detail: 'youtube' })); }}>{destinationReady ? 'Manage destination' : 'Set up YouTube'} <ArrowRight size={14} /></button></div>
          <div className="panel output-card"><div className="panel-heading"><div><div className="eyebrow">OUTPUT PREVIEW</div><h3>{liveType === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'}</h3></div><span className="output-live-dot" /></div><div className={`output-frame ${liveType === 'vertical' ? 'output-frame-vertical' : ''}`}><div className="output-grid" /><div className="output-wave"><span /><span /><span /><span /><span /><span /><span /></div><div className="output-frame-text"><Radio size={19} /><strong>Ready to stream</strong><small>{outputSize} · 30 FPS</small></div></div><div className="output-meta"><span><Gauge size={14} /> 4.5 Mbps video</span><span><Headphones size={14} /> AAC audio</span></div></div>
          <div className="side-note"><ShieldCheck size={16} /><p><strong>Your phone can disconnect.</strong> FFmpeg runs in the cloud worker, not on your device.</p></div>
        </aside>
      </div>}
    </div>
  );
}

function SchedulePage({ videos, playlists, schedules, health, destination, onRefresh, onToast }: { videos: Video[]; playlists: Playlist[]; schedules: Schedule[]; health: Health | null; destination: Destination | null; onRefresh: () => void; onToast: (message: string, tone?: ToastState['tone']) => void }) {
  const [sourceType, setSourceType] = useState<'video' | 'playlist'>('video');
  const [sourceId, setSourceId] = useState('');
  const [liveType, setLiveType] = useState<'vertical' | 'horizontal'>('horizontal');
  const [loop, setLoop] = useState(false);
  const [skipFailed, setSkipFailed] = useState(false);
  const [startAt, setStartAt] = useState(() => toLocalDateTime(Date.now() + 60 * 60 * 1000));
  const [endAt, setEndAt] = useState('');
  const [autoStart, setAutoStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const canSchedule = health?.mode === 'persistent' && health.workerOnline;
  const schedule = async (event: FormEvent) => {
    event.preventDefault();
    if (!sourceId) { onToast('Choose a video or playlist first.', 'error'); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        [sourceType === 'video' ? 'videoId' : 'playlistId']: sourceId,
        liveType, loopEnabled: loop, skipFailedVideos: sourceType === 'playlist' && skipFailed, privacyStatus: 'unlisted',
        scheduledStart: new Date(startAt).toISOString(), autoStart,
      };
      if (endAt) body.scheduledEnd = new Date(endAt).toISOString();
      await api('/schedules', { method: 'POST', body });
      onRefresh(); onToast('Scheduled live saved.', 'success');
      setStartAt(toLocalDateTime(Date.now() + 60 * 60 * 1000)); setEndAt(''); setSourceId('');
    } catch (error) { onToast(toastMessage(error), 'error'); }
    finally { setBusy(false); }
  };
  const cancel = async (item: Schedule) => {
    try { await api(`/schedules/${item.id}`, { method: 'DELETE' }); onRefresh(); onToast('Schedule cancelled.', 'success'); }
    catch (error) { onToast(toastMessage(error), 'error'); }
  };
  return (
    <div className="page-content">
      <SectionTitle eyebrow="AUTOMATED BROADCASTS" title="Schedule a live" description="Choose a source and let the cloud worker start it at the right time." />
      {!canSchedule && <div className="preview-notice"><CalendarDays size={17} /><span><strong>Scheduling is disabled in preview.</strong> PostgreSQL, Redis and a streaming worker are required for delayed jobs.</span></div>}
      <div className="schedule-layout"><form className="panel schedule-form" onSubmit={schedule}><div className="panel-heading"><div><div className="eyebrow">NEW SCHEDULE</div><h3>Set up a broadcast</h3></div><CalendarDays size={19} className="muted-icon" /></div>
        <div className="form-two-col"><label>Source type<select value={sourceType} onChange={(event) => { setSourceType(event.target.value as typeof sourceType); setSourceId(''); }}><option value="video">Single video</option><option value="playlist">Playlist</option></select></label><label>{sourceType === 'video' ? 'Choose video' : 'Choose playlist'}<select value={sourceId} onChange={(event) => setSourceId(event.target.value)} required><option value="">Select…</option>{sourceType === 'video' ? videos.filter((video) => video.status === 'ready').map((video) => <option key={video.id} value={video.id}>{video.title}</option>) : playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}</select></label></div>
        <div className="form-two-col"><label>Start date & time<input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} required /></label><label>End date & time <span className="optional-label">OPTIONAL</span><input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} min={startAt} /></label></div>
        <div className="field-label">LIVE TYPE</div><div className="choice-toggle schedule-type-toggle"><button type="button" className={liveType === 'vertical' ? 'choice-selected' : ''} onClick={() => setLiveType('vertical')}><span className="orientation-mini vertical" />Vertical 9:16</button><button type="button" className={liveType === 'horizontal' ? 'choice-selected' : ''} onClick={() => setLiveType('horizontal')}><span className="orientation-mini horizontal" />Horizontal 16:9</button></div>
        <button className={`toggle-row ${loop ? 'toggle-enabled' : ''}`} type="button" onClick={() => setLoop((value) => !value)}><span className={`switch ${loop ? 'switch-on' : ''}`} /><span><strong>Loop selected source</strong><small>Continue until you stop the stream</small></span></button>
        {sourceType === 'playlist' && <button className={`toggle-row ${skipFailed ? 'toggle-enabled' : ''}`} type="button" onClick={() => setSkipFailed((value) => !value)}><span className={`switch ${skipFailed ? 'switch-on' : ''}`} /><span><strong>Skip failed playlist videos</strong><small>{skipFailed ? 'Unavailable or unprocessable items are logged and skipped' : 'The schedule will fail if a playlist video is unavailable'}</small></span></button>}
        <button className={`toggle-row ${autoStart ? 'toggle-enabled' : ''}`} type="button" onClick={() => setAutoStart((value) => !value)}><span className={`switch ${autoStart ? 'switch-on' : ''}`} /><span><strong>Auto-start at scheduled time</strong><small>{autoStart ? 'The worker will start automatically' : 'Start manually from this schedule'}</small></span></button>
        <div className="schedule-destination"><span className={`health-indicator ${destination?.youtubeConnected || destination?.streamKeyConfigured ? 'health-ok' : 'health-preview'}`} /><div><strong>{destination?.youtubeConnected ? destination.channelTitle : destination?.streamKeyConfigured ? 'Manual YouTube RTMP' : 'YouTube destination not set'}</strong><small>The saved destination is used for this scheduled live.</small></div></div>
        <PrimaryButton type="submit" className="button-full" disabled={busy || !canSchedule || !sourceId || !(destination?.youtubeConnected || destination?.streamKeyConfigured)}>{busy ? <><LoaderCircle size={16} className="spin" /> Saving schedule…</> : <><CalendarDays size={16} /> Schedule live</>}</PrimaryButton>
      </form>
      <div className="schedule-list-column"><div className="schedule-list-heading"><div><div className="eyebrow">UPCOMING</div><h3>Scheduled streams <span>{schedules.filter((item) => item.status === 'scheduled').length}</span></h3></div><button className="icon-button subtle" onClick={onRefresh} aria-label="Refresh schedules"><RefreshCw size={16} /></button></div>
        {schedules.filter((item) => ['scheduled', 'started'].includes(item.status)).length === 0 ? <div className="panel schedule-empty"><div className="schedule-empty-icon"><Clock3 size={22} /></div><strong>No upcoming broadcasts</strong><p>Your automated lives will appear here once scheduled.</p><span className="empty-date-line" /></div> : <div className="schedule-list">{schedules.filter((item) => ['scheduled', 'started'].includes(item.status)).map((item) => <article className="panel schedule-item" key={item.id}><div className="schedule-date-box"><strong>{new Intl.DateTimeFormat(undefined, { day: '2-digit' }).format(new Date(item.scheduledStart))}</strong><small>{new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(item.scheduledStart)).toUpperCase()}</small></div><div className="schedule-item-main"><div className="schedule-item-title"><strong>{item.session?.videoTitle || item.session?.playlistName || 'Scheduled broadcast'}</strong><StatusBadge status={item.status} label={item.status === 'scheduled' ? 'Scheduled' : item.session?.status || 'Started'} /></div><p><Clock3 size={13} />{formatDate(item.scheduledStart, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p><small>{item.session?.liveType === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'} · {item.autoStart ? 'Auto-start on' : 'Manual start'}</small></div><button className="icon-button subtle schedule-cancel" onClick={() => cancel(item)} aria-label="Cancel scheduled live"><X size={16} /></button></article>)}</div>}
        <div className="schedule-help"><CircleHelp size={16} /><span>Scheduled jobs are stored in PostgreSQL and run by Redis-backed cloud workers.</span></div>
      </div></div>
    </div>
  );
}

function toLocalDateTime(timestamp: number): string {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function YouTubePage({ destination, youtube, onRefresh, onToast }: { destination: Destination | null; youtube: YoutubeStatus | null; onRefresh: () => void; onToast: (message: string, tone?: ToastState['tone']) => void }) {
  const [mode, setMode] = useState<'manual' | 'youtube_api'>(destination?.mode || 'manual');
  const [serverUrl, setServerUrl] = useState(destination?.serverUrl || 'rtmps://a.rtmps.youtube.com/live2');
  const [streamKey, setStreamKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  useEffect(() => { if (destination) { setMode(destination.mode); setServerUrl(destination.serverUrl || 'rtmps://a.rtmps.youtube.com/live2'); } }, [destination]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      const body = mode === 'manual' ? { mode, serverUrl, streamKey } : { mode };
      await api('/destination', { method: 'PUT', body });
      setStreamKey(''); onRefresh(); onToast('YouTube destination saved securely.', 'success');
    } catch (error) { onToast(toastMessage(error), 'error'); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setTesting(true);
    try {
      const body = mode === 'manual' ? { mode, serverUrl, streamKey } : { mode };
      const result = await api<{ message: string }>('/destination/test', { method: 'POST', body });
      onToast(result.message, 'success');
    } catch (error) { onToast(toastMessage(error), 'error'); }
    finally { setTesting(false); }
  };
  const connect = () => { window.location.assign('/api/youtube/connect'); };
  const disconnect = async () => {
    if (!window.confirm('Disconnect this YouTube account?')) return;
    try { await api('/youtube/status', { method: 'DELETE' }); onRefresh(); onToast('YouTube account disconnected.', 'info'); }
    catch (error) { onToast(toastMessage(error), 'error'); }
  };
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('oauth');
    if (value) {
      if (value === 'connected') onToast('YouTube account connected.', 'success');
      else onToast(value === 'denied' ? 'YouTube connection was cancelled.' : 'YouTube connection could not be completed.', 'error');
      window.history.replaceState({}, '', window.location.pathname);
      onRefresh();
    }
  }, []);
  return (
    <div className="page-content">
      <SectionTitle eyebrow="SECURE DESTINATION" title="YouTube connection" description="Choose how Maya securely sends your stream to YouTube Live." />
      <div className="youtube-layout">
        <div className="youtube-main-column">
          <section className="panel youtube-mode-panel"><div className="panel-heading"><div><div className="eyebrow">CONNECTION METHOD</div><h3>Choose your workflow</h3></div><LockKeyhole size={18} className="muted-icon" /></div><div className="connection-methods"><button className={`connection-method ${mode === 'manual' ? 'method-selected' : ''}`} onClick={() => setMode('manual')}><span className="method-icon method-manual"><Link2 size={20} /></span><span><strong>Manual RTMP key</strong><small>Use an ingest URL and key from YouTube Studio.</small></span>{mode === 'manual' && <CheckCircle2 size={18} />}</button><button className={`connection-method ${mode === 'youtube_api' ? 'method-selected' : ''}`} onClick={() => setMode('youtube_api')}><span className="method-icon method-youtube"><Youtube size={20} /></span><span><strong>Connect YouTube account</strong><small>Official OAuth and Live Streaming API workflow.</small></span>{mode === 'youtube_api' && <CheckCircle2 size={18} />}</button></div></section>
          {mode === 'manual' ? <form className="panel destination-settings" onSubmit={save}><div className="panel-heading"><div><div className="eyebrow">MANUAL DESTINATION</div><h3>RTMP server settings</h3></div><StatusBadge status={destination?.streamKeyConfigured ? 'connected' : 'neutral'} label={destination?.streamKeyConfigured ? 'Key saved' : 'Not configured'} /></div><label>Ingest server URL<div className="input-with-icon"><Link2 size={16} /><input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="rtmps://a.rtmps.youtube.com/live2" required /></div><small className="field-help">Use the server URL provided by YouTube Studio. YouTube ingest hosts only.</small></label><label>Stream key<div className="input-with-action"><LockKeyhole size={16} /><input type={showKey ? 'text' : 'password'} value={streamKey} onChange={(event) => setStreamKey(event.target.value)} placeholder={destination?.streamKeyConfigured ? 'Saved securely · enter a new key to replace' : 'Paste your YouTube stream key'} autoComplete="new-password" required={!destination?.streamKeyConfigured} /><button type="button" className="text-button show-key" onClick={() => setShowKey((value) => !value)}>{showKey ? 'Hide' : 'Show'}</button></div>{destination?.streamKeyConfigured && <small className="field-help">A key is already encrypted on the server. It is never sent back to this page.</small>}</label><div className="secure-callout"><ShieldCheck size={17} /><div><strong>Encrypted at rest</strong><p>Your stream key is encrypted in the backend using AES-256-GCM. It is only decrypted inside the streaming worker.</p></div></div><div className="destination-form-footer"><button type="button" className="button button-ghost" onClick={test} disabled={testing || (!streamKey && !destination?.streamKeyConfigured)}>{testing ? <LoaderCircle size={15} className="spin" /> : <Activity size={15} />} Test settings</button><PrimaryButton type="submit" disabled={busy || (!streamKey && !destination?.streamKeyConfigured)}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Save destination</PrimaryButton></div></form> : <section className="panel oauth-panel"><div className="oauth-hero"><div className="oauth-youtube-icon"><Youtube size={25} /></div><div><div className="eyebrow">OFFICIAL YOUTUBE LIVE API</div><h3>{youtube?.connected ? 'Channel connected' : 'Connect your channel'}</h3><p>{youtube?.connected ? 'Maya can create and manage event-specific live broadcasts on your behalf.' : 'Authorize the server to create broadcasts, bind ingest streams and update live status.'}</p></div></div>{youtube?.connected ? <><div className="connected-channel"><div className="youtube-channel-avatar"><Youtube size={18} /></div><div><strong>{youtube.channel?.title || destination?.channelTitle}</strong><small>Channel ID · {youtube.channel?.id || 'Connected'}</small></div><StatusBadge status="connected" label="Connected" /></div><div className="oauth-scope-note"><ShieldCheck size={16} /><span>Tokens are encrypted in backend storage. Only YouTube Live management scope is requested.</span></div><div className="destination-form-footer"><button className="button button-ghost button-danger-ghost" onClick={disconnect}>Disconnect account</button><button className="button button-ghost" onClick={onRefresh}><RefreshCw size={15} /> Refresh status</button></div></> : <><div className="oauth-benefits"><div><CheckCircle2 size={16} /><span>Create event-specific broadcasts</span></div><div><CheckCircle2 size={16} /><span>Bind stream and monitor health</span></div><div><CheckCircle2 size={16} /><span>Start and end via official API</span></div></div>{!youtube?.configured && <div className="form-error"><CircleHelp size={15} />Google OAuth client credentials are not configured on the server yet.</div>}<PrimaryButton className="button-full" onClick={connect} disabled={!youtube?.configured}><Youtube size={17} /> Connect YouTube account</PrimaryButton><small className="oauth-disclaimer">Your channel must already be eligible for live streaming. API access cannot override YouTube restrictions.</small></>}</section>}
          <div className="youtube-info-strip"><div><ShieldCheck size={17} /><span><strong>Never exposed to the browser</strong><small>Credentials remain server-side and are encrypted.</small></span></div><div><Activity size={17} /><span><strong>Ingest is verified at start</strong><small>Test checks settings; real RTMP status requires sending media.</small></span></div></div>
        </div>
        <aside className="youtube-side-column"><div className="panel youtube-checklist-panel"><div className="eyebrow">BEFORE GOING LIVE</div><h3>Channel checklist</h3><ChecklistItem done={Boolean(youtube?.connected || destination?.streamKeyConfigured)} number="01" title="Connect a destination" text="OAuth or manual RTMP" onClick={() => {}} /><ChecklistItem done={false} number="02" title="Enable live streaming" text="Channel eligibility is managed by YouTube" onClick={() => {}} /><ChecklistItem done={false} number="03" title="Review broadcast rights" text="Only stream content you have rights to" onClick={() => {}} /><div className="youtube-side-tip"><CircleHelp size={16} /><p>New channels may need to enable live streaming and wait before their first broadcast.</p></div></div><div className="compliance-card"><div className="compliance-icon"><ShieldCheck size={17} /></div><div><strong>Built for compliant streaming</strong><p>No fake viewers, engagement bots, or restriction bypasses.</p><a href="https://support.google.com/youtube/answer/2853834" target="_blank" rel="noreferrer">YouTube live policies <ArrowUpRight size={12} /></a></div></div></aside>
      </div>
    </div>
  );
}

function SettingsPage({ health }: { health: Health | null }) {
  return (
    <div className="page-content">
      <SectionTitle eyebrow="WORKSPACE PREFERENCES" title="Settings" description="Security, storage and service status for this Maya workspace." />
      <div className="settings-layout"><div className="settings-main">
        <section className="panel settings-card"><div className="panel-heading"><div><div className="eyebrow">SYSTEM STATUS</div><h3>Cloud services</h3></div><StatusBadge status={health?.mode === 'persistent' ? 'healthy' : 'warning'} label={health?.mode === 'persistent' ? 'Persistent mode' : 'Preview mode'} /></div><div className="service-status-list"><ServiceStatus icon={<Database size={17} />} name="PostgreSQL" detail={health?.mode === 'persistent' ? 'Relational metadata store' : 'In-memory demo store'} good={health?.mode === 'persistent'} /><ServiceStatus icon={<Zap size={17} />} name="Redis + BullMQ" detail={health?.queueConfigured ? 'Background job queue configured' : 'Queue not connected'} good={Boolean(health?.queueConfigured)} /><ServiceStatus icon={<HardDrive size={17} />} name="Object storage" detail={health?.storageDriver === 's3' ? 'S3-compatible private storage' : 'Local development storage'} good={health?.storageDriver === 's3'} /><ServiceStatus icon={<Cpu size={17} />} name="FFmpeg worker" detail={health?.workerOnline ? `CPU ${health.workerCpuPercent ?? '—'}% · RAM ${health.workerMemoryPercent ?? '—'}%` : 'Worker service is offline'} good={Boolean(health?.workerOnline)} /></div></section>
        <section className="panel settings-card"><div className="panel-heading"><div><div className="eyebrow">STREAM PROFILES</div><h3>Encoding defaults</h3></div><Settings size={18} className="muted-icon" /></div><div className="profile-settings-row"><span className="frame-art frame-vertical"><i /><b /></span><div><strong>Vertical profile</strong><small>H.264 · AAC · 30 FPS · scale and pad</small></div><code>1080 × 1920</code></div><div className="profile-settings-row"><span className="frame-art frame-horizontal"><i /><b /></span><div><strong>Horizontal profile</strong><small>H.264 · AAC · 30 FPS · scale and pad</small></div><code>1920 × 1080</code></div><div className="secure-callout"><Sparkles size={16} /><div><strong>Processed outputs are cached</strong><p>After the first profile encode, the worker can reuse that video rendition to reduce repeat compute.</p></div></div></section>
        <section className="panel settings-card"><div className="panel-heading"><div><div className="eyebrow">SECURITY</div><h3>Credential handling</h3></div><ShieldCheck size={18} className="muted-icon" /></div><div className="security-lines"><div><LockKeyhole size={16} /><span><strong>Session cookie</strong><small>HttpOnly · SameSite · HTTPS Secure in production</small></span><StatusBadge status="healthy" label="Enabled" /></div><div><ShieldCheck size={16} /><span><strong>Secret encryption</strong><small>AES-256-GCM using a deployment-only key</small></span><StatusBadge status="healthy" label="Enabled" /></div><div><Activity size={16} /><span><strong>Request protection</strong><small>Rate limiting, origin checks and input validation</small></span><StatusBadge status="healthy" label="Enabled" /></div></div></section>
      </div><aside className="settings-side"><div className="panel settings-about"><BrandMark compact /><h3>Maya Cloud Live</h3><p>Server-side video streaming control plane.</p><div className="settings-version"><span>Version</span><strong>1.0.0</strong></div><div className="settings-version"><span>API mode</span><strong>{health?.mode || 'loading'}</strong></div><div className="settings-version"><span>Storage</span><strong>{health?.storageDriver || '—'}</strong></div></div><div className="setup-doc-card"><div className="setup-doc-icon"><CircleHelp size={18} /></div><strong>Need deployment help?</strong><p>Read the architecture, environment variables and YouTube setup notes in the project README.</p></div></aside></div>
    </div>
  );
}

function ServiceStatus({ icon, name, detail, good }: { icon: ReactNode; name: string; detail: string; good: boolean }) {
  return <div className="service-status-row"><span className="service-icon">{icon}</span><span className="service-copy"><strong>{name}</strong><small>{detail}</small></span><StatusBadge status={good ? 'healthy' : 'warning'} label={good ? 'Ready' : 'Setup needed'} /></div>;
}

function AdminPage({ overview, onRefresh, onToast }: { overview: AdminOverview | null; onRefresh: () => void; onToast: (message: string, tone?: ToastState['tone']) => void }) {
  const disableUser = async (user: AdminOverview['users'][number]) => {
    try { await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { disabled: !user.disabled } }); onToast(user.disabled ? 'User enabled.' : 'User disabled.', 'success'); onRefresh(); }
    catch (error) { onToast(toastMessage(error), 'error'); }
  };
  const stop = async (session: LiveSession) => {
    try { await api(`/admin/sessions/${session.id}/stop`, { method: 'POST' }); onToast('Administrator stop request sent.', 'info'); onRefresh(); }
    catch (error) { onToast(toastMessage(error), 'error'); }
  };
  return (
    <div className="page-content">
      <SectionTitle eyebrow="ADMINISTRATOR ONLY" title="Admin console" description="User access, active workers, stored media and recent stream sessions." action={<button className="button button-ghost" onClick={onRefresh}><RefreshCw size={15} /> Refresh</button>} />
      {!overview ? <div className="panel empty-library"><LoaderCircle className="spin" size={22} /><p>Loading admin overview…</p></div> : <>
        <div className="admin-stats"><StatCard icon={<Users size={17} />} label="TOTAL USERS" value={String(overview.counts.users)} detail="Workspace accounts" accent="mint" trend={<span className="stat-trend"><Users size={13} /> Managed</span>} /><StatCard icon={<VideoIcon size={17} />} label="VIDEO ASSETS" value={String(overview.storage.videoCount)} detail={formatBytes(overview.storage.bytes)} accent="blue" trend={<span className="stat-trend stat-trend-blue"><HardDrive size={13} /> Storage</span>} /><StatCard icon={<Radio size={17} />} label="ACTIVE SESSIONS" value={String(overview.sessions.filter((session) => ['live', 'starting', 'queued', 'reconnecting'].includes(session.status)).length)} detail="Across all users" accent="orange" trend={<span className="stat-trend"><Activity size={13} /> Monitor</span>} /></div>
        <section className="panel admin-table-panel"><div className="panel-heading"><div><div className="eyebrow">ACCOUNTS</div><h3>Workspace users</h3></div><Users size={18} className="muted-icon" /></div><div className="table-scroll"><table><thead><tr><th>USER</th><th>ROLE</th><th>CREATED</th><th>STATUS</th><th /></tr></thead><tbody>{overview.users.map((user) => <tr key={user.id}><td><div className="table-user"><div className="user-avatar small-avatar">{user.name.slice(0, 1)}</div><span><strong>{user.name}</strong><small>{user.email}</small></span></div></td><td>{user.role}</td><td>{formatDate(user.createdAt)}</td><td><StatusBadge status={user.disabled ? 'failed' : 'healthy'} label={user.disabled ? 'Disabled' : 'Enabled'} /></td><td><button className={`text-button ${user.disabled ? '' : 'danger-text'}`} onClick={() => disableUser(user)}>{user.disabled ? 'Enable' : 'Disable'}</button></td></tr>)}</tbody></table></div></section>
        <section className="panel admin-table-panel"><div className="panel-heading"><div><div className="eyebrow">STREAM OPERATIONS</div><h3>Recent live sessions</h3></div><Activity size={18} className="muted-icon" /></div><div className="admin-session-list">{overview.sessions.slice(0, 8).map((session) => <div className="admin-session-row" key={session.id}><span className="admin-session-icon"><Radio size={16} /></span><span><strong>{session.videoTitle || session.playlistName || `Session ${session.id.slice(0, 8)}`}</strong><small>{session.liveType} · {formatDate(session.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></span><StatusBadge status={session.status} /><button className="icon-button subtle" onClick={() => stop(session)} disabled={['ended', 'failed'].includes(session.status)} aria-label="Stop session"><Square size={14} /></button></div>)}</div></section>
      </>}
    </div>
  );
}

function NotificationsToast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  if (!toast) return null;
  return <div className={`toast toast-${toast.tone}`} role="status"><span>{toast.tone === 'success' ? <CheckCircle2 size={17} /> : toast.tone === 'error' ? <CircleHelp size={17} /> : <Activity size={17} />}</span><p>{toast.message}</p><button className="icon-button subtle" onClick={onDismiss} aria-label="Dismiss notification"><X size={15} /></button></div>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [page, setPage] = useState<Page>('dashboard');
  const [videos, setVideos] = useState<Video[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [youtube, setYoutube] = useState<YoutubeStatus | null>(null);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewVideo, setPreviewVideo] = useState<Video | null>(null);
  const [playlistVideo, setPlaylistVideo] = useState<Video | null>(null);
  const [editingVideo, setEditingVideo] = useState<Video | null>(null);
  const [draftVideoId, setDraftVideoId] = useState<string | null>(null);
  const toastId = useRef(0);

  const notify = useCallback((message: string, tone: ToastState['tone'] = 'info') => {
    const id = ++toastId.current;
    setToast({ id, message, tone });
    window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 4800);
  }, []);

  const refreshData = useCallback(async () => {
    if (!user) return;
    const [videoResult, playlistResult, destinationResult, youtubeResult, currentResult, sessionResult, scheduleResult, noticeResult] = await Promise.allSettled([
      API.videos(), API.playlists(), API.destination(), API.youtubeStatus(), API.current(), API.sessions(), API.schedules(), API.notifications(),
    ]);
    if (videoResult.status === 'fulfilled') setVideos(videoResult.value.videos);
    if (playlistResult.status === 'fulfilled') setPlaylists(playlistResult.value.playlists);
    if (destinationResult.status === 'fulfilled') setDestination(destinationResult.value.destination);
    if (youtubeResult.status === 'fulfilled') setYoutube(youtubeResult.value);
    if (currentResult.status === 'fulfilled') setSession(currentResult.value.session);
    if (sessionResult.status === 'fulfilled') setSessions(sessionResult.value.sessions);
    if (scheduleResult.status === 'fulfilled') setSchedules(scheduleResult.value.schedules);
    if (noticeResult.status === 'fulfilled') setNotifications(noticeResult.value.notifications);
    if (user.role === 'admin') {
      const result = await API.adminOverview().catch(() => null);
      if (result) setAdminOverview(result);
    }
  }, [user]);

  useEffect(() => {
    let mounted = true;
    API.health().then((data) => { if (mounted) setHealth(data); }).catch(() => undefined);
    API.me().then((result) => { if (mounted) setUser(result.user); }).catch(() => { if (mounted) setUser(null); }).finally(() => { if (mounted) setAuthLoading(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => { if (user) void refreshData(); }, [user, refreshData]);

  useEffect(() => {
    if (!user) return;
    const interval = window.setInterval(() => {
      API.health().then(setHealth).catch(() => undefined);
      API.current().then((value) => setSession(value.session)).catch(() => undefined);
    }, 8_000);
    return () => window.clearInterval(interval);
  }, [user]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail && detail in pageNames) setPage(detail as Page);
    };
    window.addEventListener('maya:navigate', handleNavigate);
    return () => window.removeEventListener('maya:navigate', handleNavigate);
  }, []);

  const onLogin = (signedInUser: User) => { setUser(signedInUser); setPage('dashboard'); notify(`Welcome back, ${signedInUser.name.split(' ')[0]}.`, 'success'); };
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => undefined); setUser(null); setPage('dashboard'); };
  const uploadDone = (video: Video) => { setVideos((items) => [video, ...items]); notify(`${video.title} is ready in your library.`, 'success'); void refreshData(); };
  const deleteVideo = async (video: Video) => {
    if (!window.confirm(`Delete “${video.title}” and its stored file?`)) return;
    try { await api(`/videos/${video.id}`, { method: 'DELETE' }); setVideos((items) => items.filter((item) => item.id !== video.id)); notify('Video deleted.', 'success'); }
    catch (error) { notify(toastMessage(error), 'error'); }
  };
  const saveEditedVideo = async (video: Video, values: { title: string; description: string }) => {
    try {
      const result = await api<{ video: Video }>(`/videos/${video.id}`, { method: 'PATCH', body: values });
      setVideos((items) => items.map((item) => item.id === video.id ? result.video : item));
      setEditingVideo(null); notify('Video details updated.', 'success');
    } catch (error) { notify(toastMessage(error), 'error'); }
  };
  const addToPlaylist = async (videoId: string, playlistId: string) => {
    try { await api(`/playlists/${playlistId}/items`, { method: 'POST', body: { videoId } }); setPlaylistVideo(null); void refreshData(); notify('Video added to playlist.', 'success'); }
    catch (error) { notify(toastMessage(error), 'error'); }
  };
  const openVideoPreview = (video: Video) => {
    if (!video.previewAvailable) { notify('This demo catalog item has metadata only. Upload a real video to preview it.', 'info'); return; }
    setPreviewVideo(video);
  };
  const onStartVideo = (video: Video) => { setDraftVideoId(video.id); setPage('live'); };

  if (authLoading) return <div className="app-loading"><BrandMark /><LoaderCircle size={23} className="spin" /><span>Opening your studio…</span></div>;
  if (!user) return <><SignIn health={health} onLogin={onLogin} /><NotificationsToast toast={toast} onDismiss={() => setToast(null)} /></>;

  let content: ReactNode;
  switch (page) {
    case 'dashboard': content = <Dashboard user={user} health={health} videos={videos} playlists={playlists} session={session} sessions={sessions} destination={destination} onNavigate={setPage} onSelectVideo={openVideoPreview} onStartVideo={onStartVideo} />; break;
    case 'videos': content = <VideoLibrary videos={videos} playlists={playlists} onUploaded={uploadDone} onEdit={setEditingVideo} onDelete={deleteVideo} onPreview={openVideoPreview} onAddPlaylist={setPlaylistVideo} onStart={onStartVideo} />; break;
    case 'playlists': content = <PlaylistsPage videos={videos} playlists={playlists} onRefresh={() => void refreshData()} onToast={notify} />; break;
    case 'live': content = <LiveStudio health={health} videos={videos} playlists={playlists} session={session} destination={destination} initialVideoId={draftVideoId} onClearDraft={() => setDraftVideoId(null)} onRefresh={() => void refreshData()} onToast={notify} />; break;
    case 'schedule': content = <SchedulePage videos={videos} playlists={playlists} schedules={schedules} health={health} destination={destination} onRefresh={() => void refreshData()} onToast={notify} />; break;
    case 'youtube': content = <YouTubePage destination={destination} youtube={youtube} onRefresh={() => void refreshData()} onToast={notify} />; break;
    case 'settings': content = <SettingsPage health={health} />; break;
    case 'admin': content = <AdminPage overview={adminOverview} onRefresh={() => void refreshData()} onToast={notify} />; break;
    default: content = <Dashboard user={user} health={health} videos={videos} playlists={playlists} session={session} sessions={sessions} destination={destination} onNavigate={setPage} onSelectVideo={openVideoPreview} onStartVideo={onStartVideo} />;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} user={user} health={health} onNavigate={setPage} onLogout={logout} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="app-main"><Header page={page} user={user} health={health} notifications={notifications} onMenu={() => setMenuOpen(true)} onMarkRead={() => { void api('/notifications/read', { method: 'POST' }); setNotifications((items) => items.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() }))); }} onToast={notify} />
        <main className="main-scroll">{content}<footer className="app-footer"><span>© 2026 Maya Cloud Live</span><span><span className="footer-status-dot" /> Server-side stream control</span><button onClick={() => setPage('settings')}>System status <ArrowUpRight size={12} /></button></footer></main>
      </div>
      {previewVideo && <Modal title={previewVideo.title} description={`${formatDuration(previewVideo.durationSeconds)} · ${previewVideo.width} × ${previewVideo.height}`} onClose={() => setPreviewVideo(null)} wide><div className="video-player-wrap"><video src={`/api/videos/${previewVideo.id}/preview`} controls autoPlay playsInline preload="metadata" /><div className="video-player-footer"><span><FileVideo2 size={14} /> {previewVideo.originalName}</span><span>{formatBytes(previewVideo.sizeBytes)}</span></div></div></Modal>}
      {playlistVideo && <Modal title="Add to playlist" description={`Choose a playlist for “${playlistVideo.title}”.`} onClose={() => setPlaylistVideo(null)}><div className="playlist-picker">{playlists.length === 0 ? <p className="muted">Create a playlist first.</p> : playlists.map((playlist) => <button key={playlist.id} onClick={() => void addToPlaylist(playlistVideo.id, playlist.id)}><span className="playlist-picker-icon"><ListMusic size={17} /></span><span><strong>{playlist.name}</strong><small>{playlist.videos.length} videos · {playlist.loopEnabled ? 'loop on' : 'loop off'}</small></span><ChevronRight size={16} /></button>)}</div></Modal>}
      {editingVideo && <EditVideoModal video={editingVideo} onClose={() => setEditingVideo(null)} onSave={(values) => void saveEditedVideo(editingVideo, values)} />}
      <NotificationsToast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function EditVideoModal({ video, onClose, onSave }: { video: Video; onClose: () => void; onSave: (values: { title: string; description: string }) => void }) {
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description);
  return <Modal title="Edit video details" description="Update how this video appears in your library." onClose={onClose}><form className="stack-form modal-form" onSubmit={(event) => { event.preventDefault(); onSave({ title, description }); }}><label>Video title<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={4000} /></label><div className="modal-actions"><button type="button" className="button button-ghost" onClick={onClose}>Cancel</button><PrimaryButton type="submit"><Check size={16} /> Save changes</PrimaryButton></div></form></Modal>;
}

export default App;
