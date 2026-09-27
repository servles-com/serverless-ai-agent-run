# serverless-ai-agent-run

Запускает AI-агента (сейчас OpenCode; потом Claude Code, Codex, свои агенты) как
**фоновую задачу за HTTP API — по ощущениям как Cloudflare Worker**. Отправляешь
`POST /runs` с задачей и входными файлами/репо, сразу получаешь `run_id`, прогресс
приходит на твой вебхук, результат и файлы забираешь по API. Каждый запуск идёт в
свежем изолированном контейнере (**Operating Room**, «операционная»), который
уничтожается после работы. Любое падение заканчивается машиночитаемым диагнозом:
*почему* упало, с доказательствами и подсказкой.

«Serverless» — только для вызывающего. Внутри это одна VM с Docker + gVisor.

> **North Star:** [docs/north-star-user-scenario.md](docs/north-star-user-scenario.md) · путь: [docs/north-star-roadmap.md](docs/north-star-roadmap.md) — агенты пачками по API на своей машине,
> каждый в своей изоляции; GitHub как полноценный житель; креды без LLM; результат всегда PR, файл или явная ошибка.
>
> **Хостинг: одна голая машина с SSH, никаких облачных сервисов.** Сейчас это временная
> VM `sar-lab-1` (GCP используется только как «железо»; переезд — `SAR_SSH=... scripts/machine.sh bootstrap`).
>
> **Статус: V0, работает.** Lab VM, selftest зелёный, dogfood
> гоняет задачи на бесплатных моделях. Один оператор (один API-токен).
> Трекинг: [docs/requirements-log.md](docs/requirements-log.md) ·
> безопасность: [docs/security-checklist.md](docs/security-checklist.md) ·
> креды: [docs/credentials-and-secret-storage-design.md](docs/credentials-and-secret-storage-design.md) ·
> CI/CD и логи: [docs/ci-cd-and-logging-development-plan.md](docs/ci-cd-and-logging-development-plan.md) ·
> планы: [docs/ROADMAP.md](docs/ROADMAP.md) ·
> потребности пользователя: [docs/user-needs-discovery.md](docs/user-needs-discovery.md)

---

## Главная идея

**Среда хороша ровно настолько, насколько хорошо она ловит и объясняет свои падения.**
Бесплатные модели падают постоянно: rate limit, 504 от провайдера, зависания,
циклы, «готово!» без результата. V0 построен не чтобы это скрыть, а чтобы каждое
такое падение попало в понятную категорию — и чтобы новые, ещё непонятые падения
всплывали сами.

---

## Как проходит один запуск

```text
POST /runs ──► валидация ──► QUEUED ──► очередь (SAR_MAX_ROOMS, сейчас 1)
                                            │
                                   PREPARING│ hydrate: клон репо (токен в заголовке, не в URL),
                                            │ входные файлы → runs/<id>/workspace
                                            ▼
                                    RUNNING │ docker run --runtime runsc (gVisor)
                                            │   non-root, cap-drop ALL, лимиты mem/cpu/pids,
                                            │   /workspace и /artifacts смонтированы,
                                            │   своя сеть: интернет да, хост/metadata/LAN нет
                                            │ stdout агента (JSON-события opencode) → events.jsonl
                                            │ сторожа: общий таймаут, idle-таймаут (молчит N сек)
                                            ▼
                                  EXPORTING │ индекс /artifacts
                                            │ docker inspect (exit code, OOMKilled) → room/inspect.json
                                            │ docker rm -f  (комната уничтожена)
                                            ▼
                         классификатор ──► SUCCEEDED | FAILED | TIMED_OUT | CANCELLED
                                            + diagnosis {category, summary, evidence, hints}
                                            ▼
                                  run.completed → вебхук, журнал, /runs/<id>
```

