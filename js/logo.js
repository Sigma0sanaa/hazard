/* The S-A mark that draws itself while something is computed: outline of the S and the A, then the fill, then the gold satellite.
   The shapes are the brand mark (mark-black-gold.svg) with the S's 1.55 horizontal stretch baked into its points, so the outline can be drawn evenly. */

const S = "M151 158.6Q151 186.2 172.4 206Q193.7 225.8 227.1 240.6Q260.4 255.4 297.9 270.2Q336.4 284.3 372.4 300.4Q408.3 316.5 431.7 338.7Q455.2 360.9 455.2 393.2Q455.2 425.4 430.2 451.3Q405.2 477.2 357.8 492.6Q310.4 508.1 240.6 508.1Q215.6 508.1 191.1 505.7Q166.7 503.4 142.2 498Q117.7 492.6 93.7 484.5Q88.5 482.5 87 479.5Q85.4 476.5 84.4 471.8L70.8 380.4Q70.8 379 70.8 377.7Q72.9 377 76 376.4Q81.2 376.4 82.3 379Q89.6 399.2 103.1 420Q116.7 440.9 138.5 458.3Q160.4 475.8 191.7 486.6Q222.9 497.3 264.6 497.3Q294.8 497.3 323.4 489.9Q352.1 482.5 370.3 465.7Q388.5 448.9 388.5 420Q388.5 387.1 366.1 365.3Q343.7 343.4 309.4 327.3Q275 311.2 236.4 297.1Q200 282.3 166.1 266.8Q132.3 251.4 110.9 230.2Q89.6 209 89.6 177.4Q89.6 141.8 117.7 118.6Q145.8 95.5 190.6 84Q235.4 72.6 283.3 72.6Q312.5 72.6 343.7 76.3Q375 80 405.2 88.7Q413.5 90.8 417.2 93.8Q420.8 96.8 420.8 100.2L428.1 176.8Q428.1 179.5 422.9 179.8Q417.7 180.1 415.6 177.4Q413.5 164 404.1 147.5Q394.8 131.1 377.1 116.3Q359.4 101.5 332.3 92.1Q305.2 82.7 266.6 82.7Q226 82.7 200.5 93.8Q175 104.9 163 122Q151 139.1 151 158.6Z";
const A1 = "M222.2 178.9 227 174.9V434H222.2Z";
const A2 = "M223.6 173.9H236.3L371.4 434H358.4Z";
const SAT = '<g class="bl-sat" transform="translate(218.6 138.9) rotate(-30) scale(0.78)" fill="none" stroke="#B8965A" stroke-linejoin="round" stroke-linecap="round"> <rect pathLength="1" x="-66" y="-11" width="44" height="22" rx="1.5"/><line pathLength="1" x1="-51.3" y1="-11" x2="-51.3" y2="11"/><line pathLength="1" x1="-36.7" y1="-11" x2="-36.7" y2="11"/><line pathLength="1" x1="-66" y1="0" x2="-22" y2="0"/> <rect pathLength="1" x="22" y="-11" width="44" height="22" rx="1.5"/><line pathLength="1" x1="36.7" y1="-11" x2="36.7" y2="11"/><line pathLength="1" x1="51.3" y1="-11" x2="51.3" y2="11"/><line pathLength="1" x1="22" y1="0" x2="66" y2="0"/> <line pathLength="1" x1="-22" y1="0" x2="-12" y2="0"/><line pathLength="1" x1="12" y1="0" x2="22" y2="0"/> <rect class="bl-body" pathLength="1" x="-12" y="-14" width="24" height="28" rx="3"/> <line pathLength="1" x1="0" y1="14" x2="0" y2="20"/><ellipse pathLength="1" cx="0" cy="25" rx="11" ry="5"/><line pathLength="1" x1="0" y1="-14" x2="0" y2="-20"/><path pathLength="1" d="M-10-20Q0-28 10-20Z"/> </g>';

let made = 0;

/**
 * A new mark. `since` (a performance.now() time) keeps the drawing where it was when a panel draws itself again;
 * without it the drawing starts from the beginning. It moves only inside `.busy.on` or with the class `go`.
 */
export function drawingMark({ since = null, go = false } = {}) {
  const gap = "mark-gap-" + ++made; // the white space where the S crosses the A; one id per mark
  const box = document.createElement("div");
  box.innerHTML = `<svg class="mark-draw${go ? " go" : ""}" viewBox="30.8 32.6 464.4 515.5" aria-hidden="true" focusable="false">
<defs><mask id="${gap}" maskUnits="userSpaceOnUse" x="0" y="0" width="520" height="560"><rect width="520" height="560" fill="#fff"/><path d="${S}" fill="#000" stroke="#000" stroke-width="15" stroke-linejoin="round"/></mask></defs>
<g class="bl-ink" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round">
<path class="bl-a" pathLength="1" mask="url(#${gap})" d="${A1}"/><path class="bl-a bl-a2" pathLength="1" mask="url(#${gap})" d="${A2}"/><path class="bl-s" pathLength="1" d="${S}"/>
</g>${SAT}</svg>`;
  const n = box.firstElementChild;
  if (since != null) n.style.setProperty("--bl-delay", `${-((performance.now() - since) % 3200)}ms`);
  return n;
}
