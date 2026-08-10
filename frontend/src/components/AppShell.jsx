/**
 * The frame every page renders inside: a persistent nav rail and a top bar.
 *
 * The rail is the reason the app reads as more than one screen — all seven
 * destinations are visible from anywhere. On mobile it collapses into a
 * temporary drawer behind the hamburger.
 */
import { useState } from 'react';
import {
  AppBar, Alert, Avatar, Box, Chip, Divider, Drawer, IconButton, List,
  ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Toolbar, Tooltip,
  Typography, useMediaQuery,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import NewCaseIcon from '@mui/icons-material/AddPhotoAlternate';
import QueueIcon from '@mui/icons-material/FactCheck';
import ReferralsIcon from '@mui/icons-material/Description';
import SettingsIcon from '@mui/icons-material/Settings';
import AdminIcon from '@mui/icons-material/AdminPanelSettings';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import CollapseIcon from '@mui/icons-material/KeyboardDoubleArrowLeft';
import ExpandIcon from '@mui/icons-material/KeyboardDoubleArrowRight';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import theme from '../theme';
import { PRACTICE_NAME } from '../branding';
import { useAuth } from '../services/AuthProvider';

export const RAIL_WIDTH = 232;
export const COLLAPSED_RAIL_WIDTH = 72;

// Order matters: this is the order the rail renders and the order a new user
// reads the product in. It follows how often a destination is used -- the
// dashboard is where everyone lands, the review queue is the day's work, and
// Administration sits with them because it now holds the practice records an
// admin reaches for. Intake is an occasional action, so it drops below those.
//
// Patients and Referrals are practice-wide records rather than daily
// destinations, so for an admin they live as tabs under Administration instead
// of spending a rail slot each.
//
// An orthodontist's job here is to work the cases assigned to them, so they get
// the queue, their own referrals, and their own settings -- nothing practice-wide.
// `doctor: true` marks the items they keep; everything else is admin-only. A
// doctor cannot reach /admin at all, so Referrals stays in their rail as a page
// of its own. The backend enforces the same split, so this only avoids showing
// dead links.
export const NAV_ITEMS = [
  { label: 'Dashboard', to: '/', icon: DashboardIcon },
  { label: 'Review Queue', to: '/queue', icon: QueueIcon, doctor: true },
  { label: 'Administration', to: '/admin', icon: AdminIcon },
  { label: 'New Case', to: '/upload', icon: NewCaseIcon },
  { label: 'Referrals', to: '/referrals', icon: ReferralsIcon, doctor: true, doctorOnly: true },
  { label: 'Settings', to: '/settings', icon: SettingsIcon, doctor: true },
];

/**
 * The routes a given role may navigate to.
 *
 * `doctorOnly` items are ones an admin reaches somewhere else -- Referrals is a
 * tab under Administration for them -- so showing it twice would be two links
 * to the same records.
 */
export function navItemsFor(isAdmin) {
  return isAdmin
    ? NAV_ITEMS.filter((item) => !item.doctorOnly)
    : NAV_ITEMS.filter((item) => item.doctor);
}

function NavList({ onNavigate, badges = {}, isAdmin = false, collapsed = false }) {
  const { pathname } = useLocation();
  const items = navItemsFor(isAdmin);

  return (
    <List component="nav" aria-label="Main navigation" sx={{ px: 1.5, py: 1 }}>
      {items.map(({ label, to, icon: Icon }) => {
        // '/' would otherwise match every route, so the dashboard is exact.
        const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
        const badge = badges[to];

        const item = (
          <ListItemButton
            key={to}
            component={NavLink}
            to={to}
            onClick={onNavigate}
            selected={active}
            aria-label={collapsed ? label : undefined}
            sx={{
              borderRadius: 2,
              mb: 0.25,
              px: collapsed ? 1.5 : 2,
              justifyContent: collapsed ? 'center' : 'flex-start',
              color: active ? 'primary.main' : 'text.secondary',
              '&.Mui-selected': {
                bgcolor: 'primary.light',
                '&:hover': { bgcolor: '#dcecff' },
              },
            }}
          >
            <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, color: 'inherit', justifyContent: 'center' }}>
              <Icon fontSize="small" />
            </ListItemIcon>
            {!collapsed && (
              <ListItemText
                primary={label}
                slotProps={{
                  primary: { variant: 'body2', fontWeight: active ? 600 : 500 },
                }}
              />
            )}
            {!collapsed && badge > 0 && (
              <Chip
                size="small"
                label={badge}
                sx={{
                  height: 20, minWidth: 20, fontSize: '0.7rem',
                  bgcolor: 'primary.main', color: 'common.white',
                }}
              />
            )}
          </ListItemButton>
        );
        return collapsed ? (
          <Tooltip key={to} title={label} placement="right">
            {item}
          </Tooltip>
        ) : item;
      })}
    </List>
  );
}