Каждое событие по пути (`run.state`, `agent.tool`, `agent.text`, `room.stderr`, …)
пишется в `events.jsonl` и, если задан вебхук, отправляется на него — по порядку,
с HMAC-подписью. Агентные события (каждый tool call) шлются только с
`agent_events: true`, чтобы не заваливать вебхук.

### Что лежит на диске по каждому запуску

```text
/var/lib/sar/runs/<run_id>/
  run.json            состояние, запрос, результат, диагноз
  diagnosis.json      только при неуспехе
  events.jsonl        всё, что происходило, построчно
  workspace/          /workspace комнаты (входные файлы, клон репо, что наделал агент)
  artifacts/          /artifacts комнаты — результат
  room/stdout.log     сырой вывод агента
  room/stderr.log     сырые логи агента (там видно ошибки провайдера)
  room/docker-args.json  точная команда docker run
  room/inspect.json   docker inspect после завершения (exit code, OOM)
```

Хранится 72 часа (`SAR_RETENTION_HOURS`), потом удаляется. Всё — обычные файлы:
разбирать падение можно `cat`/`jq` или отдать папку другому агенту.

### Классификация падений

[src/failures.ts](src/failures.ts) — чистая функция от собранных фактов (exit code,
OOM, таймауты, счётчики шагов/tool calls, хвост stderr, ошибки агента).

| category | что значит | чья вина |
|---|---|---|
| `ROOM_START_FAILED` | docker/gVisor не смог запустить комнату | среда |
| `HYDRATE_FAILED` | не склонировался репо / не записались файлы | вход/среда |
| `MODEL_RATE_LIMITED` `MODEL_NOT_FOUND` `MODEL_AUTH_FAILED` `MODEL_CONTEXT_OVERFLOW` `MODEL_PROVIDER_ERROR` | ошибка провайдера модели | провайдер |
| `TIMEOUT` | превышен `timeout_s` при реальной работе агента | агент/задача |
| `IDLE_STALL` | агент молчит `idle_timeout_s` — завис вызов модели или интерактивная команда | агент |
| `OOM_KILLED` | упёрся в `memory_mb` | агент/лимиты |
| `AGENT_CRASHED` / `AGENT_BINARY_MISSING` | процесс агента упал / его нет в образе | агент/образ |
| `AGENT_NO_OUTPUT` / `AGENT_EMPTY_RESULT` | вышел с 0, но ничего не сделал | агент/модель |
| `ORPHANED_BY_RESTART` | сервис перезапустился посреди рана | среда |
| `RUNTIME_BUG` | исключение в нашем коде | среда |
| `EXPECTATION_NOT_MET` | ран «успешен», но не сдал то, что обещано в `expect` (нет файла, пустой, битый JSON, нет PR, текст не тот) | агент/модель |
| `NO_DELIVERABLE` | без `expect`: ни финального текста, ни непустого артефакта, ни PR | агент/модель |
| `SILENT_FAILURE` (только dogfood) | «SUCCEEDED», но ни одного артефакта | самое опасное |

Пример, как это уже сработало: в первом dogfood 3 рана упали как `TIMEOUT`. В
`stderr.log` было видно, что OpenRouter каждые ~2 минуты отдавал `504 stream error`,
opencode ретраил — и тишины никогда не было достаточно для `IDLE_STALL`. Классификатор
дописан: таймаут без единого tool call + ошибки провайдера в логах → `MODEL_PROVIDER_ERROR`.

---

## Откуда сейчас берутся задачи

Внешних пользователей пока нет. Задачи идут из трёх источников:

1. **Selftest** (`scripts/selftest.sh`) — детерминированные сценарии через агент
   `shell` (задача = shell-скрипт). Каждый вызывает ровно одну поломку: краш,
   таймаут, зависание, OOM, fork-бомба, отсутствующий бинарник, отмена, вебхук,
   плюс 11 проб изоляции изнутри комнаты. Это «должно работать всегда»; запускается
   руками после каждого деплоя (`SAR_LIVE=1` — ещё один живой прогон opencode).
