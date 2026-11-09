/** Visible label for a server-classified "Test Test" assessment. */
export function TestBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      className={`ml-2 align-middle font-bold tracking-wide rounded bg-amber-100 text-amber-800 ${size === 'md' ? 'text-xs px-2 py-0.5' : 'text-[10px] px-1.5 py-0.5'}`}
      title="Test assessment: free, and excluded from reports, billing and integrations"
      data-testid="test-badge"
    >
      TEST
    </span>
  );
}
