import app from '../server/index';

// Vercel routes every /api/* request to this function.
// The Express app inside server/index.ts owns the actual routes (/api/tf/status, /api/tf/search, ...).
export default function handler(req: any, res: any) {
  if (req.url && !req.url.startsWith('/api')) req.url = '/api' + req.url;
  return (app as any)(req, res);
}