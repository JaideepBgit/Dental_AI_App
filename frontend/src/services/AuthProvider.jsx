/**
 * Session state for the whole app.
 *
 * The server is the authority: this only caches what /api/me reports. Role is
 * never persisted to localStorage — a client-stored role could be edited, and
 * every backend guard re-reads it from the database anyway, so caching it would
 * add a lie surface without adding security.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { useApi } from './ApiProvider';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const api = useApi();
  const [user, setUser] = useState(null);
  // 'loading' until the first /api/me settles, so route guards do not bounce a
  // signed-in user to /login during the initial round trip.
  const [status, setStatus] = useState('loading');

  const refresh = useCallback(async () => {
    try {
      const me = await api.fetchMe();
      setUser(me);
      setStatus('authenticated');
      return me;
    } catch {
      setUser(null);
      setStatus('anonymous');
      return null;
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (email, password) => {
    const me = await api.login(email, password);
    setUser(me);
    setStatus('authenticated');
    return me;
  }, [api]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Clear locally even if the request failed: the cookie may already be gone.
      setUser(null);
      setStatus('anonymous');
    }
  }, [api]);

  const value = useMemo(() => ({
    user,
    status,
    loading: status === 'loading',
    isAuthenticated: status === 'authenticated',
    isAdmin: user?.role === 'ADMIN',
    isOrthodontist: user?.role === 'ORTHODONTIST',
    login,
    logout,
    refresh,
  }), [user, status, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
