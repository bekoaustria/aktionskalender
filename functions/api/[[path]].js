/* Alle /api/*-Anfragen → gemeinsame Serverlogik in _core.js */
import { handleApi } from './_core.js';
export const onRequest = ({ request, env }) => handleApi(request, env);
