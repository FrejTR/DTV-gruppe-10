// Fælles tjek: alle sektioner (faner) skal kunne ses uden at scrolle sidelæns ved 1280 px skærmbredde.
// Åbner alle sektioner og finder selv alle steder på siden, der kan scrolle sidelæns (overflow-x: auto/scroll),
// så nye sektioner og tabeller bliver tjekket af sig selv. Siden selv må heller ikke være bredere end vinduet.
// Brug: const fejl = await sidelaensScroll(page); fejl er en tom liste, når alt passer.

async function sidelaensScroll(page) {
  const foer = page.viewportSize();
  if (!foer || foer.width !== 1280) await page.setViewportSize({ width: 1280, height: (foer && foer.height) || 900 });
  const lukkede = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('details.sec:not([open])')].map(d => d.id);
    document.querySelectorAll('details.sec').forEach(d => { d.open = true; });
    return ids;
  });
  await page.waitForTimeout(150);   // Lad sektionerne tegne sig færdige
  const fejl = await page.evaluate(() => {
    const ud = [];
    const navn = el => {
      const sek = el.closest('details.sec, section, header, footer, nav');
      return `${el.id ? '#' + el.id : el.className || el.tagName}${sek && sek !== el ? ' i ' + (sek.id ? '#' + sek.id : sek.className || sek.tagName) : ''}`;
    };
    for (const el of document.querySelectorAll('body *')) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;   // Skjult
      if (!['auto', 'scroll'].includes(getComputedStyle(el).overflowX)) continue;
      if (el.closest('dialog:not([open])')) continue;
      const over = el.scrollWidth - el.clientWidth;
      if (over > 1) ud.push(`${navn(el)} er ${over} px for bred (${el.scrollWidth} px indhold, ${el.clientWidth} px plads)`);
    }
    const side = document.documentElement;
    if (side.scrollWidth - side.clientWidth > 1) ud.push(`siden er ${side.scrollWidth - side.clientWidth} px for bred`);
    return ud;
  });
  await page.evaluate(ids => ids.forEach(id => { const d = document.getElementById(id); if (d) d.open = false; }), lukkede);
  if (foer && foer.width !== 1280) await page.setViewportSize(foer);
  return fejl;
}

module.exports = { sidelaensScroll };
