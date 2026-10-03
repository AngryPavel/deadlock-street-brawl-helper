import { useCallback, useState } from 'react';

const PREFIX = 'brawl.';

function readStorage<T>(key: string, isValid: (v: unknown) => v is T, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode, quota) — the state still works for this session */
  }
}

/** `useState` backed by `localStorage` under the `brawl.` key prefix, validated with `isValid` on read. */
export function usePersisted<T>(key: string, isValid: (v: unknown) => v is T, fallback: T) {
  const [value, setValueState] = useState<T>(() => readStorage(key, isValid, fallback));
  const setValue = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValueState((prev) => {
        const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
        writeStorage(key, resolved);
        return resolved;
      }),
    [key],
  );
  return [value, setValue] as const;
}

export const isNumber = (v: unknown): v is number => typeof v === 'number';
export const isString = (v: unknown): v is string => typeof v === 'string';
export const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');
