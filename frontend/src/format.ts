export function timeLabel(value: string, now = Date.now()): string {
  const date = new Date(value);
  const elapsed = Math.max(0, now - date.getTime());
  if (elapsed < 60000) return 'Just now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const stateLabel = {
  new: 'Not generated', generating: 'Preparing draft', failed: 'Needs another attempt',
  draft: 'Awaiting review', approved: 'Approved', rejected: 'Needs investigation',
};
