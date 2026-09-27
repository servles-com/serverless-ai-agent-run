# 2026-09-28 — спайк браузерного образа комнаты (issue #89, N6 `capabilities: ["browser"]`)

Поток H из #104, шаг 7 роадмапа. Вопрос: сколько стоит headless-браузер в комнате
(размер, старт, RAM) и как его упаковать, чтобы лёгкий ран остался лёгким.

Артефакты: [`room-image/Dockerfile.browser`](../room-image/Dockerfile.browser),
проба [`scripts/browser-room-probe.mjs`](../scripts/browser-room-probe.mjs)
(запускается внутри комнаты, печатает JSON с таймингами и памятью cgroup).

## Что собрано

`FROM sar-room-opencode` + `playwright@1.63.0` глобально +
`playwright install --with-deps --only-shell chromium` (chrome-headless-shell, без
полного headed Chromium). Браузеры в `/opt/ms-playwright`, `/node_modules` с
симлинками на `playwright`/`playwright-core`. Пользователь не задаётся — как и у
базового образа, uid даёт `docker run --user` из `rooms.ts`.

## Условия замера

- Локально: Docker 29.2.1 на **arm64** (Mac), VM Docker'а — 2 CPU / 2 ГБ.
  Лаба (`sar-lab-1`) — amd64: размеры там будут близкими, время — своё.
- Флаги ровно как в `src/rooms.ts`, кроме рантайма: `--user 1000:1000 --cap-drop ALL
  --security-opt no-new-privileges --memory 1024m --memory-swap 1024m --cpus 1
  --pids-limit 512 --tmpfs /tmp:rw,size=512m --network sar-rooms`.
- **runc, не gVisor** — `runsc` локально нет. Сетевая политика `sar-rooms`
  (`room-network-policy.sh`) локально не применена.
- Память — `memory.current` / `memory.peak` cgroup комнаты (включает node-процесс
  пробы и всё дерево Chromium). 3 прогона на страницу.

## Цифры

### Размер

| образ | `docker images` | слой браузера (uncompressed) | `docker save \| gzip` |
|---|---|---|---|
| `sar-room-opencode` (база) | 824 MB | — | 186 MB |
| `sar-room-browser` (Playwright headless shell) | 1.67 GB | **+608 MB** | 415 MB (**+229 MB**) |
| вариант: Debian `chromium` из apt (для сравнения) | — | +707 MB | 437 MB |

Из 608 MB: `/opt/ms-playwright` 269 MB (headless shell 266 MB + ffmpeg 3 MB, который Playwright
ставит даже с `--only-shell`), npm-пакет 19 MB, остальное — системные библиотеки и
шрифты из `--with-deps`. Сборка слоя поверх готовой базы — 76 с.

Apt-вариант больше, и версия Chromium (154) не привязана к Playwright — дрейф
протокола при обновлениях. Отброшен.

### Старт

| что | время |
|---|---|
| `docker run … true`, база | 350–620 ms |
| `docker run … true`, браузерный образ | 255–300 ms (разницы нет — слой не влияет на старт контейнера) |
| `chromium.launch()` (тёплый кэш страниц) | 250–640 ms, типично ~350 ms |
| launch + `goto` + скриншот, `data:` страница | 0.5–0.9 s |
| то же, example.com | 0.7–0.9 s |
| то же, en.wikipedia.org/wiki/Web_browser | 2.1–3.6 s |
| то же, github.com (страница репо) | 3.9–4.6 s |
| полный `docker run` пробы (старт комнаты + node + всё выше) | 1.8–2.4 s (`data:`), 5–6 s (github) |

### Память (пик cgroup, одна вкладка 1280×800)

| страница | пик |
|---|---|
| `data:` HTML | 165 MB |
| example.com | 170 MB |
| Википедия | 220–230 MB |
| github.com | 330–350 MB |

- `--memory 384m` — github проходит (пик 317 MB). `--memory 256m` — **OOM kill
  (exit 137), без единой строки вывода**: классификатор увидит `OOM_KILLED`, это
  правильно, но для агента это будет выглядеть как «браузер молча умер».
- Процессы: 10 процессов / 71 поток на одну открытую страницу. `--pids-limit 512`
  считает потоки → запас на ~5–6 вкладок.
