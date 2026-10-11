/**
 * Inline SVG icon set for the admin area.
 *
 * The project has no icon dependency, and adding one for a single surface is not
 * worth the bundle cost, so these are hand-drawn on a shared 24px grid with a
 * consistent 1.7px stroke. They inherit `currentColor` and are marked
 * `aria-hidden` — the surrounding control always carries the accessible label.
 */

function Icon({ children, size = 18, className = "", ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function DashboardIcon(props) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="7.5" height="8.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6" />
      <rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.6" />
      <rect x="3" y="14.5" width="7.5" height="6.5" rx="1.6" />
    </Icon>
  );
}

export function UsersIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.5 14.4A5.5 5.5 0 0 1 20.5 20" />
    </Icon>
  );
}

export function BookOpenIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 6.5C10.5 5 8.3 4.3 4.5 4.3v13.2c3.8 0 6 .7 7.5 2.2 1.5-1.5 3.7-2.2 7.5-2.2V4.3c-3.8 0-6 .7-7.5 2.2Z" />
      <path d="M12 6.5v13.2" />
    </Icon>
  );
}

export function NetworkIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="5" r="2.4" />
      <circle cx="5" cy="19" r="2.4" />
      <circle cx="19" cy="19" r="2.4" />
      <path d="M12 7.4v4.1M12 11.5 6.4 16.9M12 11.5l5.6 5.4" />
    </Icon>
  );
}

export function ShieldIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 3 5 5.6v5.7c0 4 2.9 7.5 7 8.7 4.1-1.2 7-4.7 7-8.7V5.6L12 3Z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </Icon>
  );
}

export function ChartIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 4v16h16" />
      <path d="M8 15.5v-3M12 15.5V8M16 15.5v-5.5" />
    </Icon>
  );
}

export function ClipboardIcon(props) {
  return (
    <Icon {...props}>
      <rect x="5" y="4.5" width="14" height="16" rx="2" />
      <path d="M9 4.5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
      <path d="M9 10h6M9 13.5h6M9 17h3.5" />
    </Icon>
  );
}

export function SettingsIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 12a7.4 7.4 0 0 0-.1-1.2l1.9-1.5-1.9-3.3-2.3.9a7.3 7.3 0 0 0-2-1.2L14.6 3H9.4l-.4 2.5a7.3 7.3 0 0 0-2 1.2l-2.3-.9-1.9 3.3 1.9 1.5a7.4 7.4 0 0 0 0 2.4L2.8 15l1.9 3.3 2.3-.9a7.3 7.3 0 0 0 2 1.2l.4 2.5h5.2l.4-2.5a7.3 7.3 0 0 0 2-1.2l2.3.9 1.9-3.3-1.9-1.5c.06-.4.1-.8.1-1.2Z" />
    </Icon>
  );
}

export function BellIcon(props) {
  return (
    <Icon {...props}>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z" />
      <path d="M13.7 19a2 2 0 0 1-3.4 0" />
    </Icon>
  );
}

export function SearchIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m20 20-3.6-3.6" />
    </Icon>
  );
}

export function ChevronDownIcon(props) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon(props) {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function LogoutIcon(props) {
  return (
    <Icon {...props}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 12H3m0 0 3.2-3.2M3 12l3.2 3.2" />
    </Icon>
  );
}

export function MenuIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Icon>
  );
}

export function CloseIcon(props) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function TrendUpIcon(props) {
  return (
    <Icon {...props}>
      <path d="m3 16 5.5-5.5 3.5 3.5L21 5" />
      <path d="M15 5h6v6" />
    </Icon>
  );
}

export function TrendDownIcon(props) {
  return (
    <Icon {...props}>
      <path d="m3 8 5.5 5.5 3.5-3.5L21 19" />
      <path d="M21 13v6h-6" />
    </Icon>
  );
}

export function CalendarIcon(props) {
  return (
    <Icon {...props}>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9.5h16M8.5 3v4M15.5 3v4" />
    </Icon>
  );
}

export function AlertTriangleIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
      <path d="M12 10v4.2M12 17.2h.01" />
    </Icon>
  );
}

export function UserCheckIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="9.5" cy="8" r="3.2" />
      <path d="M4 20a5.5 5.5 0 0 1 11 0" />
      <path d="m15.5 12.5 2 2 3.5-3.7" />
    </Icon>
  );
}

export function UserMinusIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="9.5" cy="8" r="3.2" />
      <path d="M4 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 14h5" />
    </Icon>
  );
}

export function SparklesIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 13.6 9 19 10.5 13.6 12 12 17.5 10.4 12 5 10.5 10.4 9 12 3.5Z" />
      <path d="M18.5 16.5 19.2 19l2.3.7-2.3.7-.7 2.4-.7-2.4-2.4-.7 2.4-.7.8-2.3Z" />
    </Icon>
  );
}

export function CheckIcon(props) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Icon>
  );
}

export function ClockIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.5V12l3 1.8" />
    </Icon>
  );
}

export function LayersIcon(props) {
  return (
    <Icon {...props}>
      <path d="m12 3 9 4.8-9 4.8-9-4.8L12 3Z" />
      <path d="m3 12.3 9 4.8 9-4.8M3 16.8 12 21.6l9-4.8" />
    </Icon>
  );
}

export function RefreshIcon(props) {
  return (
    <Icon {...props}>
      <path d="M20 11a8 8 0 0 0-13.7-5.2L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 13.7 5.2L20 16" />
      <path d="M20 20v-4h-4" />
    </Icon>
  );
}

export function CapIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 4 2.5 8.5 12 13l9.5-4.5L12 4Z" />
      <path d="M6.5 10.7v4.6c0 1.2 2.5 2.4 5.5 2.4s5.5-1.2 5.5-2.4v-4.6" />
      <path d="M21.5 8.5v5.2" />
    </Icon>
  );
}

export function InboxIcon(props) {
  return (
    <Icon {...props}>
      <path d="M3.5 13.5 6 5.5h12l2.5 8v4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4Z" />
      <path d="M3.5 13.5h4.2l1 2h6.6l1-2h4.2" />
    </Icon>
  );
}
