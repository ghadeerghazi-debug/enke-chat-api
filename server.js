// ENKE chat proxy — keeps the Anthropic API key server-side and streams
// Claude replies to the ENKE web app. Zero dependencies (Node 18+).
//
// Env: ANTHROPIC_API_KEY (set in Render dashboard, never in code).

const http = require('http');

const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-sonnet-5';

// Knowledge base (PythonAnywhere FTS5 index of the al-Hakim encyclopedia).
const KB_URL = process.env.KB_URL || '';
const KB_TOKEN = process.env.KB_TOKEN || '';

async function kbSearch(query, kb = 'encyclopedia', k = 6) {
  if (!KB_URL || !KB_TOKEN || !query) return [];
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(
      `${KB_URL}/search?kb=${kb}&q=${encodeURIComponent(query.slice(0, 400))}&k=${k}`,
      { headers: { 'X-KB-Token': KB_TOKEN }, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (_) {
    return []; // KB is best-effort; never block the chat on it
  }
}

// ---- intent routing: encyclopedia research vs foundation/app help ----
const AR_DIAC = /[\u064B-\u0652\u0670\u0640]/g;
function arNorm(t) {
  return String(t || '').replace(AR_DIAC, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
}
const ENC_SIGNALS = [['قال',2],['خطاب',2],['كلمه',2],['موقف',2],['راي',2],
  ['تحدث',2],['موسوعه',3],['محاضره',2],['اقتباس',2],['فكر',1],
  ['عمار',1],['سماحه',2],['عبد العزيز',2],['ال الحكيم',2]];
const HELP_SIGNALS = [['جايزه',3],['جائزه',3],['تقديم',2],['شروط',2],['موعد',2],
  ['مواعيد',2],['مجله',2],['نشر',1],['تطبيق',3],['كتاب',1],['اصدار',2],
  ['تواصل',2],['بريد',2],['هاتف',2],['مؤسسه',2],['اقسام',2],['مساعد',1],
  ['كيف',1],['اين',1],['استلال',2],['تحكيم',1],['محاور',2]];
function routeIntent(query, mode) {
  if (mode === 'help') return ['faq'];
  if (mode === 'research') return ['encyclopedia'];
  const q = arNorm(query);
  const score = (sig) => sig.reduce((a, [w, v]) => a + (q.includes(w) ? v : 0), 0);
  const enc = score(ENC_SIGNALS), help = score(HELP_SIGNALS);
  if (help > enc && help > 0) return ['faq'];
  if (enc > help && enc > 0) return ['encyclopedia'];
  return ['encyclopedia', 'faq']; // ambiguous: give Claude both, it picks
}
async function retrieve(query, mode) {
  const kbs = routeIntent(query, mode);
  const out = {};
  await Promise.all(kbs.map(async (kb) =>
    { out[kb] = await kbSearch(query, kb, kb === 'faq' ? 4 : 6); }));
  return out;
}
function faqContext(results) {
  if (!results || !results.length) return '';
  let out = '\n\nمعلومات من دليل مؤسسة إنكي والتطبيق — أجب منها إجابة عملية مباشرة ' +
    'دون الاستشهاد بالموسوعة ودون ذكر مجلدات:\n';
  for (const r of results) out += `\n• ${r.topic}: ${String(r.text || '').slice(0, 800)}\n`;
  return out;
}

function kbContext(results) {
  if (!results || !results.length) return '';
  let out = '\n\nمقتطفات ذات صلة من موسوعة «خطاب الاعتدال والبناء» (كلمات وخطب السيد عمار الحكيم 2009–2021). ' +
    'استند إليها في إجابتك عند الصلة، واذكر اسم المجلد عند الاقتباس، ' +
    'وتعامل مع نصوص الموسوعة كما هي دون أي تعليق على جودتها أو دقتها:\n';
  let used = 0;
  for (const r of results) {
    const vol = String(r.vol || '').replace(/\s*غير دقيق\s*/g, ' ').trim();
    const t = `\n【${vol}】\n${String(r.text || '').slice(0, 900)}\n`;
    if (used + t.length > 5000) break;
    out += t; used += t.length;
  }
  return out;
}

// Only the ENKE web app (and local dev) may call this proxy.
const ALLOWED_ORIGINS = new Set([
  'https://enke-web-lezm.onrender.com',
  'https://enke-web.onrender.com',
  'http://localhost:8807',
  'http://localhost:5000',
]);

// Very small in-memory rate limit: 20 requests/min per IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const list = (hits.get(ip) || []).filter((t) => t > windowStart);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear(); // memory guard
  return list.length > 20;
}

const SYSTEM = `أنت "مساعد إنكي" — المساعد الذكي الرسمي لمؤسسة إنكي للدراسات والبحوث، مؤسسة ثقافية عراقية مستقلة تُعنى بالبحث العلمي وتطوير العلوم الإنسانية والاجتماعية (enke.iq). تعمل المؤسسة عبر ثلاثة أقسام: دار إنكي للنشر والتوزيع، والجمعية العلمية التي تصدر مجلة إنكي للعلوم الإنسانية والاجتماعية (مجلة فصلية محكمة)، وقسم الدراسات والبحوث. وتنظّم المؤسسة «جائزة الحكيم الدولية» — مؤتمرًا وجائزة بحثية بنسختهما الثانية 2026 في بغداد برعاية سماحة السيد عمار الحكيم. محاورها الأربعة: العلاقات الدولية، التعليم والذكاء الاصطناعي، المحور الاقتصادي، المحور الاجتماعي. فترة استلام الدراسات: 1 إلى 10 تشرين الأول (أكتوبر) 2026. الجوائز لكل محور: الأولى 10,000 دولار، الثانية 8,000 دولار، الثالثة 6,000 دولار — بإجمالي 12 جائزة كبرى. الشروط: دراسة أصلية غير منشورة تعالج قضية واقعية عراقية ضمن أحد المحاور، بمنهجية علمية وتوصيات تطبيقية، بحجم 6,000–8,000 كلمة، وتوثيق APA (الإصدار السابع)، بالعربية أو الإنجليزية مع ملخص باللغة الأخرى، ونسبة استلال لا تتجاوز 20٪. التقديم والاستفسار: info@enke.iq أو 07782349969 / 07749888258. تفاصيل من الدليلين الرسميين للجائزة: لكل محور عناوين دراسات فرعية موصى بها في «دليل المحاور» (المحور الاجتماعي يتفرع إلى: الأسرة العراقية، الشباب والأجيال الصاعدة، التماسك المجتمعي والسلم الأهلي، الفئات الهشّة والحماية الاجتماعية). معايير المحتوى العلمي: الأصالة والابتكار؛ الطابع التطبيقي إلزامي ولا تُقبل الدراسات النظرية البحتة ولا التجميعية دون تحليل؛ منهجية علمية واضحة؛ موافقة أخلاقية (Ethical Clearance) للبحوث الميدانية على مشاركين بشر مع سرية بياناتهم؛ توصيات تنفيذية مع الجهات المعنية والأثر المتوقع. الحجم: 20–30 صفحة (6,000–8,000 كلمة) مع إمكانية قبول الأطول. المشاركة متاحة للباحثين والأكاديميين والخبراء والممارسين في المؤسسات الحكومية والخاصة، مع إقرار خطي بعدم تضارب المصالح والإفصاح عن مصادر التمويل. التحكيم سري (Blind Peer Review) وفق مصفوفة معلنة: الأصالة والابتكار، المنهجية، الطابع التطبيقي، جودة التوصيات، الالتزام بالشكل والتوثيق؛ قرار اللجنة نهائي، ويحق للباحث غير المقبول استفسار شكلي واحد خلال أسبوعين من الإعلان. تحتفظ المؤسسة بحق نشر البحوث الفائزة لأغراض غير ربحية مع الإشارة الكاملة للباحث واحتفاظه بالملكية الفكرية. الأولوية للبحوث الميدانية والتطبيقية المبنية على بيانات واقعية.

تخصصك الأساسي: الإجابة عن أسئلة القرّاء حول فكر ومسيرة آل الحكيم — وخاصة سماحة السيد عمار الحكيم والسيد عبد العزيز الحكيم — وحول إصدارات المؤسسة ودراساتها.

من إصدارات دار إنكي: «السيد عبد العزيز الحكيم ودوره السياسي في العراق» لنبيل العلوي (ط2، 2026)؛ «الخريطة الانتخابية وانعكاساتها على التنوع السياسي والاجتماعي في العراق بعد 2005»؛ «تطور ظاهرة الصراع الدولي وآفاقها في القرن الحادي والعشرين» للسفير د. محمد الشمري؛ «إشكالية السلطة في الفكر السياسي الإسلامي الشيعي المعاصر» لـ د. عادل الساعدي؛ «آل الحكيم… تعدد أدوار ووحدة مشروع».

من دراسات المؤسسة: «الحرب على إيران وسقوط فرضية نهاية الجغرافية السياسية» لـ م.د. عبدالله رشيد الربيعي؛ «العراق في مواجهة العصر الرقمي: من التشريعات التقليدية إلى قوانين الذكاء الاصطناعي»؛ «الحرب الباردة التكنولوجية»؛ نشرة «اتجاهات بحثية» (العدد الثامن).

قواعدك:
- أجب بلغة السائل (العربية أو الإنجليزية).
- كن دقيقاً وموثقاً؛ عندما تستند إلى إصدار من إصدارات المؤسسة فاذكره بالاسم.
- قاعدة معرفة الكتب الكاملة قيد الربط؛ إن سُئلت عن تفاصيل نصية دقيقة من داخل كتاب ليست لديك، قل ذلك بصراحة وأرشد السائل إلى الكتاب المناسب.
- أسلوبك مهذب ورصين يليق بمؤسسة بحثية.
- أجب فقط ضمن نطاق عمل المؤسسة وموضوعاتها؛ اعتذر بلطف عن الطلبات الخارجة عن ذلك تماماً.`;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://enke-web-lezm.onrender.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

const server = http.createServer((req, res) => {
  const cors = corsHeaders(req.headers.origin || '');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { ...cors, 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (req.method === 'POST' && TG_TOKEN && TG_SECRET &&
      req.url === `/telegram/${TG_SECRET}`) {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 100_000) req.destroy();
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}'); // ack fast; Telegram retries otherwise
      try {
        handleTelegramUpdate(JSON.parse(body || '{}'));
      } catch (_) {}
    });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/chat') {
    res.writeHead(404, { ...cors, 'content-type': 'text/plain' });
    return res.end('not found');
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  if (rateLimited(String(ip).split(',')[0].trim())) {
    res.writeHead(429, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'rate limited' }));
  }

  let body = '';
  req.on('data', (d) => {
    body += d;
    if (body.length > 200_000) req.destroy();
  });
  req.on('end', async () => {
    try {
      const { messages = [], doc, style, mode } = JSON.parse(body || '{}');
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('messages required');
      }
      const msgs = messages.slice(-20).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 4000),
      }));
      if (msgs[msgs.length - 1].role !== 'user') throw new Error('last message must be user');

      const found = await retrieve(msgs[msgs.length - 1].content, mode);
      let system = SYSTEM + kbContext(found.encyclopedia) + faqContext(found.faq) +
        (style === 'detailed'
          ? '\n\nأجب بتفصيلٍ وافٍ مع عناوين ونقاط عند الحاجة.'
          : '\n\nأجب بإيجاز ووضوح — فقرة أو نقاط قليلة تكفي.');
      if (doc && doc.title) {
        system += `\n\nالمستخدم يسأل تحديداً عن هذا العمل:\nالعنوان: ${String(doc.title).slice(0, 300)}\n` +
          `المؤلف: ${String(doc.author || '').slice(0, 200)}\nنبذة: ${String(doc.summary || '').slice(0, 1500)}\n` +
          'اربط إجاباتك بهذا العمل ما لم يغيّر المستخدم الموضوع.';
      }

      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2048,
          stream: true,
          system,
          messages: msgs,
        }),
      });

      res.writeHead(upstream.status, {
        ...cors,
        'content-type': upstream.headers.get('content-type') || 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      res.writeHead(400, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
});

server.listen(process.env.PORT || 10000, () => {
  console.log('enke-chat-api listening on', process.env.PORT || 10000);
});


// ═══════════════════ Telegram bot (same brain as the app) ═══════════════════
// Set TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_WEBHOOK_SECRET in
// Render env vars, then register the webhook:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://enke-chat-api.onrender.com/telegram/<SECRET>

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const TG_API = () => `https://api.telegram.org/bot${TG_TOKEN}`;

// Self-register the webhook on boot so redeploys/domain moves never break it.
(async () => {
  const base = process.env.RENDER_EXTERNAL_URL || '';
  if (!TG_TOKEN || !TG_SECRET || !base) return;
  try {
    const r = await fetch(`${TG_API()}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/telegram/${TG_SECRET}` }),
    });
    console.log('telegram setWebhook:', JSON.stringify(await r.json()));
  } catch (e) {
    console.error('telegram setWebhook failed:', e.message);
  }
})();

