/**
 * Render an appointment date relative to today.
 *
 * Dates arrive as plain 'YYYY-MM-DD' strings. They are parsed as local rather
 * than passed to `new Date(string)`, which treats them as midnight UTC and can
 * render as the previous day anywhere west of Greenwich.
 */
export function formatAppointment(value) {
  if (!value) return 'No date';

  const [y, m, d] = String(value).split('-').map(Number);
  if (!y || !m || !d) return value;

  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Math.round((date - today) / 86400000);
  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  if (days === 0) return `${label} · today`;
  if (days === 1) return `${label} · tomorrow`;
  if (days > 1) return `${label} · in ${days}d`;
  return `${label} · ${Math.abs(days)}d ago`;
}
