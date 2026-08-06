/**
 * Supplies the api client to the tree.
 *
 * Pages call useApi() instead of importing the client, so a test renders the
 * same component against a stub by wrapping it in this provider. Nothing below
 * this line knows that axios exists.
 */
import { createContext, useContext } from 'react';
import { apiClient } from './apiClient';

const ApiContext = createContext(apiClient);

export function ApiProvider({ client = apiClient, children }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi() {
  return useContext(ApiContext);
}
