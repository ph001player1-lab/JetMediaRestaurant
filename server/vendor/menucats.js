// Разделы меню в видах «Плитки» и «Каталог»: иконка и группа (Кухня / Бар / Сладкое / сверху — акции) по названию
// раздела — русскому и английскому. Общий для планшета гостя (guest.html) и ЛК менеджера (staff.html). ES5 — для старых планшетов
(function () {
  var CAT_ICONS = [[/акци|промо|спецпредл|promo|special offer/i, '🔥'], [/новогод|new year/i, '🎄'], [/пасх|easter/i, '🥚'], [/детск|kids/i, '🧸'],
  [/на огне|гриль|мангал|шашлык|bbq|grill/i, '🍢'], [/пельмен|вареник|хинкал|dumpling/i, '🥟'], [/соус|sauce/i, '🥫'],
  [/тайск[а-я]* салат|thai salad/i, '🥗'], [/тайск[а-я]* суп|thai soup/i, '🍜'], [/тайск[а-я]* (рис|лапш)|thai rice|noodle/i, '🍚'], [/тайск|thai/i, '🍛'],
  [/горячие закуски|hot appetizer/i, '🫕'], [/закуск|snack|appetizer|starter/i, '🥪'], [/салат|salad/i, '🥗'], [/хлеб|выпечк|bread|bakery/i, '🥖'],
  [/суп|soup/i, '🍲'], [/паст[аы]|pasta/i, '🍝'], [/завтрак|breakfast/i, '🍳'], [/рыб|fish/i, '🐟'], [/морепр|seafood/i, '🦐'], [/суши|ролл|sushi|roll/i, '🍣'],
  [/мяс|птиц|meat|poultry/i, '🍖'], [/пицц|pizza/i, '🍕'], [/гарнир|side dish/i, '🥔'], [/вегет|веган|vegeta|vegan/i, '🥦'], [/торт|cake/i, '🎂'],
  [/печень|меренг|кекс|cookie|meringue/i, '🍪'], [/десерт|пирожн|dessert/i, '🍰'], [/мексик|испан|mexic|spanish/i, '🌮'],
  [/крепк|spirit|liquor/i, '🥃'], [/безалког[а-я]* коктейл|non-alcoholic cocktail|шейк|shake|смузи|smoothie/i, '🥤'], [/свежевыж|фреш|fresh juice/i, '🍊'],
  [/сок|juice/i, '🧃'], [/лимонад|lemonade/i, '🍋'], [/кофе|coffee/i, '☕'], [/чай|tea/i, '🍵'], [/безалког|напит|soft drink|drink/i, '🥤'],
  [/игрист|шампан|sparkling/i, '🥂'], [/вин[оа]|wine/i, '🍷'], [/пив|beer/i, '🍺'], [/водк|vodka/i, '🍶'], [/шот|shot/i, '⚡'], [/коктейл|cocktail/i, '🍸'],
  [/виски|whisk/i, '🥃'], [/(^|[^а-яё])ром([^а-яё]|$)|(^|[^a-z])rum([^a-z]|$)/i, '🍹'], [/коньяк|cognac|brandy/i, '🍇'], [/джин|(^|[^a-z])gin([^a-z]|$)/i, '🌿']];
  var BAR_RE = /напит|кофе|чай|вин[оа]|игрист|пив|водк|шот|коктейл|виски|(^|[^а-яё])ром([^а-яё]|$)|коньяк|джин|сок|лимонад|смузи|шейк|крепк|алкогол|drink|coffee|tea|wine|beer|vodka|shot|cocktail|whisk|cognac|juice|lemonade|smoothie|shake|spirit|liquor/i;
  var SWEET_RE = /десерт|торт|печень|меренг|кекс|выпечк|пирожн|сладк|морожен|dessert|cake|cookie|bakery|pastr|sweet|ice cream/i;
  // names — названия раздела по порядку (русское, английское): иконку ищем сначала по первому
  function info(names) {
    var list = [].concat(names).filter(Boolean), all = list.join(' | '), icon = '';
    for (var n = 0; n < list.length && !icon; n++) for (var k = 0; k < CAT_ICONS.length; k++) if (CAT_ICONS[k][0].test(list[n])) { icon = CAT_ICONS[k][1]; break; }
    icon = icon || '🍽';
    var names = all;
    var group = /акци|промо|спецпредл|promo|special offer/i.test(names) ? 'top' : BAR_RE.test(names) ? 'bar' : SWEET_RE.test(names) ? 'sweet' : 'food';
    return { icon: icon, group: group };
  }
  window.JetMenuCats = { info: info };
})();
