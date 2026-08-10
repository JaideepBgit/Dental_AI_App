/**
 * Referrals — every signed slip in one place.
 *
 * Previously a referral PDF was only reachable from the case you had just
 * signed; there was no way back to an earlier one.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CircularProgress, Container, Table, TableBody,
  TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import PdfIcon from '@mui/icons-material/PictureAsPdf';
import { Link as RouterLink } from 'react-router-dom';

import { useApi } from '../services/ApiProvider';
import PageHeader from '../components/PageHeader';

/**
 * `embedded` renders this as a panel inside the Administration tabs, where the
 * tab already names the section and the outer page supplies the padding. A
 * doctor still gets it as a page of its own from their nav rail.
 */
export default function ReferralsPage({ embedded = false }) {
  const api = useApi();
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      api.fetchReferrals({ search })
        .then((data) => { if (!cancelled) { setItems(data.items || []); setError(null); } })
        .catch((err) => { if (!cancelled) setError(err.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, search]);

  const searchField = (
    <TextField
      size="small"
      placeholder="Search by dentist"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      slotProps={{
        input: {
          startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />,
        },
      }}
      sx={{ minWidth: 260 }}
    />
  );

  const Frame = embedded ? Box : Container;
  const frameProps = embedded
    ? {}
    : { maxWidth: 'lg', sx: { py: { xs: 2, md: 4 } } };

  return (
    <Frame {...frameProps}>
      {embedded ? (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
          {searchField}
        </Box>
      ) : (
        <PageHeader
          title="Referrals"
          subtitle="Signed referral slips, newest first."
          action={searchField}
        />
      )}

      {error && <Alert severity="error" sx={{ mb: 2.5, borderRadius: 2 }}>{error}</Alert>}

      <Card>
        {loading && items.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : items.length === 0 ? (
          <Box sx={{ px: 3, py: 8, textAlign: 'center' }}>
            <Typography variant="subtitle1" sx={{ mb: 0.5 }}>No referrals yet</Typography>
            <Typography variant="body2" color="text.secondary">
              A referral is created when a dentist signs off a case.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 720 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Patient</TableCell>
                  <TableCell>MRN</TableCell>
                  <TableCell>Signed by</TableCell>
                  <TableCell>Date</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{r.patient_name}</TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">{r.mrn}</Typography>
                    </TableCell>
                    <TableCell>{r.doctor_name || '—'}</TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {r.generated_at ? new Date(r.generated_at).toLocaleDateString() : '—'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" component={RouterLink} to={`/case/${r.xray_id}`}>
                        Case
                      </Button>
                      <Button
                        size="small"
                        startIcon={<PdfIcon fontSize="small" />}
                        href={`${api.baseUrl}${r.pdf_url}`}
                        target="_blank"
                        rel="noopener"
                        disabled={!r.pdf_available}
                      >
                        PDF
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Card>
    </Frame>
  );
}
