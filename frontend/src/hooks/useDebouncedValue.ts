import { useState, useEffect } from 'react';

/**
 * Debounces a value changes by specified milliseconds
 */
export function useDebouncedValue<T>(value: T, delayMs = 280): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}
