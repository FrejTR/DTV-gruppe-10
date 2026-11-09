// GET /api/status: lager pr. varenummer og salg de seneste 7 dage pr. varenummer og dag.
import { erLokalUdvikling } from '../_lib/access.js';
import { lokaleDeps, status } from '../_lib/endpoints.js';

export const onRequestGet = context =>
  status(context, lokaleDeps(context.request, context.env, erLokalUdvikling(context.request, context.env)));
