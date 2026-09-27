# Шлюз хоста и ссылки на креды: дизайн ядра

Дата: 2026-09-28. Статус: решение для ядра (#92 K9, #46 K2); подключение к рану и
правило сетевой политики — шаг 4 водителя, отдельным PR. Поверх
[credential-passing-architecture-zerocreds-and-runs.md](credential-passing-architecture-zerocreds-and-runs.md).

## Зачем один шлюз

Комнате нужно ходить на хост в трёх случаях: прокси кредов (K4 #48, K9 #92),
обратные вызовы trained-assist (T1 #99) и LLM-прокси (SB7). Сейчас комната хост
не видит вообще: `INPUT -i sar0 → REJECT`. Каждая дыра в этом правиле — правка
`room-network-policy.sh` и ревью владельца. Поэтому дыра одна:

```text
комната ──http://<адрес sar0>:<SAR_GATEWAY_PORT>/<service>/…──► шлюз (процесс sar на хосте)
          Authorization: Bearer <токен рана>                          │
                                                                     ├─ /proxy/<host>/… → https://<host>/… + заголовок креда
                                                                     ├─ /llm/…          → SB7 (позже)
                                                                     └─ /ta/…           → T1 (позже)
```

- **Один слушатель** на адресе моста `sar0`, один порт. Правило NP (шаг 4):
  `INPUT -i sar0 -p tcp --dport $SAR_GATEWAY_PORT -j ACCEPT` перед общим REJECT.
  Всё остальное на хосте для комнаты по-прежнему закрыто.
- **Токен рана** — 32 случайных байта, выдаётся при PREPARING, отзывается при
  EXPORTING. Хранится только в памяти процесса (по sha256), в `run.json` не пишется.
  В комнату попадает как `SAR_RUN_TOKEN`, адрес — как `SAR_GATEWAY_URL`.
  Шлюз принимает токен из `Authorization: Bearer`, из пароля `Authorization: Basic`
  (git по HTTPS) или из `X-SAR-Run-Token`. Без валидного токена — 401 и никакой
  информации о маршрутах.
- **Маршрут = первый сегмент пути** (`/<service>/…`). Ядро шлюза делает только
  аутентификацию, разбор маршрута и логирование; сервисы регистрируются как
  обработчики `(req, res, ctx: {runId, owner, rest})`. Новый сервис — новый модуль,
  без правок NP и `rooms.ts`. Неизвестный сервис — 404.

## Сервис `proxy` (K9, база для K4)

`GET http://<gw>/proxy/api.cloudflare.com/client/v4/zones` →
`GET https://api.cloudflare.com/client/v4/zones` с заголовком креда.

1. Хост из пути должен быть в `hosts` одного из грантов рана с `as: "proxy"`,
   иначе 403 `host_not_granted`. Один хост — ровно один грант (проверяется при
   валидации запроса).
2. Кред резолвится **на каждый запрос** (не кэшируется): отзыв действует сразу,
   каждая выдача пишется в аудит.
3. Заголовки комнаты `Authorization`, `X-SAR-Run-Token`, `Host`, hop-by-hop
   выбрасываются; подставляется заголовок креда (по умолчанию
   `Authorization: Bearer <value>`, формат задаёт владелец в самом креде).
4. **Защита от SSRF.** Шлюз работает в сети хоста, а не комнаты, поэтому сам
   проверяет адрес: имя резолвится, соединение идёт на проверенный адрес,
   loopback / RFC1918 / link-local (metadata) / CGNAT / ULA — отказ (502
   `upstream_blocked`). IP-литералы и `localhost` отклоняются ещё при валидации.
5. Редиректы не следуют (иначе заголовок уедет на другой хост) — 3xx отдаётся как есть.
6. **Значения нет в ответах и логах**: у апстрима просим `Accept-Encoding: identity`,
   тело и заголовки ответа проходят потоковую замену значения на `***` (апстрим,
   который эхом возвращает заголовок, его не раскроет). Строки лога шлюза — через
   `redact()`, значение регистрируется в редакторе при каждом резолве.

Для утилит с base URL: `name` в гранте proxy — имя переменной, в которую
кладётся **токен рана** (не значение). Утилита шлёт `Authorization: Bearer $X` —
это и есть аутентификация на шлюзе. Пример: `CLOUDFLARE_API_TOKEN=<токен рана>`,
`CLOUDFLARE_API_BASE_URL=$SAR_GATEWAY_URL/proxy/api.cloudflare.com/client/v4`.

## Креды: хендлы, бэкенд, аудит

- Хендл `cred:<owner>/<name>` или `cred:<name>` (пространство вызывающего).
  `owner` и `name`: `[a-z0-9][a-z0-9._-]{0,63}`, без `..`.
- **Резолв только в пространстве владельца рана.** Хендл с чужим owner даже не
  доходит до диска и возвращает тот же `CREDENTIAL_MISSING`, что и
  несуществующий, — существование чужого креда не раскрывается.
- Файловый бэкенд (K2, `file`): `$SAR_CREDS_DIR/users/<owner>/<name>.json` =
  `{"value": "...", "header"?: "authorization", "scheme"?: "Bearer", "revoked"?: true}`.
  Путь после `realpath` обязан остаться внутри `users/<owner>/` (симлинки наружу —
  «не найден»). `revoked: true` → `CREDENTIAL_REVOKED`. Бэкенд за интерфейсом
  `CredentialBackend.read(owner, name)`, следующий — `openbao` (K1/K2).
- Аудит: `$SAR_DATA_DIR/credential-access.jsonl`, строка на каждую попытку выдачи:
  `{ts, run_id, owner, ref, as, host?, outcome: granted|missing|revoked, reason?}`.
  Значения там нет никогда. Это источник для `GET /me/credential-access` (K6).
- Классификатор: `CREDENTIAL_MISSING`, `CREDENTIAL_REVOKED` — и при резолве в
  PREPARING (режим `env`, `credentialVerdict()`), и по ошибкам шлюза во время рана
  (`Facts.credentialErrors`, если ран не закончился чисто).

## Запрос рана

```json
"credentials": [
  {"ref": "cred:cloudflare", "as": "proxy", "hosts": ["api.cloudflare.com"], "name": "CLOUDFLARE_API_TOKEN"},
  {"ref": "cred:vova/npm", "as": "env", "name": "NPM_TOKEN"}
]
```

`validateCredentials()` — чистая функция, 400 до старта комнаты: не больше 16
грантов; `as` пока `env | proxy` (`ssh`, `browser-fill` — «ещё не поддерживается»);
`proxy` требует `hosts` (≤ 8, имя хоста с точкой, без схемы, порта, пути, IP и
масок; один хост — один грант); `env` требует `name` (`[A-Z_][A-Z0-9_]*`, не
`PATH`/`HOME`/`SAR_*`/ключи провайдера), `hosts` для `env` запрещены; имена
переменных не повторяются. Режим `env` помечается в результате рана (значение у
процесса комнаты, уровень L2).

## Что делает водитель в шаге 4

1. `config.gateway.*` → поднять `startGateway()` в `server.ts` на адресе `sar0`.
2. `runner.ts`/`run-env.ts`: `validateCredentials` в `POST /runs`; в PREPARING —
   `RunTokens.issue()`, env-гранты через `broker.resolveEnv()` (ошибка →
   `credentialVerdict()`), в env комнаты `SAR_RUN_TOKEN`, `SAR_GATEWAY_URL`, `name`
   proxy-грантов; в EXPORTING — `RunTokens.revoke()`, `gateway.errorsFor(runId)`
   → `Facts.credentialErrors`.
3. NP: одно правило ACCEPT на порт шлюза; парные пробы в `isolation.test.ts`:
   «шлюз без токена → 401» / «с токеном → 200», «в режиме proxy значения нет в
   env и `/proc` комнаты», «прочие порты хоста закрыты».

## Чего сознательно нет

- Прозрачного HTTPS-MITM (L0b) — только base-URL. Хосты, которые утилита не даёт
  переопределить, ждут L0b (#89 и позже).
- Кэша значений, OpenBao-бэкенда, `GET /me/*` — следующие шаги (K1, K6).
- Многопользовательской аутентификации API: owner пока один — `SAR_OWNER`
  (по умолчанию `operator`); ядро уже принимает owner параметром.
