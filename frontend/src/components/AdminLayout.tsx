import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut, type User } from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import { get } from '../lib/api';
import { Loading } from './ui';

export interface Me {
  uid: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
}

function Login({ error }: { error?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(error || '');
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card" style={{ width: 380 }}>
        <div className="brand" style={{ color: 'var(--text)', padding: '0 0 12px' }}>
          <span className="brand-mark" style={{ color: '#fff' }}>X</span> XSIA Claude
        </div>
        <h2>Administrador</h2>
        <p className="hint">Inicia sesión para administrar agentes y campañas.</p>
        {err && <div className="alert err">{err}</div>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await signInWithEmailAndPassword(auth, email, password);
            } catch (x: any) {
              setErr('Credenciales inválidas');
            }
          }}
        >
          <div className="field"><label>Correo</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label>Contraseña</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          <button className="btn primary" style={{ width: '100%' }}>Entrar</button>
        </form>
        <div className="muted small" style={{ textAlign: 'center', margin: '12px 0' }}>o</div>
        <button className="btn" style={{ width: '100%' }} onClick={() => signInWithPopup(auth, googleProvider).catch((e) => setErr(e.message))}>
          Continuar con Google
        </button>
      </div>
    </div>
  );
}

export default function AdminLayout() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => onAuthStateChanged(auth, setUser), []);
  useEffect(() => {
    if (!user) return setMe(null);
    get<Me>('/me')
      .then(setMe)
      .catch((e) => setErr(e.message));
  }, [user]);

  if (user === undefined) return <Loading />;
  if (!user) return <Login />;
  if (err)
    return (
      <div style={{ padding: 40 }}>
        <div className="alert err">{err}</div>
        <button className="btn" onClick={() => signOut(auth).then(() => setErr(''))}>Cerrar sesión</button>
      </div>
    );
  if (!me) return <Loading />;

  const nav = (to: string, label: string) => (
    <NavLink to={to} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}>
      {label}
    </NavLink>
  );
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="brand-mark">X</span> XSIA Claude</div>
        <div className="nav-group">Chat</div>
        {nav('/admin/agents', 'Agentes')}
        <div className="nav-group">Recovery</div>
        {nav('/admin/recovery', 'Campañas')}
        {nav('/admin/suppressions', 'No contactar')}
        <div className="nav-group">Configuración</div>
        {nav('/admin/lines', 'Líneas WhatsApp')}
        {nav('/admin/dealers', 'Distribuidores')}
        {me.role === 'admin' && nav('/admin/users', 'Usuarios')}
        <div className="user">
          <div style={{ color: '#fff' }}>{me.email}</div>
          <div>Rol: {me.role}</div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => signOut(auth)}>Salir</button>
        </div>
      </aside>
      <main className="main">
        <Outlet context={me} />
      </main>
    </div>
  );
}