2. **Dogfood** (`scripts/dogfood-free-models.ts`, systemd-таймер) — реальные задачи
   для opencode из [tests/dogfood/tasks.json](tests/dogfood/tasks.json) на бесплатных
   моделях OpenRouter. Сейчас 10 задач: записать файл, написать и запустить скрипт,
   починить баг, склонировать репо и описать, JSON-трансформация, отчёт об окружении,
   и 4 «ловушки»: интерактивный `npm init`, огромный вывод в shell, расплывчатая
   задача «Make it better.» (провокация на `SILENT_FAILURE`), сетевой запрос.
   - Обычный режим: раз в 3 часа все задачи × 2 модели (≈40 мин).
   - **Burst-режим** (включён 2026-09-27 19:20 UTC до 23:20 UTC): раз в 5 минут 2
     случайные пары (модель, задача), таймаут 240 с. Включается/выключается
     `scripts/dogfood-burst.sh 5min 4h 2` / `… off`, выключается сам.
3. **Ручные запуски** через API (curl через SSH-туннель).

Чтобы добавить новую задачу для dogfood — дописать объект в `tests/dogfood/tasks.json`
(`name`, `task`, опционально `files`, `repo`). Хорошие задачи — те, на которых
агент *интересно* падает.

---

## Как система развивается сама

```text
 ┌────────────── dogfood (таймер) ──────────────┐
 │  задачи × бесплатные модели → POST /runs      │
 └──────────────────────┬────────────────────────┘
                        ▼
      runs/<id>/*  +  reports/history.jsonl (строка на ран: модель, задача, категория)
                        ▼
      dogfood-file-issues.ts (после каждого тика)
        категории «виновата среда»: SILENT_FAILURE, RUNTIME_BUG, AGENT_NO_OUTPUT,
        ROOM_START_FAILED, HYDRATE_FAILED, HARNESS_ERROR
        → одна GitHub issue на категорию (метка `dogfood`), с /debug-бандлом рана;
          если открытая issue по категории уже есть — не дублирует
                        ▼
      [сейчас: человек / Claude-сессия]  разбирает issue → фикс + тест → PR
                        ▼
      CI (typecheck + unit) зелёный → merge → scripts/gcp-lab-vm.sh bootstrap
                        ▼
      selftest на VM → следующий тик dogfood проверяет, что падение ушло
```

**Что уже автоматически:** генерация нагрузки, сбор истории, классификация,
заведение issue, CI на PR.

**Что пока руками:** починка по issue, деплой на VM после merge, запуск selftest
после деплоя.

**Следующие шаги, чтобы замкнуть петлю полностью** (в порядке ценности):

1. **Самопочинка.** Issue с меткой `dogfood` подхватывает отдельная opencode-сессия
   через Session Manager (`POST localhost:3000/api/sessions/start`, агент `opencode`):
   читает /debug-бандл, добавляет категорию/тест в `failures.ts`, делает PR. Человек
   только мёржит.
2. **Автодеплой после merge.** GitHub Actions → self-hosted runner на VM → `bootstrap`
   + `selftest.sh`; красный selftest → issue и откат.
3. **Fail-fast на повторяющихся ошибках провайдера** — не жечь 10 минут таймаута.
4. **LLM-прокси на хосте** — ключ провайдера уходит из комнаты; классификация
   `MODEL_*` по реальным HTTP-статусам, а не по регуляркам в логах; учёт токенов.
5. **Квота диска для /workspace** (сейчас агент может забить диск VM — см. чеклист).
6. Продолжение сессии (`POST /runs/{id}/messages`), адаптеры Claude Code и Codex.
7. Хранилище ранов на диске машины + sqlite-индекс (облаков нет); мультитенантность — только когда появится второй реальный
   пользователь.

