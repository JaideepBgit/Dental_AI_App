import { createTheme } from '@mui/material/styles';

const theme = createTheme({
    typography: {
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        h6: { fontWeight: 600, letterSpacing: '-0.02em' },
        subtitle1: { fontWeight: 600, letterSpacing: '-0.01em' },
        subtitle2: { fontWeight: 500, letterSpacing: '-0.01em' },
        body2: { letterSpacing: '0em' }
    },
    palette: {
        primary: {
            main: 'rgb(99, 51, 148)',
            contrastText: '#ffffff',
        },
        secondary: {
            main: '#f3f4f6', // soft grey
            contrastText: '#111827', // dark text
        },
        background: {
            default: '#fafafa',
            paper: '#ffffff',
        },
        text: {
            primary: '#111827', // Crisp dark grey
            secondary: '#6b7280' // Muted grey
        },
        divider: '#e5e7eb', // subtle borders
        // Semantic colors (muted/pastel versions for badges)
        healthy: { main: '#10b981', light: '#d1fae5' },
        caries: { main: '#f59e0b', light: '#fef3c7' },
        impacted: { main: '#ef4444', light: '#fee2e2' },
    },
    components: {
        MuiButton: {
            styleOverrides: {
                root: {
                    textTransform: 'none',
                    fontWeight: 500,
                    borderRadius: '8px',
                    boxShadow: 'none',
                    '&:hover': {
                        boxShadow: 'none',
                    },
                },
                containedPrimary: {
                    '&:hover': {
                        backgroundColor: 'rgba(99, 51, 148, 0.9)', 
                    },
                },
                outlined: {
                    borderColor: '#e5e7eb',
                    color: '#374151',
                    '&:hover': {
                        backgroundColor: '#f9fafb',
                        borderColor: '#d1d5db',
                    }
                }
            },
        },
        MuiCard: {
            styleOverrides: {
                root: {
                    borderRadius: '16px',
                    boxShadow: 'none', // Flat design
                    border: '1px solid #e5e7eb', // Delicate border
                }
            }
        },
        MuiPaper: {
            styleOverrides: {
                root: {
                    backgroundImage: 'none',
                }
            }
        },
        MuiAppBar: {
            styleOverrides: {
                root: {
                    backgroundColor: '#ffffff',
                    color: '#111827',
                    boxShadow: 'none',
                    borderBottom: '1px solid #e5e7eb',
                }
            }
        },
        MuiTextField: {
            styleOverrides: {
                root: {
                    '& .MuiOutlinedInput-root': {
                        borderRadius: '12px',
                        backgroundColor: '#f9fafb',
                        '& fieldset': {
                            borderColor: '#e5e7eb',
                        },
                        '&:hover fieldset': {
                            borderColor: '#d1d5db',
                        },
                        '&.Mui-focused fieldset': {
                            borderColor: 'rgb(99, 51, 148)',
                        },
                    }
                }
            }
        },
        MuiChip: {
            styleOverrides: {
                root: {
                    borderRadius: '6px', // slight curve instead of full pill
                    fontWeight: 500,
                }
            }
        },
        MuiTooltip: {
            styleOverrides: {
                tooltip: {
                    fontSize: '0.75rem',
                    padding: '6px 10px',
                    borderRadius: '6px',
                }
            }
        }
    },
});

export default theme;
