/**
 * Owns the review queue: loading, filtering, searching and retrying.
 *
 * Filtering happens server-side so the 200-row limit applies to matches rather
 * than to the unfiltered head of the table. The search term is debounced, so
 * typing a name issues one request instead of one per keystroke.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../services/apiClient';

const DEFAULT_DEBOUNCE_MS = 300;

export function useCases({ api = apiClient, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Admin-only owner filter: '', 'unassigned', 'mine', or a user id. The
  // backend ignores it for doctors, whose results are always their own cases.
  const [assigned, setAssigned] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), debounceMs);
    return () => clearTimeout(timer);
  }, [search, debounceMs]);

  // A slow response for an old filter must not overwrite a newer one.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const token = requestRef.current + 1;
    requestRef.current = token;

    setLoading(true);
    try {
      const data = await api.fetchQueue({ status, search: debouncedSearch, assigned });
      if (requestRef.current !== token) return;
      setItems(data.items || []);
      setError(null);
    } catch (err) {
      if (requestRef.current !== token) return;
      setError(err.message);
      setItems([]);
    } finally {
      if (requestRef.current === token) setLoading(false);
    }
  }, [api, status, debouncedSearch, assigned]);

  useEffect(() => { load(); }, [load]);

  const retry = useCallback(async (xrayId) => {
    try {
      await api.retryXray(xrayId);
      await load();
      return { ok: true };
    } catch (err) {
      setError(err.message);
      return { ok: false, message: err.message };
    }
  }, [api, load]);

  const remove = useCallback(async (xrayId) => {
    try {
      const result = await api.deleteXray(xrayId);
      await load();
      return { ok: true, result };
    } catch (err) {
      // Deliberately not removed from `items`: the row is still there on the
      // server, and dropping it locally would imply a delete that did not happen.
      return { ok: false, message: err.message };
    }
  }, [api, load]);

  // Counts drive the filter chips. Derived from the loaded page, so they
  // describe the current result set rather than the whole database.
  const counts = useMemo(() => {
    const tally = { all: items.length };
    items.forEach((item) => {
      tally[item.status] = (tally[item.status] || 0) + 1;
    });
    return tally;
  }, [items]);

  return {
    items, loading, error, counts,
    status, setStatus,
    search, setSearch,
    assigned, setAssigned,
    refresh: load, retry, remove,
  };
}