Решения, от которых сознательно отказались в V0, и почему —
[docs/2026-09-27 draft review and V0 launch plan.md](docs/2026-09-27%20draft%20review%20and%20V0%20launch%20plan.md).

---

## API

Все эндпоинты кроме `/healthz` — с `Authorization: Bearer $SAR_API_TOKEN`.

```http
POST /runs                        → 202 {id, state, links}
GET  /runs                        последние раны
GET  /runs/{id}                   состояние, результат, диагноз
GET  /runs/{id}/events            JSON; ?after=<seq>; SSE при ?follow=1
GET  /runs/{id}/debug             всё для разбора падения одним ответом
GET  /runs/{id}/artifacts         список
GET  /runs/{id}/artifacts/{path}  скачать
POST /runs/{id}/cancel
GET  /healthz                     docker, runtime, образ, очередь
```

```json
{
  "agent": "opencode",
  "task": "Fix the failing test in calc.py and put the fixed file in /artifacts",
  "model": "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "files": { "calc.py": "..." },
  "repo": { "url": "https://github.com/org/repo", "ref": "main" },
  "secrets": ["GITHUB_TOKEN"],
  "webhook": { "url": "https://you.example/hook", "secret": "hmac-key", "agent_events": false },
  "expect": { "artifacts": ["calc.py"], "text": "ok" },
  "limits": { "timeout_s": 900, "idle_timeout_s": 240, "memory_mb": 1024, "cpus": 1, "pids": 512 }
}
```

Обязателен только `task`. `expect` — контракт результата: `artifacts` (пути/глобы в
`/artifacts`, файл должен быть непустым), `json` (артефакты, которые должны парситься),
`text` (`true` или регэксп для финального ответа), `non_empty`, `github_pr`. Не выполнен →
`FAILED` / `EXPECTATION_NOT_MET` со списком невыполненного, а не тихий `SUCCEEDED`. `secrets` — имена из серверного `/etc/sar/secrets.env`;
в комнату попадают только запрошенные. Вебхук: заголовок
`X-SAR-Signature: sha256=HMAC(secret, body)`, последнее событие — `run.completed`.

---

## Эксплуатация

```bash
# Любая машина по SSH:
SAR_SSH=root@host bash scripts/machine.sh bootstrap | ssh <cmd> | tunnel | status | selftest
# Временная GCP VM (SAR_SSH не задан → gcp-lab-vm.sh): create | bootstrap | ssh | tunnel | delete
bash scripts/gcp-lab-vm.sh bootstrap          # залить текущий HEAD и (пере)развернуть
bash scripts/gcp-lab-vm.sh tunnel             # API на localhost:8787
bash scripts/gcp-lab-vm.sh ssh 'sudo -u sar bash /opt/sar/scripts/selftest.sh'
bash scripts/gcp-lab-vm.sh ssh 'sudo -u sar bash /opt/sar/scripts/dogfood-status.sh 4'
bash scripts/gcp-lab-vm.sh ssh 'journalctl -u sar -f'     # строка на старт/финиш каждого рана
bash scripts/gcp-lab-vm.sh ssh 'sudo bash /opt/sar/scripts/dogfood-burst.sh 5min 4h 2'
```

Где что на VM:

| что | где |
|---|---|
| код | `/opt/sar` |
| конфиг, API-токен | `/etc/sar/sar.env` |
| секреты для ранов (OpenRouter, GitHub) | `/etc/sar/secrets.env` |
| токен для заведения dogfood-issue (ранам недоступен) | `/etc/sar/dogfood.env` |
| раны | `/var/lib/sar/runs/` |
| история и отчёты dogfood | `/var/lib/sar/reports/` |
| сервисы | `sar`, `sar-netpolicy`, `sar-dogfood.timer` |

Новая VM с нуля: Ubuntu 24.04 →
`sudo SAR_LOCAL_SRC=<checkout> bash scripts/vm-bootstrap.sh` (ставит docker, gVisor,
node 24, собирает образ комнаты, systemd), затем ключ OpenRouter в `secrets.env`.

