// Alle /api/*-Aufrufe → gemeinsame Serverlogik in lib/kalender.js
import { route, json } from '../../lib/kalender.js';
export async function onRequest({ request, env, waitUntil }) {
  return (await route(request, env, { waitUntil })) || json({ error: 'Nicht gefunden' }, 404);
}
