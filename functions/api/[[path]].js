/* Alle /api/*-Anfragen → Zugangsschutz + Serverlogik in _core.js */
import { handleRequest } from './_core.js';
export const onRequest = ({ request, env }) => handleRequest(request, env);