### Локальная разработка

```bash
npm install --include=dev
npm run typecheck && npm run test:unit
docker build -t sar-room-opencode room-image && docker network create sar-rooms
SAR_INSECURE_DEV=1 OPENROUTER_API_KEY=... npm start       # локально runc вместо gVisor
npm run test:e2e
```

---

## Структура

```text
src/server.ts        HTTP API
src/runner.ts        очередь, жизненный цикл, восстановление после рестарта, GC
src/rooms.ts         контейнер: gVisor, лимиты, таймауты, уничтожение
src/failures.ts      классификатор падений
src/webhooks.ts      подписанные вебхуки по порядку, с ретраями
src/adapters/        opencode (поток JSON-событий), shell (для тестов)
src/store.ts         раны на диске
room-image/          образ комнаты (node + opencode + git + python)
scripts/             bootstrap, сетевая политика, selftest, dogfood, burst, status, machine (SSH), gcp-lab-vm
deploy/              systemd-юниты, пример secrets
tests/unit           классификатор (18)
tests/e2e            сценарии падений (13), изоляция (11 проб), живой opencode
tests/dogfood        задачи для dogfood
docs/                архитектура, безопасность, roadmap, лог требований, ревью, находки
```

---

## Claude Code Instructions

- **Модели для агентов — только через LLM ladder владельца** (`ladder/free`, воркер
  [trained-assist-llm-ladder](https://github.com/trained-assist/trained-assist-llm-ladder):
  OpenCode Go → Zen / OpenRouter `:free` → дешёвые платные, с ротацией ключей и здоровьем
  моделей). Токен `LLM_LADDER_TOKEN` лежит в GCP Secret Manager проекта
  `alesa-personal-assistent` и в `/etc/sar/secrets.env` на машине. Не подключать OpenRouter
  напрямую как дефолт: квота одного аккаунта кончается за несколько ранов. Это решение
  настраивали несколько раз — не терять.

- V0 держим минимальным. Требования — из задачи (API + вебхук, изолированные комнаты,
  диагностика падений), а не из раннего мультитенантного драфта. Тенанты, storage
  gateway, KMS и прочий access-control — **потом**, см. ROADMAP.
- Node ≥ 23.6 исполняет `.ts` напрямую — без сборки. Только erasable TypeScript
  (без enum, без parameter properties). Без runtime-зависимостей.
- Каждое новое наблюдённое падение → категория в `src/failures.ts` + unit-тест в
  `tests/unit/failures.test.ts`; если воспроизводится shell-агентом — e2e-кейс в
  `tests/e2e/failure-modes.test.ts`.
- Каждая проба «X недоступен» должна иметь парную «Y доступен» — иначе мёртвая сеть
  делает все проверки изоляции зелёными.
- Изменения изоляции комнаты — только с зелёным `tests/e2e/isolation.test.ts` на VM
  с `SAR_ROOM_RUNTIME=runsc`.
- Разбор рана: `GET /runs/{id}/debug` или на VM `/var/lib/sar/runs/<id>/`.
- Требования и статус — в GitHub issues (open/closed + комментарий с причиной). `docs/requirements-log.md` — архив, строки не добавлять. `docs/security-checklist.md` держать актуальным.
- Флоу: feature-ветка → PR → CI зелёный → merge → `machine.sh bootstrap` → selftest.
- Никаких облачных сервисов (GCS, Secret Manager, managed DB/queues): только машина, файлы, sqlite, systemd, docker+gVisor.
- План CI/CD и логов: `docs/ci-cd-and-logging-development-plan.md`. Репо публичный; `main` защищён: только PR + зелёный `check`, в том числе для админов. Секреты, токены, IP машины и личные данные в репо и issues не писать.
  В `main` напрямую не пушить.
