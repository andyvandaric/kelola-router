import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { CommandPalette } from '../components/CommandPalette';
import { apiFetch } from '../lib/api';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

const Accounts = lazy(() => import('../pages/Accounts').then((m) => ({ default: m.Accounts })));
const Aliases = lazy(() => import('../pages/Aliases').then((m) => ({ default: m.Aliases })));
const ClientKeys = lazy(() => import('../pages/ClientKeys').then((m) => ({ default: m.ClientKeys })));
const Combos = lazy(() => import('../pages/Combos').then((m) => ({ default: m.Combos })));
const Login = lazy(() => import('../pages/Login').then((m) => ({ default: m.Login })));
const Models = lazy(() => import('../pages/Models').then((m) => ({ default: m.Models })));
const NotFound = lazy(() => import('../pages/NotFound').then((m) => ({ default: m.NotFound })));
const Overview = lazy(() => import('../pages/Overview').then((m) => ({ default: m.Overview })));
const Quota = lazy(() => import('../pages/Quota').then((m) => ({ default: m.Quota })));
const Settings = lazy(() => import('../pages/Settings').then((m) => ({ default: m.Settings })));
const Transports = lazy(() => import('../pages/Transports').then((m) => ({ default: m.Transports })));
const Usage = lazy(() => import('../pages/Usage').then((m) => ({ default: m.Usage })));
const Console = lazy(() => import('../pages/Console').then((m) => ({ default: m.Console })));

const KNOWN_ROUTES = [
  'overview',
  'usage',
  'client-keys',
  'accounts',
  'models',
  'aliases',
  'combos',
  'quota',
  'transports',
  'console',
  'settings',
];

function Page({ current }: { current: string }) {
  const { data: me, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<{ authed: boolean; passwordSet: boolean }>('/api/me'),
    retry: false,
  });
  if (isLoading)
    return (
      <>
        <TopBar title="Loading…" />
        <p style={{ padding: 36, color: 'var(--text-3)' }}>Loading…</p>
      </>
    );
  if (me?.passwordSet && !me.authed) return <Login />;
  if (!KNOWN_ROUTES.includes(current)) return <NotFound route={`/admin/${current}`} />;
  switch (current) {
    case 'usage':
      return <Usage />;
    case 'client-keys':
      return <ClientKeys />;
    case 'accounts':
      return <Accounts />;
    case 'models':
      return <Models />;
    case 'aliases':
      return <Aliases />;
    case 'combos':
      return <Combos />;
    case 'quota':
      return <Quota />;
    case 'transports':
      return <Transports />;
    case 'console':
      return <Console />;
    case 'settings':
      return <Settings />;
    case 'overview':
      return <Overview />;
    default:
      return <NotFound route={`/admin/${current}`} />;
  }
}

export function AppShell() {
  const [current, setCurrent] = useState<string>(() => {
    const h = location.hash.replace(/^#\/admin\/?/, '').split('?')[0];
    return h || 'overview';
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace(/^#\/admin\/?/, '').split('?')[0];
      setCurrent(h || 'overview');
    };
    window.addEventListener('hashchange', onHash);

    const gMap: Record<string, string> = {
      o: '/admin',
      u: '/admin/usage',
      c: '/admin/client-keys',
      a: '/admin/accounts',
      m: '/admin/models',
      l: '/admin/aliases',
      q: '/admin/quota',
      t: '/admin/transports',
      n: '/admin/console',
      s: '/admin/settings',
    };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === '?' && !inField) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (e.key === 'g' && !inField) {
        e.preventDefault();
        const handler = (ev: KeyboardEvent) => {
          if (gMap[ev.key]) location.hash = gMap[ev.key];
        };
        document.addEventListener('keydown', handler, { once: true });
        setTimeout(() => document.removeEventListener('keydown', handler), 1000);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div class="app-layout">
      <a href="#main-content" class="skip-link">Skip to content</a>
      <Sidebar current={current} mobileOpen={mobileNav} onMobileClose={() => setMobileNav(false)} />
      <main class="main" id="main-content">
        <button
          class="hamburger"
          onClick={() => setMobileNav(true)}
          aria-label="Open navigation"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <Suspense fallback={<p style={{ padding: 36, color: 'var(--text-3)' }}>Loading…</p>}>
          <Page current={current} />
        </Suspense>
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(href) => {
          location.hash = href;
          setPaletteOpen(false);
        }}
      />
      {helpOpen && (
        <div class="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div
            class="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            style={{ maxWidth: 400 }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setHelpOpen(false); }}
          >
            <div class="modal-header">
              <div class="modal-title">Keyboard shortcuts</div>
              <button class="modal-close" onClick={() => setHelpOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div class="modal-body" style={{ display: 'grid', gap: 8, fontSize: 13 }}>
              <div>
                <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> — command palette
              </div>
              <div>
                <kbd>g</kbd> then <kbd>o</kbd> — overview
              </div>
              <div>
                <kbd>g</kbd> then <kbd>u</kbd> — usage
              </div>
              <div>
                <kbd>g</kbd> then <kbd>c</kbd> — client keys
              </div>
              <div>
                <kbd>g</kbd> then <kbd>a</kbd> — accounts
              </div>
              <div>
                <kbd>g</kbd> then <kbd>m</kbd> — models
              </div>
              <div>
                <kbd>g</kbd> then <kbd>l</kbd> — aliases
              </div>
              <div>
                <kbd>g</kbd> then <kbd>q</kbd> — quota
              </div>
              <div>
                <kbd>g</kbd> then <kbd>n</kbd> — console
              </div>
              <div>
                <kbd>g</kbd> then <kbd>s</kbd> — settings
              </div>
              <div>
                <kbd>?</kbd> — this help
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
