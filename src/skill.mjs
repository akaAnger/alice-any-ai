import { complete, cleanText, ProviderError } from './provider.mjs';

export function reply(text, buttons = ['Помощь', 'Новая тема'], end = false) {
  return { version: '1.0', response: { text: cleanText(text).slice(0, 1024), end_session: end, buttons: end ? [] : buttons.map(title => ({ title, hide: true })) } };
}

const GREETING = 'Привет! Я на связи с выбранным ИИ. Задай вопрос. Список команд — по слову «Помощь».';
const HELP_TEXT = 'Это отдельный навык для общения с выбранным ИИ. Просто задай вопрос. Если я долго думаю, скажи «Ответ готов?». Еще команды: «Дальше», «Повтори», «Новая тема», «Отмена», «Выход». Не диктуй пароли и секреты: текст получает провайдер модели.';
const WAIT = 'Еще готовлю ответ. Через несколько секунд скажи: «Ответ готов?». Можно сказать «Отмена».';
const BUSY = 'Еще готовлю ответ на прошлый вопрос. Через несколько секунд скажи «Ответ готов?». Чтобы задать новый вопрос сразу, скажи «Отмена».';
const WAIT_BUTTONS = ['Ответ готов?', 'Отмена'];
const CARRY_MS = 10 * 60000;

// Команды сравниваются целиком: длинный вопрос никогда не примется за команду.
const PHRASES = {
  stop: ['выход', 'выйти', 'выйди', 'хватит', 'стоп', 'завершить', 'закончить', 'закрой навык', 'пока', 'до свидания'],
  reset: ['новая тема', 'начать заново', 'начни заново', 'забудь разговор', 'очистить историю', 'сменим тему', 'другая тема'],
  cancel: ['отмена', 'отмени', 'отменить', 'не надо', 'отмени запрос'],
  help: ['помощь', 'помоги', 'что ты умеешь', 'что умеешь', 'справка', 'какие команды', 'команды'],
  next: ['дальше', 'продолжи', 'продолжай', 'продолжение', 'что дальше', 'еще', 'следующая часть'],
  repeat: ['повтори', 'повтори еще раз', 'еще раз', 'повторить', 'повтори последнее', 'не расслышал', 'не расслышала', 'что ты сказал', 'что ты сказала'],
  poll: ['ответ готов', 'готов ответ', 'готово', 'готов', 'ты готов', 'ну что', 'ну что там', 'что там', 'как там', 'ну как', 'есть ответ', 'где ответ', 'какой ответ', 'проверить ответ', 'получить ответ']
};
const COMMANDS = new Map(Object.entries(PHRASES).flatMap(([action, list]) => list.map(phrase => [phrase, action])));
// Слова, которые люди добавляют к командам: «повтори, пожалуйста», «давай дальше», «Алиса, стоп».
const FILLER = new Set(['пожалуйста', 'алиса', 'ну', 'а', 'и', 'давай', 'слушай', 'так', 'можешь', 'можно', 'мне', 'уже', 'тогда', 'ладно', 'хорошо', 'окей', 'ок']);
const normalize = text => text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

export function commandOf(text) {
  const plain = normalize(text);
  if (!plain || plain.split(' ').length > 6) return '';
  const stripped = plain.split(' ').filter(word => !FILLER.has(word)).join(' ');
  for (const candidate of [plain, stripped]) if (candidate && COMMANDS.has(candidate)) return COMMANDS.get(candidate);
  return '';
}

export function validateEnvelope(body) {
  if (!body || body.version !== '1.0' || !body.session || !body.request) return false;
  const s = body.session;
  const validId = x => typeof x === 'string' && x.length > 0 && x.length <= 128;
  return validId(s.session_id) && validId(s.skill_id) && Number.isInteger(s.message_id) && s.message_id >= 0 && s.message_id <= 99999999 &&
    (validId(s.user?.user_id) || validId(s.application?.application_id)) &&
    ['SimpleUtterance', 'ButtonPressed'].includes(body.request.type) &&
    (body.request.command === undefined || typeof body.request.command === 'string') &&
    (body.request.original_utterance === undefined || typeof body.request.original_utterance === 'string');
}

