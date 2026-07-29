import { useState, useEffect, useCallback, useRef } from 'react';
import { ref, get, set, onValue } from 'firebase/database';
import { db, firebaseConfigured } from './firebase';

const REPORTS_MAX = 300; // safety net only — daily archival is what actually keeps this bounded
const STALE_FREE_MS = 2 * 60 * 60 * 1000; // a free report older than this shows as low-confidence
const STALE_BUSY_MS = 4 * 60 * 60 * 1000; // a busy report older than this is assumed stale -> probably free
const DEFAULT_SESSION_MIN = 60; // assumed game length when we have no real history yet
const OPEN_HOUR = 8;
const CLOSE_HOUR = 22;
const VARAAMO_URL = 'https://varaamo.hel.fi/reservation-unit/665?duration=&date=&time=';

const COLORS = {
  page: '#FAFAFA',
  surface: '#FFFFFF',
  border: '#E4E4E1',
  bg: '#111111',
  line: '#333331',
  muted: '#8A8A85',
  clay: '#B0402F',
  green: '#3C6B45',
  yellow: '#111111',
  reserved: '#6B6B66',
  onAccent: '#FFFFFF',
};

const COURT_KEYS = ['court2', 'court3', 'court1'];

function defaultCourts() {
  return {
    court1: { name: 'Court 1', type: 'reserved' },
    court2: { name: 'Court 2', type: 'live', reports: [] },
    court3: { name: 'Court 3', type: 'live', reports: [] },
  };
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatAgo(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return 'just now';
  if (totalMin < 60) return `${totalMin} min ago`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

function formatClockTime(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h}:${String(m).padStart(2, '0')}`;
}

function formatClockTimeSec(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Everything about a live court's current state is derived from its report log:
// who said what, and when. No separate check-in/session bookkeeping.
function deriveCourtState(court, now) {
  const reports = court.reports || [];
  const latest = reports.length ? reports[reports.length - 1] : null;
  const busy = latest ? latest.busy : null;

  let busyStart = null;
  if (busy) {
    for (let i = reports.length - 1; i >= 0; i--) {
      if (reports[i].busy) busyStart = reports[i].t;
      else break;
    }
  }

  const ageMs = latest ? now - latest.t : Infinity;
  let displayBusy = busy === true;
  let lowConfidence = false;
  if (busy === true && ageMs > STALE_BUSY_MS) {
    displayBusy = false;
    lowConfidence = true;
  } else if (busy === false && ageMs > STALE_FREE_MS) {
    lowConfidence = true;
  }

  const statusLabel = displayBusy ? 'IN PLAY' : lowConfidence ? 'PROBABLY FREE' : 'FREE';
  return { reports, latest, busyStart, displayBusy, lowConfidence, statusLabel };
}

// Infer session lengths from busy->free pairs in the report log, for the estimate.
function deriveAvgDurationMin(reports) {
  const durations = [];
  let busyStart = null;
  for (const r of reports) {
    if (r.busy) {
      if (busyStart == null) busyStart = r.t;
    } else if (busyStart != null) {
      const d = (r.t - busyStart) / 60000;
      if (d > 0) durations.push(d);
      busyStart = null;
    }
  }
  if (!durations.length) return null;
  const recent = durations.slice(-20);
  return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
}

function DigitTiles({ text }) {
  return (
    <span
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 14,
        fontWeight: 500,
        letterSpacing: '0.02em',
        color: COLORS.muted,
      }}
    >
      {text}
    </span>
  );
}

function CourtLines() {
  return (
    <svg width="100%" height="20" viewBox="0 0 400 20" preserveAspectRatio="none" style={{ display: 'block', opacity: 0.35 }}>
      <line x1="0" y1="3" x2="400" y2="3" stroke={COLORS.line} strokeWidth="1.5" />
      <line x1="70" y1="14" x2="330" y2="14" stroke={COLORS.line} strokeWidth="1" strokeDasharray="4 4" />
      <line x1="200" y1="3" x2="200" y2="14" stroke={COLORS.line} strokeWidth="1" />
    </svg>
  );
}

function linkStyle(color) {
  return {
    background: 'transparent',
    border: 'none',
    color,
    opacity: 0.8,
    fontFamily: "'Archivo', sans-serif",
    fontSize: 11,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    textDecoration: 'none',
    borderBottom: `1px solid ${color}40`,
    padding: '0 0 1px 0',
    cursor: 'pointer',
  };
}

function btnStyle(color, bg, border) {
  return {
    fontFamily: "'Archivo', sans-serif",
    fontSize: 12,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.02em',
    color,
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 2,
    padding: '14px 20px',
    cursor: 'pointer',
  };
}

function reportBtnStyle(color, rgb) {
  return {
    fontFamily: "'Archivo', sans-serif",
    fontSize: 13,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.02em',
    color,
    background: `rgba(${rgb}, 0.08)`,
    border: `1.5px solid ${color}`,
    borderRadius: 2,
    padding: '16px 22px',
    cursor: 'pointer',
    flex: 1,
  };
}

function ReservationCard({ name }) {
  return (
    <div
      style={{
        background: COLORS.surface,
        borderRadius: 2,
        border: `1px solid ${COLORS.border}`,
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: "'Archivo', sans-serif",
          fontSize: 12,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: COLORS.line,
          opacity: 0.55,
        }}
      >
        {name}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: COLORS.reserved,
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "'Archivo', sans-serif",
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: '0.01em',
            color: COLORS.line,
          }}
        >
          88.888% BUSY
        </span>
      </div>

      <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.line, opacity: 0.65, margin: 0 }}>
        Any chance to play here?
      </p>

      <a
        href={VARAAMO_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          alignSelf: 'flex-start',
          fontFamily: "'Archivo', sans-serif",
          fontSize: 12,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.02em',
          color: COLORS.line,
          background: 'transparent',
          border: `1px solid ${COLORS.border}`,
          borderRadius: 2,
          padding: '14px 20px',
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        Check Varaamo ↗
      </a>
    </div>
  );
}

function CourtCard({ courtKey, court, now, onReport }) {
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2800);
  };

  useEffect(() => () => toastTimer.current && clearTimeout(toastTimer.current), []);

  const { reports, latest, busyStart, displayBusy, lowConfidence, statusLabel } = deriveCourtState(court, now);
  const elapsedMs = displayBusy && busyStart ? Math.max(0, now - busyStart) : 0;
  // Real average session length is still derived and kept in the background (the underlying
  // reports are always recorded), but the estimate below intentionally always assumes 60 min.
  const avgDuration = deriveAvgDurationMin(reports);

  let message = null;
  let freeAtLabel = null;
  let remainingNote = null;
  if (displayBusy) {
    const assumedMin = DEFAULT_SESSION_MIN;
    const remainingMin = assumedMin - elapsedMs / 60000;
    freeAtLabel = formatClockTime((busyStart ?? now) + assumedMin * 60000);
    remainingNote =
      remainingMin > 2
        ? `Assuming a ${DEFAULT_SESSION_MIN}-min session — expected free around ${freeAtLabel}.`
        : `Assuming a ${DEFAULT_SESSION_MIN}-min session — could free up any time now.`;
  } else if (!latest) {
    message = 'No reports yet — be the first.';
  } else if (!lowConfidence) {
    message = `${latest.name} said free ${formatAgo(now - latest.t)}.`;
  } else {
    message = `Last report ${formatAgo(now - latest.t)} (${latest.name}) — could be outdated.`;
  }

  const dotColor = displayBusy ? COLORS.clay : lowConfidence ? `${COLORS.green}77` : COLORS.green;
  const todayKey = new Date().toDateString();
  const recentLog = reports.filter((r) => new Date(r.t).toDateString() === todayKey).slice().reverse();

  return (
    <div
      style={{
        background: COLORS.surface,
        borderRadius: 2,
        border: `1px solid ${COLORS.border}`,
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span
          style={{
            fontFamily: "'Archivo', sans-serif",
            fontSize: 12,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: COLORS.line,
            opacity: 0.55,
          }}
        >
          {court.name}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: dotColor,
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "'Archivo', sans-serif",
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: '0.01em',
            color: dotColor,
          }}
        >
          {statusLabel}
        </span>
        {displayBusy && <DigitTiles text={formatElapsed(elapsedMs)} />}
      </div>

      {displayBusy && freeAtLabel && (
        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.muted, margin: 0 }}>
          {remainingNote}
        </p>
      )}

      {message && (
        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.line, opacity: 0.65, margin: 0 }}>
          {message}
        </p>
      )}

      <div style={{ display: 'flex', gap: 12 }}>
        <button
          onClick={() => {
            onReport(courtKey, false);
            showToast('Thanks — marked free.');
          }}
          style={reportBtnStyle(COLORS.green, '60,107,69')}
        >
          Free
        </button>
        <button
          onClick={() => {
            onReport(courtKey, true);
            showToast('Thanks — marked busy.');
          }}
          style={reportBtnStyle(COLORS.clay, '176,64,47')}
        >
          Busy
        </button>
      </div>

      <div
        style={{
          fontFamily: "'Archivo', sans-serif",
          fontSize: 11,
          color: COLORS.yellow,
          minHeight: 14,
          opacity: toast ? 1 : 0,
          transition: 'opacity 0.3s',
        }}
      >
        {toast}
      </div>

      {recentLog.length > 0 && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 16,
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <span
              style={{
                fontFamily: "'Archivo', sans-serif",
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: COLORS.line,
                opacity: 0.5,
              }}
            >
              Today's reports
            </span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: COLORS.muted }}>
              {recentLog.length}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: 150,
              overflowY: 'auto',
              paddingRight: 4,
            }}
          >
            {recentLog.map((r, i) => (
              <span key={i} style={{ fontFamily: "'Archivo', sans-serif", fontSize: 11, color: COLORS.muted }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: COLORS.clay, fontWeight: 600 }}>
                  {formatClockTimeSec(r.t)}
                </span>{' '}
                — {r.name} reports: {r.busy ? (r.mode === 'self' ? 'I am playing now' : 'someone is playing now') : 'court is free'}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label, ring, hatched }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: hatched
            ? 'repeating-linear-gradient(45deg, rgba(22,22,21,0.28), rgba(22,22,21,0.28) 2px, transparent 2px, transparent 4px)'
            : color,
          boxShadow: ring ? `0 0 0 2px ${COLORS.yellow}` : 'none',
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
}

function ScheduleTable({ courts, now }) {
  const hours = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) hours.push(h);
  const todayKey = new Date().toDateString();
  const liveCourtKeys = COURT_KEYS.filter((k) => courts[k].type === 'live');

  const eventsFor = (court) =>
    (court.reports || [])
      .filter((r) => new Date(r.t).toDateString() === todayKey)
      .map((r) => ({ t: r.t, busy: r.busy }));

  const stateAt = (events, t) => {
    let state = null;
    for (const e of events) {
      if (e.t <= t) state = e.busy;
      else break;
    }
    return state;
  };

  const statusFor = (court, hour) => {
    const hourStartDate = new Date();
    hourStartDate.setHours(hour, 0, 0, 0);
    const hourStart = hourStartDate.getTime();
    const hourEnd = hourStart + 60 * 60 * 1000;
    if (hourStart >= now) return 'future';
    const isNowHour = now >= hourStart && now < hourEnd;
    const evalAt = Math.min(hourEnd, now);
    const busy = stateAt(eventsFor(court), evalAt) === true;
    if (isNowHour) return busy ? 'now-busy' : 'now-free';
    return busy ? 'busy' : 'free';
  };

  const cellStyle = (status) => {
    const base = { width: 28, height: 28, borderRadius: 2, display: 'block' };
    if (status === 'future')
      return {
        ...base,
        background:
          'repeating-linear-gradient(45deg, rgba(22,22,21,0.1), rgba(22,22,21,0.1) 3px, transparent 3px, transparent 6px)',
        border: `1px solid ${COLORS.line}22`,
      };
    if (status === 'busy') return { ...base, background: COLORS.clay };
    if (status === 'free') return { ...base, background: COLORS.green };
    if (status === 'now-busy') return { ...base, background: COLORS.clay, boxShadow: `0 0 0 2px ${COLORS.yellow}` };
    if (status === 'now-free') return { ...base, background: COLORS.green, boxShadow: `0 0 0 2px ${COLORS.yellow}` };
    return base;
  };

  return (
    <div style={{ marginTop: 40 }}>
      <div
        style={{
          fontFamily: "'Archivo', sans-serif",
          fontSize: 12,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: COLORS.line,
          opacity: 0.55,
          marginBottom: 14,
        }}
      >
        Today's schedule · {OPEN_HOUR}:00–{CLOSE_HOUR}:00
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 5 }}>
          <thead>
            <tr>
              <th style={{ padding: 0 }} />
              {hours.map((h) => (
                <th
                  key={h}
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: 10,
                    color: COLORS.line,
                    opacity: 0.55,
                    fontWeight: 400,
                    padding: '0 2px',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {liveCourtKeys.map((key) => (
              <tr key={key}>
                <td
                  style={{
                    fontFamily: "'Archivo', sans-serif",
                    fontSize: 12,
                    color: COLORS.line,
                    opacity: 0.85,
                    paddingRight: 10,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {courts[key].name}
                </td>
                {hours.map((h) => (
                  <td key={h}>
                    <span style={cellStyle(statusFor(courts[key], h))} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 14,
          flexWrap: 'wrap',
          marginTop: 16,
          fontFamily: "'Archivo', sans-serif",
          fontSize: 11,
          color: COLORS.line,
          opacity: 0.7,
        }}
      >
        <LegendDot color={COLORS.green} label="Free" />
        <LegendDot color={COLORS.clay} label="Busy" />
        <LegendDot color={COLORS.clay} ring label="Now" />
        <LegendDot hatched label="Not yet today" />
      </div>
      <p
        style={{
          fontFamily: "'Archivo', sans-serif",
          fontSize: 11,
          color: COLORS.line,
          opacity: 0.55,
          marginTop: 8,
          maxWidth: 480,
        }}
      >
        Hours with no reports assume free. 
      </p>
    </div>
  );
}

function NameModal({ initialValue, showModeChoice, onSubmit, onCancel }) {
  const [value, setValue] = useState(initialValue || '');
  const [mode, setMode] = useState('self');

  const modeOptions = [
    { key: 'self', label: 'I am playing now' },
    { key: 'observed', label: 'Someone is playing' },
  ];

  const radioRowStyle = (selected) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontFamily: "'Archivo', sans-serif",
    fontSize: 14,
    color: COLORS.line,
    background: selected ? COLORS.page : 'transparent',
    border: `1px solid ${selected ? COLORS.bg : COLORS.border}`,
    borderRadius: 2,
    padding: '13px 14px',
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
  });

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 2,
          padding: 24,
          maxWidth: 320,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <span style={{ fontFamily: "'Archivo', sans-serif", fontSize: 14, fontWeight: 600, color: COLORS.line }}>
          What's your name?
        </span>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(value, mode);
          }}
          placeholder="e.g. Alex"
          maxLength={24}
          style={{
            fontFamily: "'Archivo', sans-serif",
            fontSize: 15,
            padding: '12px 14px',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 2,
            outline: 'none',
            color: COLORS.line,
            background: COLORS.page,
          }}
        />

        {showModeChoice && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontFamily: "'Archivo', sans-serif", fontSize: 11, color: COLORS.line, opacity: 0.7 }}>
              Is this you playing, or someone else?
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {modeOptions.map((opt) => {
                const selected = mode === opt.key;
                return (
                  <button key={opt.key} onClick={() => setMode(opt.key)} style={radioRowStyle(selected)}>
                    <span
                      style={{
                        width: 15,
                        height: 15,
                        borderRadius: '50%',
                        border: `1.5px solid ${COLORS.bg}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {selected && (
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: COLORS.bg, display: 'block' }} />
                      )}
                    </span>
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 11, color: COLORS.line, opacity: 0.6, margin: 0 }}>
          Shown next to your report with the time. Asked fresh each time — not saved on this device.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
          <button onClick={onCancel} style={linkStyle(COLORS.line)}>
            Cancel
          </button>
          <button onClick={() => onSubmit(value, mode)} style={btnStyle(COLORS.onAccent, COLORS.bg, COLORS.bg)}>
            Report
          </button>
        </div>
      </div>
    </div>
  );
}

