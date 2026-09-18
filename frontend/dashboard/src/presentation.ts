export function shortId(value: string | null | undefined) {
  return value ? `${value.slice(0, 10)}...` : '-';
}

export function relativeTime(value: string | null | undefined, now = Date.now()) {
  if (!value) return 'Not reported';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function exactTime(value: string | null | undefined) {
  if (!value) return 'Not reported';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Unknown';
}