- 3 комнаты параллельно (Википедия, 2 CPU на хосте): 4.2–4.7 s каждая, пик
  260–295 MB, общий wall 8 s. CPU — узкое место раньше памяти.
- `/dev/shm` в комнате — 64 MB по умолчанию; на проверенных страницах не мешал.

Сюда **не входит** сам агент (opencode + модель по API): его память надо
складывать отдельно.

### Изоляция (что проверено под runc)

- Работает под non-root (uid 1000), `--cap-drop ALL`, `no-new-privileges`:
  launch, навигация, скриншот, запись в `/artifacts` (файл принадлежит 1000:1000).
- Собственная песочница Chromium (`chromiumSandbox: true`) **не поднимается**:
  «Chromium sandboxing failed!» — нужны user namespaces или setuid-хелпер, их нет и
  не должно быть. Playwright по умолчанию запускает с `--no-sandbox`; граница
  изоляции — комната (gVisor), а не Chromium. Это ожидаемо, но должно быть явно
  записано в security-checklist при подключении.
- `playwright screenshot https://… /artifacts/x.png` (CLI) работает из `/tmp` —
  агенту не обязательно писать скрипт.

**Остаётся водителю (на VM с `SAR_ROOM_RUNTIME=runsc`):**

1. Запуск Chromium под gVisor: известны проблемы с `/proc/self/exe`, seccomp-BPF
   внутри Chromium и `/dev/shm` под runsc — проверить, что probe проходит, и
   сравнить время/память с цифрами выше (gVisor обычно медленнее на
   процесс-тяжёлых нагрузках).
2. Пробы сети из **браузера**, не только из curl: `page.goto` на metadata
   (169.254.169.254), адрес хоста, LAN — должны падать; парная проба
   «публичный сайт открывается» — должна проходить.
3. Прокси: Chromium на Linux берёт `HTTP(S)_PROXY` из env, но не всегда
   `NO_PROXY`-правила так же, как curl — проверить при подключении egress-прокси K4.

## Рекомендация

1. **Отдельный образ-слой**, `sar-room-browser` = `FROM sar-room-opencode` + Playwright.
   Не класть браузер в базовый образ: +608 MB на диске и +229 MB в gzip для каждого
   рана, которому браузер не нужен. Слой не замедляет старт контейнера и шарит все
   нижние слои с базой, так что на диске машины реальная цена — только +608 MB.
   `capabilities: ["browser"]` → `config.roomImage` подменяется на браузерный образ
   (правка `rooms.ts`/`runner.ts` — водителю).
2. **Playwright headless shell, версия прибита** (`PLAYWRIGHT_VERSION`), а не apt
   Chromium: меньше, и npm-клиент гарантированно совпадает с браузером.
3. **Бюджет старта** для браузерного рана: +1 s к старту комнаты на запуск браузера
   и первую простую страницу; 5 s на тяжёлую страницу (под runc; под gVisor —
   перемерить). В idle-таймауте это не критично (дефолт 240 s).
4. **Лимиты для capability `browser`:** `memory_mb` ≥ 1024 по умолчанию (браузер
   до ~350 MB на страницу + агент), никогда < 512; `pids` 512 хватает; `cpus` 1.
5. **Минимальная машина:** под 1 браузерную комнату одновременно — 2 vCPU / 2 GB
   (то, на чём мерил); под `SAR_MAX_ROOMS=2` с браузером — 2 vCPU / 4 GB; диск +1 GB
   на образ. CPU кончается раньше памяти: на 2 vCPU три браузера параллельно уже
   удваивают время каждой.
6. Для `expect`: браузерный ран естественно сдаёт скриншоты/HTML в `/artifacts`,
   `expect.artifacts: ["*.png"]` работает без изменений.

## Открытые вопросы

- Цифры под gVisor и на amd64 (см. «Остаётся водителю»).
- Сборка браузерного образа в `vm-bootstrap.sh` — только при включённой
  capability, чтобы машина без браузерных ранов его не тянула.
- ffmpeg (3 MB) приходит вместе с `--only-shell`; не мешает, выкидывать
  не стали, чтобы не ломать `playwright install`.
