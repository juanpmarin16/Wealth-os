import { useEffect, useState, type FormEvent } from 'react';
import PortfolioWorkspace from './PortfolioWorkspace';
import './App.css';

const API_URL = 'https://wealth-os-market-data.onrender.com';

export default function App() {
  const [token, setToken] = useState(() => { try { return sessionStorage.getItem('wealth-os-session-token') || ''; } catch { return ''; } });
  const [checking, setChecking] = useState(Boolean(token));
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    fetch(API_URL + '/api/portfolio', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } })
      .then(response => { if (!response.ok) throw new Error('Your session has expired. Please sign in again.'); })
      .catch(() => { if (active) { setToken(''); try { sessionStorage.removeItem('wealth-os-session-token'); } catch { /* session storage unavailable */ } } })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch(API_URL + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ password }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload.token !== 'string') throw new Error(payload?.detail || 'Sign-in failed.');
      try { sessionStorage.setItem('wealth-os-session-token', payload.token); } catch { /* token remains in memory */ }
      setToken(payload.token); setPassword('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  }
  function signOut() { setToken(''); try { sessionStorage.removeItem('wealth-os-session-token'); } catch { /* ignore */ } }

  if (checking) return <div className="auth-screen"><div className="auth-card"><div className="brand-mark">W</div><h1>Connecting to Wealth OS</h1><p>Verifying your secure session…</p></div></div>;
  if (!token) return <div className="auth-screen"><div className="auth-card"><div className="auth-brand"><div className="brand-mark">W</div><div><b>WEALTH OS</b><small>PORTFOLIO ANALYTICS</small></div></div><div className="eyebrow">PRIVATE WORKSPACE</div><h1>Welcome back</h1><p>Sign in to access your portfolio research and simulation workspace.</p><form onSubmit={signIn}><label htmlFor="access-password">Access password</label><input id="access-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required placeholder="Enter your password"/>{error&&<div className="alert">{error}</div>}<button className="button button-primary full-width" type="submit" disabled={busy||!password}>{busy?'Signing in…':'Sign in securely'}</button></form><small className="auth-note">Your session is protected by the Wealth OS API.</small></div></div>;
  return <><PortfolioWorkspace/><button className="signout-button" onClick={signOut} title="Sign out">Sign out</button></>;
}
