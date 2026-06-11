import { useQueryClient } from '@tanstack/react-query';
import { Icon, type IconName } from '../components/Icon';
import { apiFetch } from '../lib/api';

interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: IconName;
}

const NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', href: '/admin', icon: 'overview' },
  { key: 'usage', label: 'Usage', href: '/admin/usage', icon: 'usage' },
  { key: 'client-keys', label: 'Client keys', href: '/admin/client-keys', icon: 'client-keys' },
  { key: 'accounts', label: 'Upstream', href: '/admin/accounts', icon: 'accounts' },
  { key: 'models', label: 'Models', href: '/admin/models', icon: 'models' },
  { key: 'aliases', label: 'Aliases', href: '/admin/aliases', icon: 'aliases' },
  { key: 'combos', label: 'Combos', href: '/admin/combos', icon: 'combos' },
  { key: 'quota', label: 'Quota', href: '/admin/quota', icon: 'quota' },
  { key: 'transports', label: 'Proxies', href: '/admin/transports', icon: 'transports' },
  { key: 'console', label: 'Console', href: '/admin/console', icon: 'console' },
  { key: 'settings', label: 'Settings', href: '/admin/settings', icon: 'settings' },
];

export function Sidebar({ current, mobileOpen, onMobileClose }: { current: string; mobileOpen?: boolean; onMobileClose?: () => void }) {
  const qc = useQueryClient();
  // Read from cache only — App.PrimeCache() populates this on mount. Reading
  // via getQueryData (synchronous) avoids re-running the query on every
  // Sidebar re-render.
  const me = qc.getQueryData<{ authed: boolean; passwordSet: boolean }>(['me']);
  const settings = qc.getQueryData<{ version: string | null }>(['settings']);
  return (
    <>
      {mobileOpen && <div class="sidebar-overlay" onClick={onMobileClose} />}
      <aside class={`sidebar${mobileOpen ? ' sidebar-open' : ''}`}>
      <div class="brand">
        <span class="brand-mark">
          <span class="brand-mark-full">
            kelola<em>router</em>
          </span>
          <span class="brand-mark-mini">
            k<em>r</em>
          </span>
        </span>
        <span class="brand-tag">{me?.passwordSet ? 'PROTECTED' : 'OPEN MODE'}</span>
      </div>
      <nav class="nav">
        {NAV.map((n) => (
          <a
            key={n.key}
            href={`#${n.href}`}
            class={`nav-item${n.key === current ? ' active' : ''}`}
            onClick={onMobileClose}
          >
            <span class="nav-icon">
              <Icon name={n.icon} />
            </span>
            <span class="nav-label">{n.label}</span>
          </a>
        ))}
      </nav>
      <div class="user-card">
        <span>{settings?.version ? `v${settings.version}` : ''}</span>
        {me?.passwordSet && (
          <button
            onClick={async () => {
              await apiFetch('/api/logout', { method: 'POST' });
              qc.clear();
              location.hash = '/';
            }}
          >
            Sign out
          </button>
        )}
      </div>
    </aside>
    </>
  );
}
