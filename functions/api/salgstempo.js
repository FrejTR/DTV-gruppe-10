// GET /api/salgstempo: salgstempo pr. varenummer, beregnet som scripts/beregn_salgstempo.py.
import { erLokalUdvikling } from '../_lib/access.js';
import { lokaleDeps, salgstempo } from '../_lib/endpoints.js';

export const onRequestGet = context =>
  salgstempo(context, lokaleDeps(context.request, context.env, erLokalUdvikling(context.request, context.env)));
