import { registerPlugin } from '@capacitor/core';
import { initLlama } from 'llama-cpp-capacitor';

const ModelPicker = registerPlugin('ModelPicker');

// ChatML (Qwen3) مع تعطيل التفكير بإدخال كتلة think فارغة
const PROMPT =
  '<|im_start|>user\nIn one short sentence, what is hypertension?<|im_end|>\n' +
  '<|im_start|>assistant\n<think>\n\n</think>\n\n';

const $ = (id) => document.getElementById(id);
const btnPick = $('btnPick');
const btnGen = $('btnGen');
const copyStatus = $('copyStatus');
const output = $('output');
const speed = $('speed');
const logBox = $('log');

let busy = false;
let modelInfo = { exists: false, path: '', size: 0 };
let prevSessionNote = '';

const pad = (n, l = 2) => String(n).padStart(l, '0');
function ts() {
  const d = new Date();
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}
const mb = (b) => (b / 1048576).toFixed(0);

async function refreshLog() {
  try {
    const r = await ModelPicker.readLog();
    const lines = (r.text || '').trim().split('\n').filter(Boolean).slice(-14);
    logBox.textContent = (prevSessionNote ? prevSessionNote + '\n---\n' : '') + lines.join('\n');
    logBox.scrollTop = logBox.scrollHeight;
  } catch (e) {
    logBox.textContent = 'log read error: ' + e;
  }
}

// يكتب السطر على القرص (fsync) قبل الرجوع، لذلك نستخدم await قبل العمليات الخطرة
async function step(msg) {
  const line = ts() + ' ' + msg;
  try { localStorage.setItem('lastStep', line); } catch (e) {}
  try { await ModelPicker.appendLog({ line }); } catch (e) {}
  await refreshLog();
}

function setBusy(b) {
  busy = b;
  btnPick.disabled = b;
  btnGen.disabled = b || !modelInfo.exists;
}

async function refreshModel(setText) {
  try {
    modelInfo = await ModelPicker.getModelInfo();
  } catch (e) {
    modelInfo = { exists: false, path: '', size: 0 };
  }
  if (setText) {
    if (modelInfo.exists) {
      copyStatus.textContent = 'النموذج جاهز داخل التطبيق (' + mb(modelInfo.size) + ' MB)';
    } else if (modelInfo.partialSize > 0) {
      copyStatus.textContent = 'نسخة جزئية غير مكتملة (' + mb(modelInfo.partialSize) + ' MB). أعد اختيار الملف.';
    } else {
      copyStatus.textContent = 'لا يوجد نموذج. اختر ملف GGUF.';
    }
  }
  btnGen.disabled = busy || !modelInfo.exists;
}

ModelPicker.addListener('copyProgress', (e) => {
  const pct = e.total > 0 ? Math.floor((e.copied * 100) / e.total) : 0;
  copyStatus.textContent = 'جارٍ النسخ: ' + pct + '% (' + mb(e.copied) + ' / ' + mb(e.total) + ' MB)';
});

btnPick.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  let failed = false;
  try {
    await step('PICK_START');
    copyStatus.textContent = 'اختر ملف .gguf من نافذة الملفات...';
    const r = await ModelPicker.pickModel(); // النسخ يتم داخل الإضافة (COPY_START / COPY_END في السجل)
    await step('PICK_END copied=' + r.copied + ' size=' + r.size);
  } catch (e) {
    failed = true;
    const m = (e && e.message) || String(e);
    await step('PICK_ERROR ' + m);
    copyStatus.textContent = m === 'cancelled' ? 'تم الإلغاء' : 'فشل: ' + m;
  } finally {
    await refreshModel(!failed);
    setBusy(false);
  }
});

btnGen.addEventListener('click', async () => {
  if (busy || !modelInfo.exists) return;
  setBusy(true);
  output.textContent = '';
  speed.textContent = '-';
  let ctx = null;
  try {
    await step('LOAD_START n_ctx=4096 threads=4 mmap=true gpu_layers=0 path=' + modelInfo.path);
    copyStatus.textContent = 'جارٍ تحميل النموذج...';
    const t0 = performance.now();
    ctx = await initLlama({
      model: modelInfo.path,
      n_ctx: 4096,
      n_threads: 4,
      n_gpu_layers: 0,
      use_mmap: true,
      use_mlock: false,
    });
    await step('LOAD_END ' + ((performance.now() - t0) / 1000).toFixed(1) + 's');
    copyStatus.textContent = 'تم تحميل النموذج';

    await step('GEN_START');
    let streamed = '';
    let n = 0;
    let tFirst = null;
    const res = await ctx.completion(
      {
        prompt: PROMPT,
        n_predict: 48,
        n_threads: 4,
        temperature: 0.3,
        stop: ['<|im_end|>'],
      },
      (d) => {
        if (tFirst === null) tFirst = performance.now();
        n++;
        streamed += d.token;
        output.textContent = streamed;
      }
    );
    const tEnd = performance.now();
    await step('GEN_END tokens=' + (res && res.tokens_predicted));

    output.textContent = ((res && res.text) || streamed).trim();

    let tps = res && res.timings && res.timings.predicted_per_second;
    if (!tps || !isFinite(tps)) {
      tps = tFirst !== null && n > 1 ? (n - 1) / ((tEnd - tFirst) / 1000) : 0;
    }
    const count = res && res.tokens_predicted != null ? res.tokens_predicted : n;
    speed.textContent = tps.toFixed(2) + ' token/s  |  tokens: ' + count;
  } catch (e) {
    const m = (e && e.message) || String(e);
    await step('ERROR ' + m);
    output.textContent = 'خطأ: ' + m;
  } finally {
    if (ctx) {
      try {
        await step('RELEASE_START');
        await ctx.release();
        await step('RELEASE_END');
      } catch (e) {
        await step('RELEASE_ERROR ' + ((e && e.message) || e));
      }
    }
    setBusy(false);
  }
});

(async function init() {
  try {
    const r = await ModelPicker.readLog();
    const lines = (r.text || '').trim().split('\n').filter(Boolean);
    const last = lines.length ? lines[lines.length - 1] : '';
    const tag = last.split(' ')[1] || '';
    const risky = ['PICK_START', 'COPY_START', 'LOAD_START', 'GEN_START', 'RELEASE_START'];
    if (last) {
      prevSessionNote = risky.indexOf(tag) >= 0
        ? 'تحذير: الجلسة السابقة توقفت أثناء: ' + last
        : 'آخر خطوة من الجلسة السابقة: ' + last;
    }
  } catch (e) {}
  await step('APP_START');
  await refreshModel(true);
})();
