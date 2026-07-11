/**
 * Season 2 theme provider — persists the user's dark/light choice under its
 * own AsyncStorage key so the classic settings store stays untouched.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { S2ThemeContext, S2ThemeName, s2Theme } from './tokens';

const STORAGE_KEY = 'tms-s2-theme';

export function S2ThemeProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState<S2ThemeName>('dark');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => {
        if (v === 'light' || v === 'dark') setName(v);
      })
      .catch(() => {});
  }, []);

  const toggleTheme = useCallback(() => {
    setName((prev) => {
      const next: S2ThemeName = prev === 'dark' ? 'light' : 'dark';
      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme: s2Theme(name), toggleTheme }), [name, toggleTheme]);

  return <S2ThemeContext.Provider value={value}>{children}</S2ThemeContext.Provider>;
}