export function splitAnswer(text) {
  let rest = cleanText(text).slice(0, 12000); const chunks = [];
  while (rest) {
    let end = Math.min(850, rest.length);
    if (rest.length > end) {
      const prefix = rest.slice(0, end);
      const sentence = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '));
      const space = prefix.lastIndexOf(' ');
      end = sentence > 400 ? sentence + 1 : space > 0 ? space : end;
    }
    chunks.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
  }
  return chunks;
}

function historyWindow(history) {
  let chars = 0; const selected = [];
  for (let i = history.length - 2; i >= 0 && selected.length < 10; i -= 2) {
    const pair = history.slice(i, i + 2);
    const size = pair.reduce((n, x) => n + x.content.length, 0);
    if (chars + size > 10000) break;
    selected.unshift(...pair); chars += size;
  }
  return selected;
}

export class SkillEngine {
  constructor(getConfig, { generate = complete, now = Date.now, maxSessions = 256, maxActive = 4 } = {}) {
    this.getConfig = getConfig; this.generate = generate; this.now = now;
    this.sessions = new Map(); this.maxSessions = maxSessions; this.maxActive = maxActive;
    this.active = 0; this.attempts = []; this.daily = { day: '', count: 0 };
  }
  reserve() {
    const c = this.getConfig(), now = this.now(), day = new Date(now).toISOString().slice(0, 10);
    if (this.daily.day !== day) this.daily = { day, count: 0 };
    this.attempts = this.attempts.filter(t => now - t < 60000);
    if (this.daily.count >= c.dailyLimit) return 'Достигнут дневной лимит этого сервера. Он защищает от лишних расходов.';
    if (this.active >= this.maxActive || this.attempts.length >= 20) return 'Слишком много запросов. Попробуй через минуту.';
    this.daily.count++; this.attempts.push(now); return '';
  }
  usage() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return { used: this.daily.day === day ? this.daily.count : 0, limit: this.getConfig().dailyLimit };
  }
  prune() {
    for (const [key, s] of this.sessions) if (this.now() - s.touched > 20 * 60000) {
      s.job?.controller.abort(); this.sessions.delete(key);
    }
  }
  clearSessions() {
    for (const s of this.sessions.values()) s.job?.controller.abort();
    this.sessions.clear();
  }
  // Если сессия навыка закрылась, пока модель думала, ответ уже оплачен.
  // Новая сессия того же пользователя забирает его вместе с непрочитанным продолжением.
  // История разговора между сессиями не переносится.
  carryOver(s) {
    let source = null;
    for (const other of this.sessions.values()) {
      if (other === s || other.owner !== s.owner || this.now() - other.touched > CARRY_MS) continue;
      if ((other.job || other.chunks.length) && (!source || other.touched > source.touched)) source = other;
    }
    if (!source) return;
    s.job = source.job; s.chunks = source.chunks; s.lastText = source.lastText;
    source.job = null; source.chunks = [];
  }
  handle(body) {
    this.prune();
    const identity = body.session.user?.user_id || body.session.application.application_id;
    const owner = JSON.stringify([body.session.skill_id, identity]);
    const key = JSON.stringify([body.session.skill_id, identity, body.session.session_id]);
    let s = this.sessions.get(key);
    if (!s) {
      if (this.sessions.size >= this.maxSessions) return Promise.resolve(reply('Сервер занят. Повтори позже.'));
      s = { owner, touched: this.now(), history: [], cache: new Map(), lastId: -1, job: null, chunks: [], lastText: '', minute: [] };
      this.carryOver(s);
      this.sessions.set(key, s);
    }
    s.touched = this.now();
    const id = body.session.message_id;
    if (s.cache.has(id)) return s.cache.get(id);
    if (id < s.lastId) return Promise.resolve(reply('Это устаревший запрос. Повтори последнюю фразу.'));
    s.lastId = id;
    // Обещание кладется в кеш до запуска: одновременные повторы не создают второй платный запрос.
    const result = Promise.resolve().then(() => this.process(s, body)).catch(() => reply('Внутренняя ошибка. Скажи «Новая тема» и повтори вопрос.'));
    s.cache.set(id, result);
    while (s.cache.size > 24) s.cache.delete(s.cache.keys().next().value);
    return result;
  }
  reset(s) {
    s.job?.controller.abort(); s.job = null; s.history = []; s.chunks = []; s.lastText = ''; s.cache.clear();
  }
  takeChunk(s, lead = '') {
    if (!s.chunks.length) return reply('Продолжения нет. Задай новый вопрос.');
    const text = lead + s.chunks.shift() + (s.chunks.length ? ' Скажи «Дальше», чтобы услышать продолжение.' : '');
    s.lastText = text;
    return reply(text, s.chunks.length ? ['Дальше', 'Повтори', 'Новая тема'] : ['Повтори', 'Новая тема']);
  }
  async collect(s, job, lead = '') {
    if (!job.done) {
      let timer;
      await Promise.race([job.promise, new Promise(resolve => { timer = setTimeout(resolve, this.getConfig().waitMs); })]);
      clearTimeout(timer);
    }
    if (s.job !== job) return reply('Запрос отменен. Можно задать новый вопрос.');
    if (!job.done) return reply(WAIT, WAIT_BUTTONS);
    s.job = null;
    if (job.error) return reply(lead + job.error);
    s.history = historyWindow([...s.history, { role: 'user', content: job.prompt }, { role: 'assistant', content: job.text.slice(0, 6000) }]);
    s.chunks = splitAnswer(job.text);
    return this.takeChunk(s, lead);
  }
  greet(s, isNew) {
    if (s.job?.done) return this.collect(s, s.job, 'Ответ на прошлый вопрос. ');
    if (s.job) return reply(BUSY, WAIT_BUTTONS);
    if (s.chunks.length) return reply('От прошлого ответа осталось продолжение. Скажи «Дальше», чтобы его услышать, или задай новый вопрос.', ['Дальше', 'Новая тема']);
    return reply(isNew ? GREETING : 'Я слушаю. Задай вопрос.');
  }
  async process(s, body) {
    const r = body.request;
    const raw = r.type === 'ButtonPressed' ? r.payload?.command || '' : r.command ?? r.original_utterance ?? '';
    if (typeof raw !== 'string') return reply('Не удалось прочитать фразу. Повтори ее голосом.');
    const text = raw.trim(), command = commandOf(text);
    if (command === 'stop') { this.reset(s); return reply('Навык завершен.', [], true); }
    if (command === 'reset') { this.reset(s); return reply('История этой сессии очищена. О чем поговорим?'); }
    if (command === 'cancel') { s.job?.controller.abort(); s.job = null; return reply('Запрос отменен. Задай другой вопрос.'); }
    if (command === 'help') return reply(HELP_TEXT);
    if (!text) return this.greet(s, body.session.new === true);
    if (command === 'next') return this.takeChunk(s);
    if (command === 'repeat') return reply(s.lastText || 'Пока нечего повторять. Задай вопрос.');
    if (command === 'poll') return s.job ? this.collect(s, s.job) : reply('Ожидающего ответа нет. Задай вопрос.');
    // Ответ уже готов, а человек сказал что-то другое: сразу отдаем ответ, без лишнего «Ответ готов?».
    if (s.job) return s.job.done ? this.collect(s, s.job, 'Сначала ответ на прошлый вопрос. ') : reply(BUSY, WAIT_BUTTONS);
    if (text.length > 2000) return reply('Вопрос слишком длинный. Сократи его до 2000 символов.');
    s.minute = s.minute.filter(t => this.now() - t < 60000);
    if (s.minute.length >= 6) return reply('Не больше шести новых вопросов в минуту. Подожди немного.');
    const problem = this.reserve(); if (problem) return reply(problem);
    s.minute.push(this.now());
    const c = this.getConfig();
    const job = { prompt: text, controller: new AbortController(), done: false, text: '', error: '' };
    s.job = job; s.chunks = []; this.active++;
    job.promise = Promise.resolve().then(() => this.generate(c, [...s.history, { role: 'user', content: text }], job.controller.signal))
      .then(answer => { job.text = cleanText(answer); })
      .catch(e => { job.error = e instanceof ProviderError ? e.message : 'Ошибка обращения к ИИ. Проверь подключение в панели настройки.'; })
      .finally(() => { job.done = true; this.active--; });
    return this.collect(s, job);
  }
}
