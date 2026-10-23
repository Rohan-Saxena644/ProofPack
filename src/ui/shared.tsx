'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowUpRight,
  Archive,
  CircleHelp,
  FlaskConical,
  FolderClock,
  Layers3,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import type { Status } from '@/core/contracts';
export function Shell({ children, mode }: { children: React.ReactNode; mode?: string }) {
  const path = usePathname();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-icon">
            <Layers3 size={22} />
          </span>
          ProofPack<span className="beta">BETA</span>
        </Link>
        <div className="workspace">
          <span className="workspace-avatar">P</span>
          <div>
            Personal workspace<small>Local environment</small>
          </div>
          <span className="online-dot" />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          <Link className={path === '/' ? 'nav-item active' : 'nav-item'} href="/">
            <Plus size={18} />
            New run<span className="keycap">N</span>
          </Link>
          <Link
            className={path.includes('/runs') ? 'nav-item active' : 'nav-item'}
            href="/#history"
          >
            <FolderClock size={18} />
            Run history
          </Link>
          <Link className="nav-item" href="/#demo">
            <FlaskConical size={18} />
            Demo playground
            <ArrowUpRight size={14} />
          </Link>
        </nav>
        <nav>
          <Link className={path === '/storage' ? 'nav-item active' : 'nav-item'} href="/storage">
            <Archive size={18} />
            Evidence storage
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <ShieldCheck size={20} />
            <strong>Your evidence stays here.</strong>
            <p>
              Browser execution and evidence are local. Hosted models receive the brief and page
              observations.
            </p>
            <span className="mode-label">
              {mode ? `${mode.toUpperCase()} MODE` : 'LOCAL WORKSPACE'}
            </span>
          </div>
          <a
            className="help-link"
            href="https://github.com/topics/playwright"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={16} />
            Built with open tools
            <ArrowUpRight size={13} />
          </a>
          <div className="user-line">
            <span className="user-avatar">L</span>
            <div>
              Local developer<small>Slow and steady. Well evidenced.</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Workspace</span>
            <span className="slash">/</span>
            {path === '/storage'
              ? 'Evidence storage'
              : path === '/'
                ? 'New run'
                : path.endsWith('/report')
                  ? 'Evidence report'
                  : 'Run details'}
          </div>
          <span className="local-indicator">
            <span className="online-dot" />
            Local-first workspace
          </span>
        </header>
        <main className="content">{children}</main>
        <footer className="footer">
          <span>ProofPack · Built for the work after the work.</span>
          <span>Open source · MIT</span>
        </footer>
      </div>
    </div>
  );
}
export function Badge({ status }: { status: Status | string }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {status.replace('_', ' ')}
    </span>
  );
}
export const duration = (start: number, end?: number | null) => {
  const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body;
}
