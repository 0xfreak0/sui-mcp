import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../config.js";

export function clampPageSize(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}