// Moves any reports that aren't from today into a permanent, dated archive key
// (one per court per day) so history is never deleted — only moved off the live
// blob that drives the current on-screen status. Runs on every sync; it's a no-op
// (cheap filter, no storage writes) except right after a day boundary is crossed.
async function archiveOldReports(courts) {
  const todayKey = new Date().toDateString();
  let changed = false;
  const next = { ...courts };

  for (const key of COURT_KEYS) {
    const court = courts[key];
    if (court.type !== 'live') continue;
    const reports = court.reports || [];
    const older = reports.filter((r) => new Date(r.t).toDateString() !== todayKey);
    if (older.length === 0) continue;

    changed = true;
    const todays = reports.filter((r) => new Date(r.t).toDateString() === todayKey);

    const byDate = {};
    for (const r of older) {
      const d = new Date(r.t);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      (byDate[dateKey] = byDate[dateKey] || []).push(r);
    }

    for (const [dateKey, entries] of Object.entries(byDate)) {
      const archiveRef = ref(db, `archive/${key}/${dateKey}`);
      try {
        let existing = [];
        try {
          const snap = await get(archiveRef);
          existing = snap.exists() ? snap.val() : [];
        } catch {
          existing = [];
        }
        const merged = [...existing, ...entries];
        await set(archiveRef, merged);
      } catch (e) {
        console.error('archive save failed', e);
      }
    }

    next[key] = { ...court, reports: todays };
  }

  return { courts: next, changed };
}

