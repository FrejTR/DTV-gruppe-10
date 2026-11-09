// Lokal udvikling må pege på en mock af Rackbeat (RACKBEAT_BASE_URL). Det virker kun uden for Vercel
// (Vercel sætter altid VERCEL=1) og kun, når kaldet kommer fra localhost eller 127.0.0.1.
// På Vercel bruges derfor altid Rackbeats egen adresse, uanset hvilke variabler der er sat.

export function erLokalUdvikling(request, env) {
  if (env.VERCEL) return false;
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

export function lokaleDeps(request, env) {
  return erLokalUdvikling(request, env) && env.RACKBEAT_BASE_URL ? { basisUrl: env.RACKBEAT_BASE_URL } : {};
}