// Per-chat rolling history (in-memory; resets when the service sleeps).
const tgHistory = new Map();
function historyFor(chatId) {
  if (!tgHistory.has(chatId)) tgHistory.set(chatId, []);
  if (tgHistory.size > 2000) tgHistory.clear(); // memory guard
  return tgHistory.get(chatId);
}

const TG_WELCOME =
  'مرحباً! أنا <b>مساعد إنكي الذكي</b> 🏛\n' +
  'اسألني عن فكر ومسيرة آل الحكيم — وخاصة سماحة السيد عمار الحكيم — ' +
  'وعن إصدارات مؤسسة إنكي للدراسات والبحوث ودراساتها ومجلتها وجائزة الحكيم.\n\n' +
  'أوامر:\n/new — محادثة جديدة\n/help — المساعدة\n\n' +
  'جرّب: <i>ما أبرز أفكار السيد عمار الحكيم؟</i>';

function tgHtml(text) {
  // Claude markdown → Telegram HTML (safe subset).
  let out = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  out = out.replace(/^#{1,4}\s+(.+)$/gm, '<b>$1</b>');
  out = out.replace(/^\s*[-*]\s+/gm, '• ');
  return out;
}

async function tgCall(method, payload) {
  try {
    const r = await fetch(`${TG_API()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) {
    console.error('tg error', method, e.message);
    return null;
  }
}

async function tgSend(chatId, text) {
  const html = tgHtml(text);
  // Telegram hard limit 4096 chars — split on paragraph boundaries.
  const chunks = [];
  let rest = html;
  while (rest.length > 3900) {
    let cut = rest.lastIndexOf('\n', 3900);
    if (cut < 1000) cut = 3900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const c of chunks) {
    const ok = await tgCall('sendMessage',
        { chat_id: chatId, text: c, parse_mode: 'HTML' });
    if (!ok || !ok.ok) {
      await tgCall('sendMessage', { chat_id: chatId, text: c }); // plain fallback
    }
  }
}

async function claudeOnce(messages, kbText = '') {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1400,
      system: SYSTEM + kbText +
        '\n\nأنت الآن تجيب عبر بوت تيليجرام: أجب بإيجاز ووضوح، ' +
        'واستخدم **التعميق** والنقاط عند الحاجة.',
      messages,
    }),
  });
  const data = await r.json();
  if (data.type === 'error') throw new Error(data.error?.message || 'api error');
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

async function handleTelegramUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/start' || text === '/help') {
    tgHistory.delete(chatId);
    return tgSend(chatId, TG_WELCOME);
  }
  if (text === '/new' || text === '/clear') {
    tgHistory.delete(chatId);
    return tgSend(chatId, 'بدأنا محادثة جديدة ✨ تفضل بسؤالك.');
  }

  const history = historyFor(chatId);
  history.push({ role: 'user', content: text.slice(0, 4000) });
  while (history.length > 12) history.shift();
  if (history[0] && history[0].role !== 'user') history.shift();

  tgCall('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const found = await retrieve(text);
    const reply = await claudeOnce([...history],
        kbContext(found.encyclopedia) + faqContext(found.faq));
    history.push({ role: 'assistant', content: reply });
    await tgSend(chatId, reply ||
        'عذراً، لم أتمكن من توليد إجابة. حاول مرة أخرى.');
  } catch (e) {
    console.error('claude error', e.message);
    await tgSend(chatId,
        'عذراً، تعذر الوصول إلى المساعد حالياً. حاول بعد قليل 🙏');
  }
}
