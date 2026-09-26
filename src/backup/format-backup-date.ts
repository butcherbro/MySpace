/** A snapshot timestamp (Unix seconds) as a short local date and time. */
export function formatBackupDate(createdAtSecs: number): string {
  const date = new Date(createdAtSecs * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
