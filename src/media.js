// Media helpers shared by the upload well (thumbnails) and timeline
// (filmstrips). Pure browser APIs — no wasm needed.

export function videoMeta(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = (fn) => (e) => {
      v.removeAttribute('src');
      v.load?.();
      fn(e);
    };
    v.onloadedmetadata = done(() => resolve({
      duration: v.duration,
      width: v.videoWidth,
      height: v.videoHeight,
    }));
    v.onerror = done(() => reject(new Error('browser cannot decode this file')));
    v.src = url;
  });
}

// Seek a hidden <video> and grab frames as dataURLs, sequentially.
// Returns array of dataURL strings (null for failed grabs).
export async function grabFrames(url, times, width = 160) {
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.src = url;
  await new Promise((resolve, reject) => {
    v.onloadeddata = resolve;
    v.onerror = () => reject(new Error('cannot decode for thumbnails'));
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(width * (v.videoHeight / v.videoWidth) || 90));
  const ctx = canvas.getContext('2d');

  const out = [];
  for (const t of times) {
    try {
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('seek timeout')), 4000);
        v.onseeked = () => { clearTimeout(to); resolve(); };
        v.currentTime = t;
      });
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      out.push(canvas.toDataURL('image/jpeg', 0.6));
    } catch {
      out.push(null);
    }
  }
  v.removeAttribute('src');
  v.load();
  return out;
}

export async function makeThumb(url, duration) {
  const t = Math.min(Math.max(0.04 * (duration || 1), 0), 5);
  try {
    const [img] = await grabFrames(url, [t], 160);
    return img;
  } catch {
    return null;
  }
}
