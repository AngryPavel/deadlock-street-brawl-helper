/** Show the round's observed count; an unknown count is a conservative zero explicitly marked unread. */
export function RerollCounterLabel({ remaining }: { remaining?: number | null }) {
  const known = typeof remaining === 'number' && Number.isInteger(remaining) && remaining >= 0;
  return (
    <div className="local-reroll-counter" aria-live="polite">
      Re-rolls: {known ? remaining : '0 (unread)'}
    </div>
  );
}
