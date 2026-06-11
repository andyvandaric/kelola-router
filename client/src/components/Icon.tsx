import type { JSX } from 'preact';

export type IconName =
  | 'overview'
  | 'usage'
  | 'client-keys'
  | 'accounts'
  | 'models'
  | 'aliases'
  | 'combos'
  | 'quota'
  | 'settings'
  | 'transports'
  | 'console'
  | 'search';

// Switch dispatch: V8 prefers predictable branches over Record lookups,
// and bundlers can drop unused cases if the component is tree-shaken.
function renderPath(name: IconName): JSX.Element {
  switch (name) {
    case 'overview':
      return (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </>
      );
    case 'usage':
      return (
        <>
          <path d="M3 3v18h18" />
          <path d="M7 14l4-4 4 4 5-5" />
        </>
      );
    case 'client-keys':
      return (
        <>
          <circle cx="8" cy="15" r="4" />
          <path d="M10.85 12.15L19 4" />
          <path d="M18 5l3 3" />
          <path d="M15 8l3 3" />
        </>
      );
    case 'accounts':
      return (
        <>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      );
    case 'models':
      return (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 9h6v6H9z" />
        </>
      );
    case 'aliases':
      return (
        <>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </>
      );
    case 'combos':
      return (
        <>
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="8" cy="6" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="16" cy="18" r="1.5" />
        </>
      );
    case 'quota':
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </>
      );
    case 'settings':
      return (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </>
      );
    case 'search':
      return (
        <>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </>
      );
    case 'transports':
      return (
        <>
          <circle cx="5" cy="12" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="19" cy="18" r="2" />
          <path d="M7 12h6" />
          <path d="M13 12l4-5" />
          <path d="M13 12l4 5" />
        </>
      );
    case 'console':
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l3 3-3 3" />
          <path d="M13 15h4" />
        </>
      );
  }
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {renderPath(name)}
    </svg>
  );
}