const courtsRef = ref(db, 'courts');

function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 10.5V2.7A1.2 1.2 0 0 1 4.2 1.5H11" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ContactCard({ label, value, href, copyText }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const doCopy = (e) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(copyText);
    } catch {
      // clipboard API unavailable — silently ignore, card still works as a link if there is one
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => () => copyTimer.current && clearTimeout(copyTimer.current), []);

  const Wrapper = href ? 'a' : 'div';
  const wrapperProps = href ? { href, onClick: doCopy } : { onClick: doCopy };

  return (
    <Wrapper
      {...wrapperProps}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        background: COLORS.page,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 2,
        padding: '10px 12px',
        cursor: 'pointer',
        textDecoration: 'none',
        color: COLORS.line,
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ fontFamily: "'Archivo', sans-serif", fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: COLORS.muted }}>
          {label}
        </span>
        <span style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, fontWeight: 600, color: COLORS.line, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {copied ? 'Copied!' : value}
        </span>
      </span>
      <span
        onClick={doCopy}
        title="Copy"
        style={{ display: 'flex', alignItems: 'center', color: COLORS.muted, cursor: 'pointer', flexShrink: 0 }}
      >
        <CopyIcon />
      </span>
    </Wrapper>
  );
}

function AboutPopover({ onClose }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 'calc(100% + 10px)',
        right: 0,
        width: 320,
        maxWidth: '85vw',
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 4,
        boxShadow: '0 8px 24px rgba(17,17,17,0.12)',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        zIndex: 70,
        textAlign: 'left',
      }}
    >
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, fontWeight: 700, color: COLORS.line, margin: 0 }}>
          🎾 Why this project?
        </h3>
        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.line, opacity: 0.75, margin: 0, lineHeight: 1.5 }}>
          You arrive at the courts.
          <br />
          They're full.
          <br />
          You wait... and wait... and waaaaiiiittttt.
          <br />
          Sound familiar?
        </p>
        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.line, opacity: 0.75, margin: 0, lineHeight: 1.5 }}>
          That's why I built this little community project—to help players share live court status. A quick tap on{' '}
          <strong>Free</strong> or <strong>Busy</strong> helps keep the information up to date for everyone.
        </p>
        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.line, opacity: 0.75, margin: 0, lineHeight: 1.5 }}>
          Before heading over, you can check the latest reports and estimated finish times. They're only a rough
          guide, but hopefully they save you a trip—or at least a little waiting.
        </p>
        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.line, opacity: 0.75, margin: 0, lineHeight: 1.5 }}>
          I hope it helps a bit... or maybe even a lot. 😊
        </p>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, fontWeight: 700, color: COLORS.line, margin: 0 }}>
          ❤️ Feedback &amp; Ideas
        </h3>
        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.line, opacity: 0.75, margin: 0, lineHeight: 1.5 }}>
          I'd love to hear your feedback, ideas, or bug reports.
        </p>
        <ContactCard label="Email" value="yvtinm@gmail.com" copyText="yvtinm@gmail.com" href="mailto:yvtinm@gmail.com" />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, fontWeight: 700, color: COLORS.line, margin: 0 }}>
          ☕ Support the Project
        </h3>
        <p style={{ fontFamily: "'Archivo', sans-serif", fontSize: 13, color: COLORS.line, opacity: 0.75, margin: 0, lineHeight: 1.5 }}>
          If you'd like to encourage me to keep building this project, you can buy me a coffee.
        </p>
        <ContactCard label="MobilePay" value="+358 44 927 5173" copyText="+358 44 927 5173" />
      </section>
    </div>
  );
}

