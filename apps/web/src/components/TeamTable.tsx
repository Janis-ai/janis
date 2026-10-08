import type { CSSProperties, ReactNode } from 'react';
import { Bell, Shield, Users } from 'lucide-react';

/** Shared roster-table chrome — the agent Team card and Settings → Team
 *  render the same Member | Alerts | Role | (actions) table, so the markup
 *  and column geometry live here to keep them identical. */
export const teamTh: CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  padding: '0 8px 6px 0',
};
export const teamTd: CSSProperties = { padding: '8px 8px 8px 0', verticalAlign: 'middle' };

const COLUMNS = [
  { icon: Users, label: 'Member' },
  { icon: Bell, label: 'Alerts', width: 96 },
  { icon: Shield, label: 'Role', width: 200 },
] as const;

export function TeamTable({ children }: { children: ReactNode }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16, fontSize: 13 }}>
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th key={c.label} style={{ ...teamTh, ...('width' in c ? { width: c.width } : {}) }}>
              <span className="row" style={{ gap: 6 }}>
                <c.icon size={12} /> {c.label}
              </span>
            </th>
          ))}
          <th style={{ ...teamTh, width: 34 }} />
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function TeamRow({ children }: { children: ReactNode }) {
  return <tr style={{ borderTop: '1px solid var(--border)' }}>{children}</tr>;
}

export function MemberCell({
  name,
  email,
  isYou,
  children,
}: {
  name: string;
  email: string;
  isYou: boolean;
  children?: ReactNode;
}) {
  return (
    <td style={teamTd}>
      {name}
      {isYou && <span className="muted"> (You)</span>}{' '}
      <span className="muted">· {email}</span>
      {children}
    </td>
  );
}