function Brand({ collapsed = false }) {
  return (
    <Box
      aria-label={collapsed ? PRACTICE_NAME : undefined}
      sx={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: 1.25, px: collapsed ? 1 : 2.25, py: 1.5 }}
    >
      <Box
        component="img"
        src="/passion-dental-logo.png"
        alt=""
        sx={{
          width: 38, height: 38, objectFit: 'contain', flexShrink: 0,
        }}
      />
      {!collapsed && (
        <Typography variant="h6" color="primary.dark" noWrap>
          {PRACTICE_NAME}
        </Typography>
      )}
    </Box>
  );
}

/** Signed-in identity, role, and the sign-out action. */
function UserMenu() {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState(null);

  if (!user) return null;

  const initials = (user.full_name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0]).join('').toUpperCase();

  async function handleLogout() {
    setAnchor(null);
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <Tooltip title={`${user.full_name} · ${isAdmin ? 'Administrator' : 'Orthodontist'}`}>
        <IconButton onClick={(e) => setAnchor(e.currentTarget)} size="small" sx={{ ml: 0.5 }}>
          <Avatar
            sx={{
              width: 32, height: 32, fontSize: '0.8rem', fontWeight: 600,
              bgcolor: isAdmin ? 'primary.dark' : 'primary.main',
            }}
          >
            {initials}
          </Avatar>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ px: 2, py: 1.25, minWidth: 210 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {user.full_name}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block">
            {user.email}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block">
            {isAdmin ? 'Administrator' : 'Orthodontist'}
            {user.primary_location ? ` · ${user.primary_location}` : ''}
          </Typography>
        </Box>
        <Divider />
        <MenuItem onClick={handleLogout}>
          <ListItemIcon><LogoutIcon fontSize="small" /></ListItemIcon>
          Sign out
        </MenuItem>
      </Menu>
    </>
  );
}

export default function AppShell({ children, health, badges }) {
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const { isAdmin } = useAuth();

  const modelInfo = health?.model;
  const unreachable = health?.status === 'unreachable';

  const rail = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Brand collapsed={!isMobile && railCollapsed} />
      <Divider />
      <Box sx={{ flexGrow: 1 }}>
        <NavList
          onNavigate={() => setDrawerOpen(false)}
          badges={badges}
          isAdmin={isAdmin}
          collapsed={!isMobile && railCollapsed}
        />
      </Box>
      {!isMobile && (
        <Box sx={{ p: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
          <Tooltip title={railCollapsed ? 'Expand navigation' : 'Collapse navigation'} placement="right">
            <IconButton
              size="small"
              aria-label={railCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              onClick={() => setRailCollapsed((value) => !value)}
              sx={{ width: '100%', borderRadius: 1 }}
            >
              {railCollapsed ? <ExpandIcon /> : <CollapseIcon />}
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {isMobile ? (
        <Drawer
          anchor="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          slotProps={{ paper: { sx: { width: RAIL_WIDTH } } }}
        >
          {rail}
        </Drawer>
      ) : (
        <Box
          component="aside"
          sx={{
            width: railCollapsed ? COLLAPSED_RAIL_WIDTH : RAIL_WIDTH, flexShrink: 0,
            borderRight: '1px solid', borderColor: 'divider',
            bgcolor: 'background.paper',
            position: 'sticky', top: 0, height: '100vh',
            transition: theme.transitions.create('width', { duration: theme.transitions.duration.shorter }),
            overflowX: 'hidden',
          }}
        >
          {rail}
        </Box>
      )}

      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <AppBar position="sticky">
          <Toolbar sx={{ minHeight: { xs: 60, md: 64 }, gap: 1.5 }}>
            {isMobile && (
              <IconButton edge="start" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
                <MenuIcon />
              </IconButton>
            )}
            <Box sx={{ flexGrow: 1 }} />

            {modelInfo?.num_classes != null && (
              <Tooltip
                title={
                  modelInfo.supports_pathology
                    ? `Model: ${modelInfo.path} · ${modelInfo.classes?.join(', ')}`
                    : `Model: ${modelInfo.path} — detects teeth only. It does not assess disease; all clinical findings are yours.`
                }
              >
                <Chip
                  size="small"
                  label={modelInfo.supports_pathology ? 'Detection + pathology' : 'Detection only'}
                  sx={{
                    display: { xs: 'none', sm: 'flex' },
                    bgcolor: modelInfo.supports_pathology ? 'healthy.light' : '#e5e7eb',
                    color: modelInfo.supports_pathology ? '#065f46' : '#374151',
                  }}
                />
              </Tooltip>
            )}

            <UserMenu />
          </Toolbar>
        </AppBar>

        {unreachable && (
          <Alert severity="error" sx={{ borderRadius: 0 }}>
            Cannot reach the backend. Start it with <code>python main.py</code>.
          </Alert>
        )}
        {modelInfo?.error && (
          <Alert severity="warning" sx={{ borderRadius: 0 }}>
            Model not loaded: {modelInfo.error}
          </Alert>
        )}

        <Box component="main" sx={{ flexGrow: 1, minWidth: 0 }}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}
