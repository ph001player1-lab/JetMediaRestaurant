// Цветовые темы планшета: менеджер выбирает одну во вкладке «Дизайн», планшет красит ею всё —
// верхнюю панель, категории, карточки блюд, корзину, заказы, кнопки внизу и окно ИИ-персонажа.
//   bg — фон меню, card — панели и карточки, ink — текст, muted — подписи, line — рамки,
//   soft — второстепенные кнопки, accent — главные кнопки («Добавить», «Заказ»), accentInk — текст на них
const T = (id, en, ru, bg, card, ink, muted, line, soft, accent, accentInk) =>
  ({ id, name: { en, ru }, bg, card, ink, muted, line, soft, accent, accentInk });

export const THEMES = [
  T('classic', 'Terracotta', 'Терракота', '#f7f3ee', '#ffffff', '#1f1a17', '#8a7f76', '#e3d9cf', '#efe7df', '#c8553d', '#ffffff'),
  T('emerald', 'Emerald & gold', 'Изумруд и золото', '#1f2e27', '#2d4a3e', '#f3e9d2', '#b9c4b4', '#3f6355', '#3c5f50', '#c9a646', '#1f1a17'),
  T('noir', 'Night & gold', 'Ночь и золото', '#121212', '#1e1e1e', '#f5f0e6', '#a39e93', '#333333', '#2b2b2b', '#d4af37', '#121212'),
  T('ocean', 'Ocean', 'Океан', '#eef5f9', '#ffffff', '#0f2a3d', '#6b8293', '#d3e3ec', '#e0edf4', '#0e7c9a', '#ffffff'),
  T('andaman', 'Andaman Sea', 'Андаманское море', '#e9f7f5', '#ffffff', '#10332f', '#5f807b', '#cde8e3', '#dcf1ed', '#14a38b', '#ffffff'),
  T('sunset', 'Sunset', 'Закат', '#fff4ec', '#ffffff', '#3a1d12', '#9a7565', '#f3dccd', '#fde6d6', '#f26b38', '#ffffff'),
  T('berry', 'Berry', 'Ягодная', '#fbf0f4', '#ffffff', '#3b1426', '#9b6f82', '#f0d6e1', '#f6e3eb', '#d63a6e', '#ffffff'),
  T('lavender', 'Lavender', 'Лаванда', '#f4f1fa', '#ffffff', '#2a2140', '#807898', '#e2dcef', '#ebe6f5', '#7a5cc4', '#ffffff'),
  T('olive', 'Olive', 'Олива', '#f5f4ec', '#ffffff', '#2c2e1f', '#7f816d', '#e2e1d0', '#ebead9', '#6b7d2a', '#ffffff'),
  T('coffee', 'Coffee', 'Кофе', '#f3ece5', '#fffaf5', '#2e1f16', '#8b7565', '#e4d6c8', '#eaddcf', '#7b4a2d', '#ffffff'),
  T('siam', 'Siam red & gold', 'Сиам: красный и золото', '#fff8ec', '#ffffff', '#3d0f0f', '#946a5a', '#f1dfc4', '#f7e8cc', '#b3202a', '#ffe9b0'),
  T('matcha', 'Matcha', 'Матча', '#f1f6ee', '#ffffff', '#1f2b1c', '#6f8068', '#dbe7d4', '#e3eedd', '#5b8c3a', '#ffffff'),
  T('navy', 'Navy & coral', 'Ночной синий', '#0f1b2d', '#18283f', '#eef3fa', '#9aaac0', '#2a3d5a', '#22365a', '#ff7a5c', '#0f1b2d'),
  T('graphite', 'Graphite & lime', 'Графит и лайм', '#1a1c1a', '#262926', '#eef2e8', '#a3aa9c', '#383c37', '#323632', '#a6d63a', '#1a1c1a'),
  T('wine', 'Wine', 'Винная', '#2a1218', '#3a1a22', '#f7e9ea', '#c19ea4', '#55283a', '#4a2230', '#e0b45c', '#2a1218'),
  T('mono', 'Monochrome', 'Монохром', '#f4f4f4', '#ffffff', '#111111', '#777777', '#e2e2e2', '#ececec', '#111111', '#ffffff'),
  T('sakura', 'Sakura', 'Сакура', '#fff5f6', '#ffffff', '#3a2328', '#9c7d83', '#f5dfe2', '#fbe8eb', '#e0798b', '#ffffff'),
  T('mango', 'Mango', 'Манго', '#fffaeb', '#ffffff', '#33270a', '#8f7d4f', '#f3e6bd', '#fbefc8', '#f2a900', '#33270a'),
  T('mint', 'Mint', 'Мята', '#effaf6', '#ffffff', '#133029', '#66847b', '#d3eee5', '#dff4ec', '#2bb08a', '#ffffff'),
  T('tropic', 'Tropical night', 'Тропическая ночь', '#0d2424', '#143434', '#e8f4f1', '#93b5ae', '#23504c', '#1d4542', '#f0a43a', '#0d2424'),
];

export const themeOf = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
