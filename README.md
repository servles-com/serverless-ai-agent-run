# serverless-ai-agent-run

Запускает AI-агента как **фоновую задачу за HTTP API — по ощущениям как Cloudflare
Worker**. Отправляешь `POST /runs` с задачей (и файлами/репо), сразу получаешь `run_id`,
прогресс приходит на твой вебхук, результат забираешь по API. Любое падение
заканчивается машиночитаемым диагнозом: *почему* упало, с доказательствами и подсказкой.

**С 2026-09-28 SAR — тонкий прокси.** По умолчанию ран выполняет
[trained-assist-agent](https://github.com/trained-assist/trained-assist-agent) на той же
машине (`POST /web/run-bearer`, ответ потоком SSE); изоляция — его slots + ACL профиля,
движок и модель выбирает профиль (`SAR_AGENT_PROFILE`). Свои Docker/gVisor-комнаты
**на паузе**: как были устроены и как вернуть — [docs/docker-gvisor-pause.md](docs/docker-gvisor-pause.md).
Можно выбрать `SAR_BACKEND=runner-api`: тогда SAR отправляет задачу в
[ai-agent-runner](https://github.com/trained-assist/ai-agent-runner), читает replayable SSE,
отменяет по `runId` и забирает финальный результат. Principal, профиль и repository binding
при этом задаёт доверенная конфигурация Runner API; SAR request не может их переопределить. Режим остаётся opt-in до проверки
на настроенном Runner API и VM Worker. SAR держит внешний контракт: API, вебхуки с HMAC,
диагноз, стриминг, пачки, CLI.

> **North Star:** [docs/north-star-user-scenario.md](docs/north-star-user-scenario.md) · путь: [docs/north-star-roadmap.md](docs/north-star-roadmap.md) — агенты пачками по API на своей машине,
> каждый в своей изоляции; GitHub как полноценный житель; креды без LLM; результат всегда PR, файл или явная ошибка.
>
> **Хостинг: одна машина, никаких облачных сервисов.** SAR стоит рядом с trained-assist-agent
> на основной VM (systemd `sar`, `deploy/sar.service`, конфиг `/opt/sar/.env`).
>
> **Статус: фаза 1 миграции** — `POST /runs`, `GET /runs/{id}`, вебхуки, события/стрим, пачки.
> Фаза 2: артефакты (файлы от агента), host-side PR, транскрипт из сессии агента.
> Безопасность: [docs/security-checklist.md](docs/security-checklist.md) ·
> CI/CD и логи: [docs/ci-cd-and-logging-development-plan.md](docs/ci-cd-and-logging-development-plan.md) ·
> планы: [docs/ROADMAP.md](docs/ROADMAP.md) ·
> потребности пользователя: [docs/user-needs-discovery.md](docs/user-needs-discovery.md)

---

## Главная идея

**Среда хороша ровно настолько, насколько хорошо она ловит и объясняет свои падения.**
Агенты падают постоянно: rate limit, 504 от провайдера, зависания, «готово!» без
результата, рестарт соседнего сервиса. SAR построен не чтобы это скрыть, а чтобы каждое
такое падение попало в понятную категорию.

---

## Как проходит один запуск

```text
POST /runs ──► валидация (то, что бэкенд не умеет, — сразу 400) ──► QUEUED
                                            │ очередь (SAR_MAX_ROOMS одновременно)
                                   PREPARING│ task + входные файлы + repo → один текст задачи
                                            │ runs/<id>/agent/request.json
                                            ▼
                                    RUNNING │ selected backend:
                                            │ trained-assist-agent → POST /web/run-bearer (SSE)
                                            │ runner-api → POST /v1/runs, GET /events (SSE), GET /result
                                            │   Authorization: Bearer SAR_AGENT_SECRET
                                            │   {username: SAR_AGENT_PROFILE, task, requestId: run_id}
                                            │ SSE: session | progress | chunk | done | error (+ ping)
                                            │   progress → agent.tool, chunk → agent.text
                                            │ сторожа: общий таймаут, idle (нет progress/chunk N сек)
                                            │   → обрыв + POST /web/stop-bearer по session id
                                            ▼
                         классификатор ──► SUCCEEDED | FAILED | TIMED_OUT | CANCELLED
                                            + diagnosis {category, summary, evidence, hints}
                                            ▼
                                  run.completed → вебхук, журнал, /runs/<id>
```

`result.text` — последний блок ответа агента. Поля запроса, которые бэкенд принимает, но
не может применить (`model`, `secrets`, `limits.memory_mb/cpus/pids`), не ломают ран, а
попадают в `warnings`. `repo.pull_request`, `credentials`, `expect.artifacts/json` сейчас —
400 при создании (артефактов у бэкенда пока нет), а не `FAILED` через десять минут.

Каждое событие по пути (`run.state`, `run.log`, `agent.text`, `agent.tool`, …) пишется в
`events.jsonl` и, если задан вебхук, отправляется на него — по порядку, с HMAC-подписью.
Агентные события шлются только с `agent_events: true`.

### Что лежит на диске по каждому запуску

```text
/var/lib/sar/runs/<run_id>/
  run.json            состояние, запрос, результат, диагноз, agent_backend {profile, session_id, …}
  diagnosis.json      только при неуспехе
  events.jsonl        всё, что происходило, построчно
  agent/request.json  что ушло в trained-assist-agent (без авторизации)
  agent/stream.log    сырой SSE-поток ответа (без ping)
  artifacts/          пусто до фазы 2
```

Хранится 72 часа (`SAR_RETENTION_HOURS`), потом удаляется. Всё — обычные файлы:
разбирать падение можно `cat`/`jq` или отдать папку другому агенту. Полная история
сессии агента — у trained-assist-agent по `agent_backend.session_id`.

### Классификация падений

[src/failures.ts](src/failures.ts) — чистая функция от того, что увидел прокси
(HTTP-статус, обрыв соединения, SSE-события, сторожа).

| category | что значит | чья вина |
|---|---|---|
| `AGENT_AUTH_FAILED` | trained-assist-agent ответил 401/403: `SAR_AGENT_SECRET` ≠ его `WEB_VERIFY_SECRET`/`AGENT_SECRET` | конфиг |
| `AGENT_REJECTED` | 4xx от агента (неверный профиль, дубликат `requestId` → 409) | вход/конфиг |
| `AGENT_UNAVAILABLE` | агент не отвечает или 5xx до начала рана | среда |
| `AGENT_STREAM_LOST` | поток оборвался посреди рана или закрылся без `done` (обычно рестарт агента) | среда |
| `MODEL_RATE_LIMITED` `MODEL_NOT_FOUND` `MODEL_AUTH_FAILED` `MODEL_CONTEXT_OVERFLOW` `MODEL_PROVIDER_ERROR` | агент вернул `error`, похожий на ошибку провайдера | провайдер |
| `AGENT_CRASHED` | агент вернул любую другую ошибку | агент |
| `TIMEOUT` | превышен `timeout_s` | агент/задача |
| `IDLE_STALL` | ни `progress`, ни `chunk` за `idle_timeout_s` (ping не считается) | агент |
| `AGENT_EMPTY_RESULT` | `done` без ответа | агент/модель |
| `ORPHANED_BY_RESTART` | SAR перезапустился посреди рана | среда |
| `RUNTIME_BUG` | исключение в нашем коде | среда |
| `EXPECTATION_NOT_MET` | ран «успешен», но не сдал обещанное в `expect` (текст не тот) | агент/модель |
| `NO_DELIVERABLE` | без `expect`: нет финального текста | агент/модель |
| `SILENT_FAILURE`, `HARNESS_ERROR` (только dogfood) | см. `scripts/dogfood-lib.ts` | харнесс |

---

## Откуда сейчас берутся задачи

1. **Клиенты по API** — pr-auto-fix и ручные запуски (`sar run …`, curl).
2. **Dogfood** (`scripts/dogfood-free-models.ts`, `tests/dogfood/tasks.json`) — **пока не
   совместим с прокси**: задачи ждут файлы в `/artifacts` (`expect.artifacts` → 400).
   Вернётся с артефактами в фазе 2 или после переписывания задач на `expect.text`.

---

## API

Все эндпоинты кроме `/healthz` — с `Authorization: Bearer $SAR_API_TOKEN`.

```http
POST /runs                        → 202 {id, state, stream_token, links}
GET  /runs                        последние раны
GET  /runs/{id}                   состояние, результат, диагноз
GET  /runs/{id}/events            JSON; ?after=<seq>; SSE при ?follow=1
GET  /runs/{id}/stream            SSE: ?types=text,tool,step,state,stdout,stderr,error,log; ?format=transcript; heartbeat; Last-Event-ID
GET  /runs/{id}/transcript        markdown-транскрипт сессии (?format=text — plain)
GET  /runs/{id}/debug             всё для разбора падения одним ответом
GET  /runs/{id}/artifacts         список
GET  /runs/{id}/artifacts/{path}  скачать
POST /runs/{id}/cancel
POST /batches                     N задач → N ранов, не больше concurrency одновременно → 202 {id}
GET  /batches[/{id}[/report]]     сводка пачки / отчёт markdown; POST /batches/{id}/cancel
GET  /healthz                     доступен ли выбранный backend, очередь
```

```json
{
  "agent": "opencode",
  "task": "Fix the failing test in calc.py and reply with the fixed file",
  "model": "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "files": { "calc.py": "..." },
  "repo": { "url": "https://github.com/org/repo", "ref": "main" },
  "secrets": ["GITHUB_TOKEN"],
  "webhook": { "url": "https://you.example/hook", "secret": "hmac-key", "agent_events": false },
  "expect": { "text": "ok" },
  "limits": { "timeout_s": 900, "idle_timeout_s": 300 }
}
```

Пачка: `{"run": {шаблон запроса, в task можно {{var}}}, "items": [{"id", "vars", "task"?, "files"?, "model"?, "expect"?}], "concurrency": 2}`.
Каждый элемент — обычный ран (свой `/debug`, `expect`); раны создаются, когда у пачки есть слот, и
после рестарта сервиса пачка досабмичивает оставшиеся. Итог: `SUCCEEDED` только если успешны все,
иначе `PARTIAL`/`FAILED`/`CANCELLED`; `GET /batches/{id}/report` — одна таблица на всю пачку.

Обязателен только `task`. `model` и `secrets` принимаются, но не применяются (движок, модель и
креды — у профиля trained-assist; на ране будет `warnings`). `expect` — контракт результата:
`text` (`true` или регэксп для финального ответа), `non_empty`; `artifacts`/`json`/`github_pr`
вернутся в фазе 2 (сейчас 400). Не выполнен → `FAILED` / `EXPECTATION_NOT_MET` со списком
невыполненного, а не тихий `SUCCEEDED`. Вебхук: заголовок
`X-SAR-Signature: sha256=HMAC(secret, body)`, последнее событие — `run.completed`.
`webhook.agent_events: "coalesced"` — агентные события пачкой `agent.coalesced` не чаще раза в 2 с
(`count`, `counts`, `last_text`, `last_tool`, до 50 последних событий).

**Стриминг ([src/stream.ts](src/stream.ts), #97 фаза 1).** `POST /runs` отдаёт `stream_token` — токен
только на чтение и только этого рана: `events`, `stream`, `transcript`, `artifacts` (403 на всё остальное,
в том числе на другой ран). Хранится только sha256, живёт до удаления рана. Для `EventSource` без заголовков —
`?access_token=<stream_token>` (мастер-ключ так не принимается). Секреты вычищены до fan-out (`store.emit`).
Гранулярность — как у trained-assist-agent: `agent.tool` на каждую метку прогресса, `agent.text` на каждый
блок ответа. `"live": true` принимается, но дельт текста сейчас нет (были у opencode в комнате, см. пауза).

Эталонный потребитель: `scripts/telegram-live.ts <run_id>` (env `SAR_STREAM_TOKEN`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`) — одно Telegram-сообщение, обновляется вживую (не чаще раза в 2 с), после рестарта
продолжает с `Last-Event-ID` и правит то же сообщение.

---

## CLI

`cli/sar.ts` — клиент к тому же HTTP API, без зависимостей (Node ≥ 23.6 исполняет его
напрямую; `npm link` ставит команду `sar`). В `src/` не лезет — только публичный API.

```bash
export SAR_URL=http://127.0.0.1:8787   # по умолчанию; снаружи — через nginx `/sar/`
export SAR_TOKEN=...                   # API-токен (SAR_API_TOKEN тоже подхватывается)

sar run --task "Fix calc.py and reply with the fixed file" --file calc.py \
        --follow                                  # события по SSE, в конце итог и диагноз
sar run --task "..." --repo https://github.com/org/repo@main --timeout 600
sar status <id> [--json]
sar logs <id> [--follow]
sar artifacts <id>                                # список
sar artifacts <id> --get calc.py [--out file|-]   # скачать (по умолчанию в ./calc.py)
```

- `sar run` без `--follow` печатает только `run_id` (удобно в скриптах); с `--follow` события
  идут в stderr, итог (`state`, `category`, `why`, `hint`, результат) — в stdout.
- `--file PATH[=NAME]` — входной файл (текст), уходит агенту внутри текста задачи; `--expect-artifact`
  (→ `expect.artifacts`) до фазы 2 отклоняется сервером с 400.
- Коды выхода: `0` — ок / ран `SUCCEEDED`, `1` — ошибка API или ран не успешен, `2` — неверные аргументы.
- `sar cred put|request` — **пока заглушка**: печатает «не реализовано», ждёт хендлов кредов (#92)
  и API-форм ZeroCreds (Zerocreds-com/zerocreds-server#63).

Тесты: `tests/unit/cli-args.test.ts` (разбор аргументов, сборка запроса, SSE-парсер, вывод).

---

## Эксплуатация

SAR стоит на машине trained-assist-agent и ходит к нему по `127.0.0.1`.

```bash
# Один раз (root):
useradd --system --home /var/lib/sar sar
git clone https://github.com/servles-com/serverless-ai-agent-run /opt/sar && cd /opt/sar && npm ci --include=dev
cp .env.example .env && chmod 600 .env && chown sar:sar .env   # SAR_API_TOKEN, SAR_AGENT_SECRET, SAR_AGENT_PROFILE
cp deploy/sar.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now sar

# Обновление после merge в main:
cd /opt/sar && git pull --ff-only && npm ci --include=dev && systemctl restart sar

curl -s localhost:8787/healthz                 # ok=true, если trained-assist-agent отвечает на /health
journalctl -u sar -f                           # строка на старт/финиш каждого рана
```

`SAR_AGENT_SECRET` = `WEB_VERIFY_SECRET` trained-assist-agent (или его `AGENT_SECRET`, если
первый не задан). Профиль `SAR_AGENT_PROFILE` (по умолчанию `sar-proxy`) — отдельный
профиль trained-assist под раны SAR: его движок, модель и креды применяются ко всем ранам.

Для Runner API переключение задаётся в `/opt/sar/.env`: установить `SAR_BACKEND=runner-api`,
задать `SAR_RUNNER_API_URL` и `SAR_RUNNER_API_TOKEN`, затем перезапустить `sar`. Токен должен
быть привязан к SAR principal с `runs:write`/`runs:read` scopes и нужному профилю. Перед
переключением `GET /healthz` должен показывать `backend: "runner-api"` и `ok: true`; Runner API
должен иметь зарегистрированный совместимый VM Worker. Если проверка не проходит, оставить
`SAR_BACKEND=trained-assist-agent`.

Снаружи — через nginx trained-assist (долгие раны держат SSE):

```nginx
location /sar/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;          # /runs/{id}/stream и events?follow=1
    proxy_read_timeout 600s;
}
```

| что | где |
|---|---|
| код | `/opt/sar` |
| конфиг, API-токен, секрет агента | `/opt/sar/.env` |
| раны | `/var/lib/sar/runs/` |
| сервис | `sar` (`deploy/sar.service`) |

### Локальная разработка

```bash
npm install --include=dev
npm run typecheck && npm run lint && npm run test:unit    # тест прокси поднимает поддельный trained-assist-agent
SAR_INSECURE_DEV=1 SAR_AGENT_URL=http://127.0.0.1:8080 SAR_AGENT_SECRET=... npm start
```

---

## Структура

```text
src/server.ts        HTTP API
src/runner.ts        жизненный цикл рана, восстановление после рестарта, GC
src/queue.ts         очередь и отмена
src/agent-proxy.ts   SAR-запрос → trained-assist-agent /web/run-bearer (SSE), стоп, health, валидация
src/failures.ts      классификатор падений, контракт `expect`
src/webhooks.ts      подписанные вебхуки по порядку, с ретраями
src/stream.ts        SSE-стрим, транскрипт, stream_token
src/batches.ts       пачки
src/store.ts         раны на диске
src/creds/           хендлы кредов, файловый бэкенд, брокер с аудитом (не подключено к ранам)
cli/sar.ts           CLI `sar`: run / status / logs / artifacts (клиент API)
scripts/             dogfood, telegram-live (эталонный потребитель стрима), CI-гарды
deploy/              systemd-юниты
tests/unit           классификатор, прокси против поддельного агента, стрим, пачки, CLI
docs/                архитектура, безопасность, roadmap, пауза Docker/gVisor
```

---

## Claude Code Instructions

- **SAR — прокси к trained-assist-agent.** Исполнение, изоляция, модели и креды — на его
  стороне (профиль `SAR_AGENT_PROFILE`). Не тащить обратно в SAR запуск агентов и Docker без
  решения владельца; как вернуть комнаты — `docs/docker-gvisor-pause.md`.
- **Модели — только через LLM ladder владельца** (`trained-assist-llm-ladder`), теперь это
  настройка профиля trained-assist, а не SAR. Не подключать OpenRouter напрямую как дефолт.
- Контракт API не ломать: то, что бэкенд не умеет, — 400 при создании рана с понятной
  причиной, то, что принято, но не применено, — `warnings` на ране.
- Требования — из задачи (API + вебхук + диагностика падений), а не из раннего
  мультитенантного драфта. Тенанты и прочий access-control — **потом**, см. ROADMAP.
- Node ≥ 23.6 исполняет `.ts` напрямую — без сборки. Только erasable TypeScript
  (без enum, без parameter properties). Без runtime-зависимостей.
- Каждое новое наблюдённое падение → категория в `src/failures.ts` + unit-тест в
  `tests/unit/failures.test.ts`; если воспроизводится поддельным агентом — кейс в
  `tests/unit/agent-proxy.test.ts`.
- Разбор рана: `GET /runs/{id}/debug` или на машине `/var/lib/sar/runs/<id>/`; дальше —
  сессия `agent_backend.session_id` у trained-assist-agent.
- Требования и статус — в GitHub issues (open/closed + комментарий с причиной). `docs/requirements-log.md` — архив, строки не добавлять. `docs/security-checklist.md` держать актуальным.
- Флоу: feature-ветка → PR → CI зелёный → merge → `git pull` + `systemctl restart sar` на машине.
- Никаких облачных сервисов (GCS, Secret Manager, managed DB/queues): только машина, файлы, sqlite, systemd.
- План CI/CD и логов: `docs/ci-cd-and-logging-development-plan.md`. Репо публичный; `main` защищён: только PR + зелёный `check`, в том числе для админов. Секреты, токены, IP машины и личные данные в репо и issues не писать.
  В `main` напрямую не пушить.
