import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 10 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function timeAgo(date: Date | null | undefined): string {
  return date ? formatDistanceToNow(date, { addSuffix: true, locale: es }) : "nunca";
}
