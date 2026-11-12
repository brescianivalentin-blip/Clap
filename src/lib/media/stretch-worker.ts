// Pitch-preserving time stretch (WSOLA). Speeding up a voice keeps it natural
// instead of sounding like a chipmunk, and slowing it down does not make it deeper.

interface Req {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  speed: number;
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function stretch(channels: Float32Array[], sampleRate: number, speed: number): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  const outFinal = Math.max(1, Math.round(inLen / speed));
  const N = Math.max(256, Math.round(sampleRate * 0.04) & ~1); // 40 ms window
  if (inLen < N * 2) {
    // Too short to stretch meaningfully: naive resample.
    return channels.map((c) => {
      const o = new Float32Array(outFinal);
      for (let i = 0; i < outFinal; i++) o[i] = c[Math.min(inLen - 1, Math.floor(i * speed))] ?? 0;
      return o;
    });
  }
  const Hs = N / 2;
  const Ha = Hs * speed;
  const tol = Math.round(sampleRate * 0.012);
  const D = 4; // decimation for the coarse search
  const L = Hs; // comparison length (overlap region)
  const win = hann(N);

  // Mono analysis signal + decimated copy.
  const mono = new Float32Array(inLen);
  for (const c of channels) for (let i = 0; i < inLen; i++) mono[i] += c[i];
  const dLen = Math.floor(inLen / D);
  const monoD = new Float32Array(dLen);
  for (let i = 0; i < dLen; i++) {
    let s = 0;
    for (let k = 0; k < D; k++) s += mono[i * D + k];
    monoD[i] = s;
  }

  const outLen = outFinal + N;
  const out = channels.map(() => new Float32Array(outLen));
  const norm = new Float32Array(outLen);
  const maxPos = inLen - N;

  const score = (sig: Float32Array, ref: number, cand: number, len: number) => {
    let dot = 0;
    let en = 1e-9;
    for (let i = 0; i < len; i++) {
      const b = sig[cand + i];
      dot += sig[ref + i] * b;
      en += b * b;
    }
    return dot / Math.sqrt(en);
  };

  let prev = 0;
  for (let k = 0, outPos = 0; outPos < outFinal; k++, outPos += Hs) {
    let pos: number;
    if (k === 0) {
      pos = 0;
    } else {
      const ideal = Math.round(k * Ha);
      const natural = prev + Hs;
      if (ideal >= maxPos || natural >= maxPos) {
        pos = Math.min(ideal, maxPos);
      } else {
        // Coarse search on the decimated signal.
        const ld = Math.floor(L / D);
        const refD = Math.floor(natural / D);
        const lo = Math.max(0, Math.floor((ideal - tol) / D));
        const hi = Math.min(Math.floor(maxPos / D) - ld - 1, Math.floor((ideal + tol) / D));
        let best = Math.floor(ideal / D);
        let bestScore = -Infinity;
        if (refD + ld < dLen) {
          for (let c = lo; c <= hi; c++) {
            const s = score(monoD, refD, c, ld);
            if (s > bestScore) {
              bestScore = s;
              best = c;
            }
          }
        }
        // Fine search around the coarse match.
        let fine = best * D;
        let fineScore = -Infinity;
        const flo = Math.max(0, best * D - D);
        const fhi = Math.min(maxPos - L, best * D + D);
        if (natural + L < inLen) {
          for (let c = flo; c <= fhi; c++) {
            const s = score(mono, natural, c, L);
            if (s > fineScore) {
              fineScore = s;
              fine = c;
            }
          }
        }
        pos = Math.max(0, Math.min(maxPos, fine));
      }
    }
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch];
      const dst = out[ch];
      for (let i = 0; i < N; i++) dst[outPos + i] += src[pos + i] * win[i];
    }
    for (let i = 0; i < N; i++) norm[outPos + i] += win[i];
    prev = pos;
  }

  return out.map((o) => {
    const r = new Float32Array(outFinal);
    for (let i = 0; i < outFinal; i++) {
      const n = norm[i];
      r[i] = n > 1e-3 ? o[i] / n : o[i];
    }
    return r;
  });
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, channels, sampleRate, speed } = e.data;
  try {
    const result = stretch(channels, sampleRate, speed);
    (self as unknown as Worker).postMessage({ id, ok: true, channels: result }, result.map((c) => c.buffer));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
