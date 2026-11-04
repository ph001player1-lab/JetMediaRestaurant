// Стрелки карусели планшета: 10 видов и «без стрелок». Общие для планшета и примера во вкладке «Дизайн» кабинета.
// Вид — класс arw-<вид> на контейнере, размер — переменная --arw (1 = 100 %), основа размера — --arwb (на планшете 8vw)
var ARROWS = ['circle', 'square', 'light', 'outline', 'chevron', 'accent', 'glass', 'tab', 'triangle', 'line', 'none'];
var ARROW_NAMES = {
  circle: { en: 'Dark circle', th: 'วงกลมเข้ม', ru: 'Тёмный круг' },
  square: { en: 'Dark square', th: 'สี่เหลี่ยมเข้ม', ru: 'Тёмный квадрат' },
  light: { en: 'White circle', th: 'วงกลมขาว', ru: 'Белый круг' },
  outline: { en: 'Ring', th: 'วงแหวน', ru: 'Кольцо' },
  chevron: { en: 'Arrow only', th: 'ลูกศรอย่างเดียว', ru: 'Только стрелка' },
  accent: { en: 'Theme colour', th: 'สีของธีม', ru: 'Цвет темы' },
  glass: { en: 'Glass', th: 'กระจก', ru: 'Стекло' },
  tab: { en: 'Edge tab', th: 'แถบขอบจอ', ru: 'Язычок у края' },
  triangle: { en: 'Triangle', th: 'สามเหลี่ยม', ru: 'Треугольник' },
  line: { en: 'Long arrow', th: 'ลูกศรยาว', ru: 'Длинная стрелка' },
  none: { en: 'No arrows (swipe)', th: 'ไม่มีลูกศร (ปัด)', ru: 'Без стрелок (листать пальцем)' }
};
function arrowGlyph(style, dir) {
  var l = dir < 0, d;
  if (style === 'triangle') d = l ? 'M17 3 5 12l12 9z' : 'M7 3l12 9-12 9z';
  else if (style === 'line') d = l ? 'M21 12H4m6-7-7 7 7 7' : 'M3 12h17m-6-7 7 7-7 7';
  else d = l ? 'M15 4 7 12l8 8' : 'M9 4l8 8-8 8';
  var fill = style === 'triangle';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '" fill="' + (fill ? 'currentColor' : 'none') +
    '" stroke="currentColor" stroke-width="' + (fill ? 1 : style === 'line' ? 2.4 : 3.2) + '" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
(function () {
  var S = 'calc(var(--arwb, 8vw) * var(--arw, 1))';
  var css = [
    '.arrow { position: absolute; top: 50%; width: ' + S + '; height: ' + S + '; margin-top: calc(' + S + ' / -2); border: 0; padding: 0; z-index: 2;',
    '  display: flex; align-items: center; justify-content: center; color: #fff; background: rgba(0,0,0,.35); border-radius: 50%; cursor: pointer; }',
    '.arrow svg { width: 56%; height: 56%; display: block; }',
    '.arw-square .arrow { border-radius: 22%; background: rgba(0,0,0,.5); }',
    '.arw-light .arrow { background: rgba(255,255,255,.92); color: #222; box-shadow: 0 2px 10px rgba(0,0,0,.35); }',
    '.arw-outline .arrow { background: rgba(0,0,0,.12); box-shadow: inset 0 0 0 calc(' + S + ' * .06) rgba(255,255,255,.95), 0 0 6px rgba(0,0,0,.35); }',
    '.arw-chevron .arrow { background: none; filter: drop-shadow(0 0 3px rgba(0,0,0,.85)); }',
    '.arw-chevron .arrow svg { width: 80%; height: 80%; }',
    '.arw-accent .arrow { background: var(--accent, #c8553d); color: var(--accent-ink, #fff); box-shadow: 0 2px 10px rgba(0,0,0,.3); }',
    '.arw-glass .arrow { background: rgba(255,255,255,.22); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); box-shadow: inset 0 0 0 1px rgba(255,255,255,.45); }',
    '.arw-tab .arrow { width: calc(' + S + ' * .62); height: calc(' + S + ' * 1.5); margin-top: calc(' + S + ' * -.75); background: rgba(0,0,0,.5); }',
    '.arw-tab .arrow.left { left: 0 !important; border-radius: 0 999px 999px 0; } .arw-tab .arrow.right { right: 0 !important; border-radius: 999px 0 0 999px; }',
    '.arw-tab .arrow svg { width: 80%; }',
    '.arw-triangle .arrow { background: none; filter: drop-shadow(0 0 3px rgba(0,0,0,.8)); }',
    '.arw-triangle .arrow svg { width: 70%; height: 70%; }',
    '.arw-line .arrow { width: calc(' + S + ' * 1.35); border-radius: 999px; background: rgba(0,0,0,.4); }',
    '.arw-line .arrow svg { width: 60%; }',
    '.arw-none .arrow { display: none; }'
  ].join('\n');
  var s = document.createElement('style');
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
})();
