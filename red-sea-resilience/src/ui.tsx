import { useEffect, useRef, useState } from 'react';

/* ---------- bento primitives (shared by every panel) ---------- */
export const GR: Record<string, string[]> = {
  blue: ['#b9a6ff', '#2e43ff', '#6d7dff', '#05082a'],
  graph: ['#9a9aa8', '#3a3a44', '#55555f', '#060608'],
  pink: ['#ffb3d6', '#ff2a85', '#ff6aa8', '#3a031c'],
  copper: ['#f6bf96', '#c2683a', '#dc8a5c', '#1d0b05'],
  green: ['#a6e8c8', '#36956f', '#58b58c', '#061d15'],
  lime: ['#f4ffb8', '#a3c400', '#c9e03a', '#121700'],
};

type CardProps = {
  id?: string;
  className?: string;
  tone?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

export const Card = ({ id, className = '', tone, style, children }: CardProps) => {
  const c = tone ? GR[tone] : undefined;
  return (
    <section className={`card ${className}${c ? '' : ' glass'}`} id={id} style={style}>
      {c && (
        <>
          <div
            className="g"
            style={{ background: `linear-gradient(180deg,${c[0]} 0%,${c[1]} 36%,${c[1]} 74%,${c[2]} 100%)` }}
          />
          <div className="core" style={{ background: c[3] }} />
        </>
      )}
      <div className="in-c">{children}</div>
      <div className="rim" />
    </section>
  );
};

const F: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['0', '0', '0', '0', '0', '0', '1'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00', '00', '00', '00', '00', '00', '00'],
};

export function DotNum({ text, pitch = 7 }: { text: string; pitch?: number }) {
  const cells: number[][] = [];
  let x = 0;
  for (const ch of text) {
    const g = F[ch] || F[' '];
    for (let r = 0; r < 7; r++) for (let k = 0; k < g[0].length; k++) if (g[r][k] === '1') cells.push([x + k, r]);
    x += g[0].length + 1;
  }
  return (
    <svg className="dots" width={Math.max(1, x - 1) * pitch} height={7 * pitch} role="img" aria-label={text}>
      {cells.map(([c, r], i) => (
        <circle key={i} cx={c * pitch + pitch / 2} cy={r * pitch + pitch / 2} r={pitch * 0.36} fill="#fff" />
      ))}
    </svg>
  );
}

export function useCount(to: number, dur = 900) {
  const [v, setV] = useState(0);
  const cur = useRef(0);
  useEffect(() => {
    const from = cur.current;
    const t0 = performance.now();
    let id = 0;
    const f = (n: number) => {
      const t = Math.min(1, (n - t0) / dur);
      cur.current = from + (to - from) * (1 - Math.pow(1 - t, 3));
      setV(cur.current);
      if (t < 1) id = requestAnimationFrame(f);
    };
    id = requestAnimationFrame(f);
    return () => cancelAnimationFrame(id);
  }, [to, dur]);
  return v;
}

export const Ticks = ({ frac, n = 36 }: { frac: number; n?: number }) => (
  <svg className="ticks" height="22" viewBox={`0 0 ${n * 8} 22`} preserveAspectRatio="none" aria-hidden="true">
    {Array.from({ length: n }, (_, i) => (
      <line
        key={i}
        x1={i * 8 + 2}
        x2={i * 8 + 2}
        y1={i % 6 === 0 ? 2 : 8}
        y2="20"
        stroke={i / (n - 1) <= frac ? '#E8FF1F' : 'rgba(255,255,255,.28)'}
        strokeWidth="1.6"
        strokeLinecap="round"
        style={{ transition: `stroke .2s ${i * 14}ms` }}
      />
    ))}
  </svg>
);

export const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);
export const SEV: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