export default function CourtWatch() {
  const [courts, setCourts] = useState(defaultCourts());
  const [lastTypedName, setLastTypedName] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [lastSync, setLastSync] = useState(Date.now());
  const [connectionError, setConnectionError] = useState(false);
  const [configMissing, setConfigMissing] = useState(!firebaseConfigured);
  const [showHelp, setShowHelp] = useState(false);
  const [nameModalOpen, setNameModalOpen] = useState(false);
  const [pendingReport, setPendingReport] = useState(null);

  const saveShared = useCallback(async (data) => {
    try {
      await set(courtsRef, data);
    } catch (e) {
      console.error('storage save failed', e);
    }
  }, []);

  // Firebase pushes updates to every connected client the moment the data changes —
  // no polling needed. We still run the same day-boundary archival check on every
  // incoming update; it's a cheap no-op except right after midnight.
  useEffect(() => {
    if (!firebaseConfigured) {
      setConfigMissing(true);
      setLoading(false);
      return;
    }

    let settled = false;
    const timeoutId = setTimeout(() => {
      if (!settled) {
        console.error('Firebase did not respond within 8s — likely a wrong config or unreachable database.');
        setConnectionError(true);
        setLoading(false);
      }
    }, 8000);

    const unsubscribe = onValue(
      courtsRef,
      (snapshot) => {
        settled = true;
        clearTimeout(timeoutId);
        const data = snapshot.exists() ? snapshot.val() : defaultCourts();
        archiveOldReports(data).then(({ courts: archived, changed }) => {
          if (changed) {
            set(courtsRef, archived); // triggers this listener again with the cleaned-up data
          } else {
            setCourts(data);
            setLastSync(Date.now());
            setConnectionError(false);
            setLoading(false);
          }
        });
      },
      (error) => {
        settled = true;
        clearTimeout(timeoutId);
        console.error('Firebase connection error', error);
        setConnectionError(true);
        setLoading(false);
      }
    );
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(timeoutId);
      unsubscribe();
      clearInterval(tickId);
    };
  }, []);

  const submitReport = useCallback(
    (courtKey, busy, name, mode) => {
      setCourts((prev) => {
        const court = prev[courtKey];
        const entry = busy ? { name, busy, mode, t: Date.now() } : { name, busy, t: Date.now() };
        const reports = [...(court.reports || []), entry].slice(-REPORTS_MAX);
        const next = { ...prev, [courtKey]: { ...court, reports } };
        saveShared(next);
        return next;
      });
    },
    [saveShared]
  );

  const requestReport = useCallback((courtKey, busy) => {
    setPendingReport({ courtKey, busy });
    setNameModalOpen(true);
  }, []);

  const handleNameSubmit = useCallback(
    (rawName, mode) => {
      const name = rawName.trim().slice(0, 24);
      if (!name) return;
      setLastTypedName(name);
      setNameModalOpen(false);
      if (pendingReport) {
        submitReport(pendingReport.courtKey, pendingReport.busy, name, mode);
        setPendingReport(null);
      }
    },
    [pendingReport, submitReport]
  );

  const handleNameCancel = useCallback(() => {
    setNameModalOpen(false);
    setPendingReport(null);
  }, []);

  const secondsAgo = Math.max(0, Math.round((now - lastSync) / 1000));

  return (
    <div
      style={{
        background: COLORS.page,
        minHeight: '100%',
        padding: 'clamp(32px, 6vw, 56px) 20px 48px',
        fontFamily: "'Archivo', sans-serif",
      }}
    >
      <style>{`
        button:focus-visible { outline: 2px solid ${COLORS.yellow}; outline-offset: 2px; }
        button { transition: opacity 0.15s; }
        button:hover { opacity: 0.85; }
      `}</style>

      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h1
              style={{
                fontFamily: "'Archivo', sans-serif",
                fontSize: 'clamp(32px, 8vw, 44px)',
                fontWeight: 700,
                color: COLORS.line,
                margin: 0,
                lineHeight: 1.1,
                letterSpacing: '-0.015em',
              }}
            >
              COURTWATCH?
            </h1>
            <p
              style={{
                fontFamily: "'Archivo', sans-serif",
                fontSize: 14,
                color: COLORS.line,
                opacity: 0.6,
                margin: '8px 0 0',
              }}
            >
              Powered by you &amp; the community.
            </p>
          </div>
          <div
            style={{ position: 'relative' }}
            onMouseEnter={() => setShowHelp(true)}
            onMouseLeave={() => setShowHelp(false)}
          >
            <button
              onClick={() => setShowHelp((o) => !o)}
              aria-label="About this project"
              style={{
                flexShrink: 0,
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: `1px solid ${COLORS.yellow}88`,
                background: 'transparent',
                color: COLORS.yellow,
                fontFamily: "'Archivo', sans-serif",
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                marginTop: 2,
              }}
            >
              ?
            </button>
            {showHelp && (
              <div
                onClick={() => setShowHelp(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'transparent' }}
              />
            )}
            {showHelp && <AboutPopover onClose={() => setShowHelp(false)} />}
          </div>
        </div>
        <CourtLines />

        {configMissing ? (
          <div
            style={{
              marginTop: 32,
              padding: 20,
              border: `1px solid ${COLORS.clay}`,
              borderRadius: 2,
              background: COLORS.surface,
              maxWidth: 480,
            }}
          >
            <p style={{ color: COLORS.clay, fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>
              Firebase isn't configured yet
            </p>
            <p style={{ color: COLORS.line, fontSize: 13, opacity: 0.85, margin: 0 }}>
              Open <code>src/firebase.js</code> and replace every <code>REPLACE_ME</code> value with your real
              Firebase project config, then redeploy. See README.md for the exact steps.
            </p>
          </div>
        ) : loading ? (
          <div style={{ color: COLORS.line, opacity: 0.6, fontSize: 13, marginTop: 32 }}>Loading court status…</div>
        ) : connectionError ? (
          <div
            style={{
              marginTop: 32,
              padding: 20,
              border: `1px solid ${COLORS.clay}`,
              borderRadius: 2,
              background: COLORS.surface,
              maxWidth: 480,
            }}
          >
            <p style={{ color: COLORS.clay, fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>
              Can't reach the database
            </p>
            <p style={{ color: COLORS.line, fontSize: 13, opacity: 0.85, margin: 0 }}>
              Double-check the values in <code>src/firebase.js</code> match your Firebase project exactly, and that
              Realtime Database rules allow read/write (see README.md). Reports made while disconnected won't be
              saved.
            </p>
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                gap: 20,
                margin: '32px 0 28px',
                flexWrap: 'wrap',
                fontFamily: "'Archivo', sans-serif",
                fontSize: 14,
                color: COLORS.line,
              }}
            >
              {COURT_KEYS.map((key) => {
                const c = courts[key];
                if (c.type === 'reserved') {
                  return (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS.reserved, display: 'inline-block' }}
                      />
                      {c.name}: book via Varaamo
                    </div>
                  );
                }
                const { statusLabel, displayBusy } = deriveCourtState(c, now);
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: displayBusy ? COLORS.clay : COLORS.green,
                        display: 'inline-block',
                      }}
                    />
                    {c.name}: {statusLabel.toLowerCase()}
                  </div>
                );
              })}
            </div>

            <ScheduleTable courts={courts} now={now} />

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: 20,
                marginTop: 40,
              }}
            >
              {COURT_KEYS.map((key) =>
                courts[key].type === 'reserved' ? (
                  <ReservationCard key={key} name={courts[key].name} />
                ) : (
                  <CourtCard key={key} courtKey={key} court={courts[key]} now={now} onReport={requestReport} />
                )
              )}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 40,
                flexWrap: 'wrap',
                gap: 8,
                fontFamily: "'Archivo', sans-serif",
                fontSize: 12,
                color: COLORS.line,
                opacity: 0.55,
              }}
            >
              <span>{connectionError ? 'Connection issue — retrying…' : `Live · updated ${secondsAgo}s ago`}</span>
              <button
                onClick={() => {
                  get(courtsRef).then((snap) => {
                    const data = snap.exists() ? snap.val() : defaultCourts();
                    setCourts(data);
                    setLastSync(Date.now());
                  });
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: COLORS.line,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  fontSize: 12,
                  opacity: 0.8,
                }}
              >
                Refresh now
              </button>
            </div>
          </>
        )}
      </div>

      {nameModalOpen && (
        <NameModal
          initialValue={lastTypedName}
          showModeChoice={!!pendingReport && pendingReport.busy === true}
          onSubmit={handleNameSubmit}
          onCancel={handleNameCancel}
        />
      )}
    </div>
  );
}
