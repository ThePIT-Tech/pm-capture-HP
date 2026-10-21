// IndexedDB: jobs (the loaded .pmjob.json) and photos (captured JPEG blobs).
// Everything stays on the phone until it is exported.
const DB_NAME = 'pm-capture';
let dbp = null;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('jobs', { keyPath: 'id' });
      const ph = db.createObjectStore('photos', { keyPath: 'id' });
      ph.createIndex('job', 'jobId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const putJob = (job) => run('jobs', 'readwrite', (s) => s.put(job));
export const getJob = (id) => run('jobs', 'readonly', (s) => s.get(id));
export const listJobs = () => run('jobs', 'readonly', (s) => s.getAll());
export const putPhoto = (p) => run('photos', 'readwrite', (s) => s.put(p));
export const deletePhoto = (id) => run('photos', 'readwrite', (s) => s.delete(id));
export const jobPhotos = (jobId) => run('photos', 'readonly', (s) => s.index('job').getAll(jobId));

export async function deleteJob(id) {
  const photos = await jobPhotos(id);
  await run('photos', 'readwrite', (s) => { photos.forEach((p) => s.delete(p.id)); });
  await run('jobs', 'readwrite', (s) => s.delete(id));
}

// Ask the browser not to evict our data when storage runs low.
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
