# Постеры Чехова на TH / ZH (и чистый EN): берём английский постер, закрашиваем полосу текста фоном
# (по каждому столбцу — плавный переход между фоном над и под текстом) и набираем текст заново
import sys, numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
SRC = '/home/user/JetMediaRestaurant/server/assets/chekhoff'
OUT = sys.argv[1]
Y0, Y1 = 1262, 1650         # полоса текста (фон над и под ней — чистый)
GOLD, CREAM, SUB = (201, 162, 85), (244, 232, 212), (226, 214, 196)
N = '/usr/share/fonts/truetype/noto/'
CJK_SERIF, CJK_SANS = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
FONTS = {
  'th': dict(kick=(N + 'NotoSansThai-SemiBold.ttf', 0), title=(N + 'NotoSerifThai-Bold.ttf', 0), sub=(N + 'NotoSansThai-Regular.ttf', 0), ts=78, ss=40, ks=30, track=4),
  'zh': dict(kick=('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 2), title=(CJK_SERIF, 2), sub=(CJK_SANS, 2), ts=80, ss=40, ks=30, track=10),
  'en': dict(kick=(N + 'NotoSans-SemiBold.ttf', 0), title=(N + 'NotoSerif-Bold.ttf', 0), sub=(N + 'NotoSans-Regular.ttf', 0), ts=82, ss=40, ks=26, track=9),
}
KICK = {'th': 'ข้อเสนอพิเศษ', 'zh': '特别优惠', 'en': 'SPECIAL OFFER'}
T = {
 1: {'en': ('Guinness 0.5 L + Boiled Shrimps 500 g', 'A pint of dark Irish stout and half a kilo of shrimps'),
     'th': ('กินเนสส์ 0.5 ลิตร + กุ้งต้ม 500 กรัม', 'เบียร์ดำไอริช 1 ไพน์ กับกุ้งครึ่งกิโล'),
     'zh': ('健力士 0.5 升 + 水煮虾 500 克', '一品脱爱尔兰黑啤配半公斤鲜虾')},
 2: {'en': ('Guinness 0.5 L + Smoked Salmon', 'A pint of Guinness and tender smoked salmon'),
     'th': ('กินเนสส์ 0.5 ลิตร + แซลมอนรมควัน', 'กินเนสส์ 1 ไพน์ กับแซลมอนรมควันเนื้อนุ่ม'),
     'zh': ('健力士 0.5 升 + 烟熏三文鱼', '一品脱健力士配嫩滑烟熏三文鱼')},
 3: {'en': ('Paella for One + a Glass of Spanish Wine', 'Seafood paella and a glass of Spanish wine'),
     'th': ('ปาเอยาสำหรับ 1 ท่าน + ไวน์สเปน 1 แก้ว', 'ปาเอยาซีฟู้ด กับไวน์สเปน 1 แก้ว'),
     'zh': ('单人海鲜饭 + 一杯西班牙葡萄酒', '海鲜饭配一杯西班牙葡萄酒')},
 4: {'en': ('Big Paella for 4–6 People + a Bottle of Wine', 'A pan of paella for the whole company and a bottle of wine'),
     'th': ('ปาเอยาใหญ่สำหรับ 4–6 ท่าน + ไวน์ 1 ขวด', 'ปาเอยากระทะใหญ่สำหรับทั้งกลุ่ม กับไวน์ 1 ขวด'),
     'zh': ('4–6 人大份海鲜饭 + 一瓶葡萄酒', '一大锅海鲜饭配一瓶葡萄酒，适合聚会分享')},
 5: {'en': ('Guacamole + 8 Shots of Tequila', 'Fresh guacamole and eight shots of silver tequila'),
     'th': ('กัวคาโมเล่ + เตกีลา 8 ช็อต', 'กัวคาโมเล่สด กับเตกีลาซิลเวอร์ 8 ช็อต'),
     'zh': ('牛油果酱 + 8 杯龙舌兰', '新鲜牛油果酱配八杯银色龙舌兰')},
 6: {'en': ('Russian Standard Vodka 200 ml + Meat Platter', 'A classic: 200 ml of vodka and a large meat platter'),
     'th': ('วอดก้ารัสเซียนสแตนดาร์ด 200 มล. + จานเนื้อรวม', 'สไตล์คลาสสิก: วอดก้า 200 มล. กับจานเนื้อรวมจานใหญ่'),
     'zh': ('俄罗斯标准伏特加 200 毫升 + 肉类拼盘', '经典组合：200 毫升伏特加配大份肉类拼盘')},
 7: {'en': ('Guinness 0.5 L + Beef Burger', 'A pint of Guinness and a juicy beef burger'),
     'th': ('กินเนสส์ 0.5 ลิตร + เบอร์เกอร์เนื้อ', 'กินเนสส์ 1 ไพน์ กับเบอร์เกอร์เนื้อฉ่ำ ๆ'),
     'zh': ('健力士 0.5 升 + 牛肉汉堡', '一品脱健力士配多汁牛肉汉堡')},
}
NAMES = {1: 'Гиннесс + креветки', 2: 'Гиннесс + лосось', 3: 'Паэлья + бокал вина', 4: 'Большая паэлья + бутылка вина', 5: 'Гуакамоле + 8 шотов текилы', 6: 'Водка + мясное ассорти', 7: 'Гиннесс + бургер'}

LAT = {'title': (N + 'NotoSerif-Bold.ttf', 0), 'sub': (N + 'NotoSans-Regular.ttf', 0), 'kick': (N + 'NotoSans-SemiBold.ttf', 0)}
def is_thai(ch): return '\u0e00' <= ch <= '\u0e7f'
# тайский шрифт без цифр и «+»: текст режем на куски — тайские буквы и всё остальное (латинским той же гарнитуры)
def runs(text, role, lang, size):
    if lang != 'th': return [(text, font(FONTS[lang][role], size))]
    out, cur, th = [], '', None
    for ch in text:
        t = th if ch == ' ' and th is not None else is_thai(ch)
        if th is None: th = t
        if t == th: cur += ch
        else: out.append((cur, th)); cur, th = ch, t
    if cur: out.append((cur, th))
    return [(s_, font(FONTS['th'][role], size) if t else font(LAT[role], size)) for s_, t in out]
def measure(d, text, role, lang, size): return sum(d.textlength(s_, font=f) for s_, f in runs(text, role, lang, size))
def draw_center(d, cx, cy, text, role, lang, size, fill):
    rs = runs(text, role, lang, size); w = sum(d.textlength(s_, font=f) for s_, f in rs)
    base = cy + size * 0.36
    x = cx - w / 2
    for s_, f in rs:
        d.text((x, base), s_, font=f, fill=fill, anchor='ls'); x += d.textlength(s_, font=f)

def font(spec, size):
    return ImageFont.truetype(spec[0], size, index=spec[1], layout_engine=ImageFont.Layout.RAQM)

def clear_band(im):
    a = np.asarray(im).astype(np.float32)
    # фон полосы = строка под текстом × вертикальный ход яркости, снятый с краёв (там текста нет)
    bot = a[Y1:Y1 + 6].mean(axis=0)
    cols = list(range(50)) + list(range(a.shape[1] - 50, a.shape[1]))
    edge = a[Y0:Y1][:, cols].mean(axis=(1, 2))
    gain = edge / a[Y1:Y1 + 6][:, cols].mean()
    fill = bot[None] * gain[:, None, None]
    # верх полосы — плавно из оригинала (там только фон), чтобы не было шва
    k = np.clip(np.arange(Y1 - Y0) / 24.0, 0, 1)[:, None, None]
    a[Y0:Y1] = a[Y0:Y1] * (1 - k) + fill * k
    out = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    # лёгкое зерно, как на фоне оригинала, чтобы полоса не выглядела «пластиковой»
    noise = (np.random.default_rng(1).normal(0, 1.6, (Y1 - Y0, a.shape[1], 1))).repeat(3, axis=2)
    b = np.asarray(out).astype(np.float32); b[Y0:Y1] += noise
    return Image.fromarray(b.clip(0, 255).astype(np.uint8))

def wrap(draw, text, role, lang, size, maxw):
    cjk = lang == 'zh'
    words = list(text) if cjk else text.split(' ')
    lines, cur = [], ''
    for w in words:
        cand = (cur + w) if cjk else (cur + ' ' + w).strip()
        if measure(draw, cand, role, lang, size) <= maxw or not cur: cur = cand
        else:
            if cjk and w in '，。、：；！？）': cur = cand; continue  # знак препинания не переносим в начало строки
            lines.append(cur); cur = w
    lines.append(cur)
    return lines

def make(n, lang):
    im = Image.open(f'{SRC}/promo-{n}.jpg').convert('RGB')
    im = clear_band(im)
    d = ImageDraw.Draw(im)
    F = FONTS[lang]; cjk = lang == 'zh'
    title, sub = T[n][lang]
    W = im.width
    # подбираем размер заголовка: не больше 2 строк шириной до 1400 px
    ts = F['ts']
    while True:
        tl = wrap(d, title, 'title', lang, ts, 1400)
        if len(tl) <= 2 or ts < 50: break
        ts -= 4
    sl = wrap(d, sub, 'sub', lang, F['ss'], 1380)
    kf = font(F['kick'], F['ks'])
    y = 1290
    # надпись «спецпредложение» с разрядкой
    kw = sum(d.textlength(ch, font=kf) for ch in KICK[lang]) + F['track'] * (len(KICK[lang]) - 1)
    if lang == 'th':
        d.text((W / 2, y), KICK[lang], font=kf, fill=GOLD, anchor='mm')
    else:
        x = (W - kw) / 2
        for ch in KICK[lang]:
            d.text((x, y), ch, font=kf, fill=GOLD, anchor='lm'); x += d.textlength(ch, font=kf) + F['track']
    y += 44
    lh = int(ts * (1.32 if lang == 'th' else 1.22))
    for ln in tl:
        draw_center(d, W / 2, y + lh / 2, ln, 'title', lang, ts, CREAM); y += lh
    y += 14
    slh = int(F['ss'] * 1.45)
    for ln in sl:
        draw_center(d, W / 2, y + slh / 2, ln, 'sub', lang, F['ss'], SUB); y += slh
    assert y < Y1 + 40, (n, lang, y)
    path = f'{OUT}/{n:02d} {NAMES[n]}_{lang.upper()}.jpg'
    im.save(path, quality=88)
    return path

for n in (sys.argv[3:] and map(int, sys.argv[3:]) or T):
    for lang in sys.argv[2].split(','):
        print(make(n, lang))
