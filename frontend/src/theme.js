import { createTheme } from '@mui/material/styles';

const theme = createTheme({
    typography: {
        fontFamily: '"Avenir Next", Avenir, "Segoe UI", Arial, sans-serif',
        h6: { fontWeight: 600, letterSpacing: 0 },
        subtitle1: { fontWeight: 600, letterSpacing: 0 },
        subtitle2: { fontWeight: 500, letterSpacing: 0 },
        body2: { letterSpacing: 0 }
    },
    palette: {
        primary: {
            light: '#eaf4ff',
            main: '#2457d6',
            dark: '#173f9f',
            contrastText: '#ffffff',
        },
        secondary: {
            light: '#e9f9ff',
            main: '#27afe0',
            dark: '#087da9',
            contrastText: '#ffffff',
        },
        background: {
            default: '#f6f9fc',
            paper: '#ffffff',
        },
        text: {
            primary: '#20344d',
            secondary: '#65758a'
        },
        divider: '#dce6f0',
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
                    borderRadius: '6px',
                    boxShadow: 'none',
                    '&:hover': {
                        boxShadow: 'none',
                    },
                },
                containedPrimary: {
                    '&:hover': {
                        backgroundColor: '#173f9f',
                    },
                },
                outlined: {
                    borderColor: '#ccd9e7',
                    color: '#40556d',
                    '&:hover': {
                        backgroundColor: '#f2f7fc',
                        borderColor: '#9eb4ca',
                    }
                }
            },
        },
        MuiCard: {
            styleOverrides: {
                root: {
                    borderRadius: '8px',
                    boxShadow: 'none',
                    border: '1px solid #dce6f0',
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
                    color: '#20344d',
                    boxShadow: 'none',
                    borderBottom: '1px solid #dce6f0',
                }
            }
        },
        MuiTextField: {
            styleOverrides: {
                root: {
                    '& .MuiOutlinedInput-root': {
                        borderRadius: '8px',
                        backgroundColor: '#f8fbfe',
                        '& fieldset': {
                            borderColor: '#d5e1ec',
                        },
                        '&:hover fieldset': {
                            borderColor: '#a9bdcf',
                        },
                        '&.Mui-focused fieldset': {
                            borderColor: '#2457d6',
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
