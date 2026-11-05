import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/* ---------- Toast ---------- */
const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast">{msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ---------- Carga de datos ---------- */
export function useAsync<T>(fn: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fn());
    } catch (e: any) {
      setError(e?.message || 'Error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}

/** Ejecuta una acción con estado de carga y toast */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (okMsg) toast(okMsg);
        return r;
      } catch (e: any) {
        const det = Array.isArray(e?.details) ? ': ' + e.details.map((d: any) => d.label || d.reason || JSON.stringify(d)).join('; ') : '';
        toast(`⚠ ${e?.message || 'Error'}${det}`);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

/* ---------- Formularios ---------- */
export function Field({ label, help, children }: { label?: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {help && <span className="help">{help}</span>}
    </div>
  );
}

export function Text({ value, onChange, ...rest }: { value: any; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest} />;
}
export function Num({ value, onChange, ...rest }: { value: any; onChange: (v: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} {...rest} />;
}
export function Area({ value, onChange, tall, ...rest }: { value: any; onChange: (v: string) => void; tall?: boolean } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  return <textarea className={tall ? 'tall' : ''} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest} />;
}
export function Select({ value, onChange, options, ...rest }: { value: any; onChange: (v: string) => void; options: Array<[string, string]> | string[] } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {options.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}
export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Editor de pares clave/valor (encabezados HTTP) */
export function KeyValue({ value, onChange, keyLabel = 'Encabezado', valueLabel = 'Valor' }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; keyLabel?: string; valueLabel?: string }) {
  const entries = Object.entries(value || {});
  const set = (list: Array<[string, string]>) => onChange(Object.fromEntries(list.filter(([k]) => k !== '' || true)));
  return (
    <div>
      {entries.map(([k, v], i) => (
        <div className="kv" key={i}>
          <input type="text" placeholder={keyLabel} value={k} onChange={(e) => set(entries.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
          <input type="text" placeholder={valueLabel} value={v} onChange={(e) => set(entries.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
          <button className="btn sm ghost" onClick={() => set(entries.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn sm" onClick={() => onChange({ ...(value || {}), ['']: '' })}>
        + Agregar
      </button>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: Array<[string, string]>; active: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map(([k, l]) => (
        <button key={k} className={active === k ? 'active' : ''} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="empty">
      <span className="spinner" />
    </div>
  );
}

export function ErrorBox({ error }: { error?: string | null }) {
  return error ? <div className="alert err">{error}</div> : null;
}

export function StatusBadge({ status }: { status?: string }) {
  const map: Record<string, string> = {
    ready: 'ok', active: 'ok', running: 'ok', done: 'ok', accepted: 'ok', SENT: 'info', DELIVERED: 'info', READ: 'info', REPLIED: 'ok', RECOVERED: 'ok',
    processing: 'warn', queued: 'warn', crawling: 'warn', paused: 'warn', SCHEDULED: 'warn', SENDING: 'warn', PENDING: '', uploaded: 'warn', draft: '',
    error: 'err', FAILED: 'err', cancelled: 'err', CANCELLED: 'err', rejected: 'err', OPTOUT: 'err', inactive: 'err',
  };
  return <span className={`badge ${map[status || ''] ?? ''}`}>{status || '—'}</span>;
}

/** Entrada de archivo con botón */
export function FilePick({ accept, onPick, label = 'Seleccionar archivo', disabled }: { accept?: string; onPick: (f: File) => void; label?: string; disabled?: boolean }) {
  return (
    <label className={`btn ${disabled ? 'disabled' : ''}`} style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}>
      {label}
      <input
        type="file"
        hidden
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
    </label>
  );
}

/** Actualiza un objeto anidado por ruta "a.b.c" (inmutable) */
export function setIn<T>(obj: T, path: string, value: any): T {
  const keys = path.split('.');
  const clone: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) };
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...(cur[k] || {}) };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}
