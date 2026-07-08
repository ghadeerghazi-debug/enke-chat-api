// ENKE chat proxy — keeps the Anthropic API key server-side and streams
// Claude replies to the ENKE web app. Zero dependencies (Node 18+).
//
// Env: ANTHROPIC_API_KEY (set in Render dashboard, never in code).

const http = require('http');

const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-opus-4-8';

// Only the ENKE web app (and local dev) may call this proxy.
const ALLOWED_ORIGINS = new Set([
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

const SYSTEM = `أنت "مساعد إنكي" — المساعد الذكي الرسمي لمؤسسة إنكي للدراسات والبحوث، مؤسسة ثقافية عراقية مستقلة تُعنى بالبحث العلمي وتطوير العلوم الإنسانية والاجتماعية (enke.iq). تعمل المؤسسة عبر ثلاثة أقسام: دار إنكي للنشر والتوزيع، والجمعية العلمية التي تصدر مجلة إنكي للعلوم الإنسانية والاجتماعية (مجلة فصلية محكمة)، وقسم الدراسات والبحوث. وتقيم المؤسسة جائزة الحكيم البحثية السنوية بمحاورها: الثقافة والتعليم، الاقتصاد والتنمية المستدامة، والقضايا الاجتماعية (مكافحة المخدرات).

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
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://enke-web.onrender.com';
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
      const { messages = [], doc, style } = JSON.parse(body || '{}');
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('messages required');
      }
      const msgs = messages.slice(-20).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 4000),
      }));
      if (msgs[msgs.length - 1].role !== 'user') throw new Error('last message must be user');

      let system = SYSTEM +
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
