import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** Must match the key the pre-paint script in index.html reads. */
const STORAGE_KEY = 'claude-devtools:theme';

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * Theme lives on `<html data-theme>`; the palette swap is pure CSS variables
 * (see styles.css), so nothing re-renders on toggle beyond this hook's own
 * state. `index.html` applies the stored value before first paint to avoid a
 * flash of the wrong palette.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );

  useEffect(() => {
    apply(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      // An explicit choice wins over the OS preference from here on.
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
