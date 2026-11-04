import { spawn } from 'node:child_process';

export const TARGET_LUFS = Number(process.env.TARGET_LUFS || -16);

// Mede o loudness integrado (EBU R128) com o ffmpeg. Retorna LUFS ou null.
export function measureLoudness(file) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-20000); });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = err.match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/);
      const v = m ? Number(m[1]) : null;
      resolve(Number.isFinite(v) && v > -70 ? v : null);
    });
  });
}
