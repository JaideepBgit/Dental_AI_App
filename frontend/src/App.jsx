/**
 * Application entry: providers only.
 *
 * Everything that used to live here — queue loading, case state, upload,
 * validation, layout — now sits in hooks, services and pages. See AppRoutes for
 * the route table.
 */
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline } from '@mui/material';
import { BrowserRouter } from 'react-router-dom';

import AppRoutes from './AppRoutes';
import { ApiProvider } from './services/ApiProvider';
import { AuthProvider } from './services/AuthProvider';
import theme from './theme';
import './App.css';

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ApiProvider>
        {/* AuthProvider sits inside ApiProvider (it calls the client) and outside
            the router, so the session is resolved once for every route. */}
        <AuthProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </ApiProvider>
    </ThemeProvider>
  );
}
