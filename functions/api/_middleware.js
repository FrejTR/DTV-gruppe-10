// Alle kald til /api/* kræver et gyldigt Cloudflare Access-token. Ingen undtagelser i produktion.
import { erLokalUdvikling, verificerToken } from '../_lib/access.js';
import { json, log } from '../_lib/svar.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  if (erLokalUdvikling(request, env)) return next();
  try {
    const ok = await verificerToken(request.headers.get('Cf-Access-Jwt-Assertion'), {
      team: (env.CF_ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, ''), aud: env.CF_ACCESS_AUD,
    });
    if (ok) return next();
  } catch (e) {
    // Manglende opsætning eller nøgleopslag: afvis hellere end at lukke op
    log('access', e && e.message === 'opsaetning' ? 'access_ikke_sat_op' : 'access_noegler_utilgaengelige');
    return json({ fejl: 'Ingen adgang' }, 503);
  }
  return json({ fejl: 'Ingen adgang' }, 403);
}
