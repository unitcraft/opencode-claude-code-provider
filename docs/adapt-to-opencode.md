# Промпт: подстроить провайдер claude-code под новый OpenCode

Вставь этот текст целиком в окно агента (Claude Code или OpenCode), открытое в
`D:/Sources/opencode-plugins`. Агенту нужны: этот репозиторий, `npm`, `opencode`, `git`.

---

Задача: провайдер `claude-code` (репозиторий `D:/Sources/opencode-plugins/opencode-claude-code-provider`)
сообщил, что установленная версия OpenCode больше не совпадает с его правилами. Восстанови совпадение.
Отвечай владельцу по-русски, сообщения коммитов — по-английски.

Что сломалось и почему это важно. Два правила провайдера опираются на код OpenCode:
1. СЖАТИЕ. Запрос сжатия OpenCode (`/compact` или автосжатие) провайдер узнаёт по тексту OpenCode
   (`COMPACTION_OPENINGS` и заголовок шаблона `## Objective` в `src/lib.js`) и вместо пересказа OpenCode запускает
   настоящий `/compact` Claude Code в сессии окна. Не узнал — пересказ OpenCode снова тратит полный ход Claude
   и удлиняет память Claude Code, а не сжимает её.
2. СЛУЖЕБНЫЕ ЗАПРОСЫ (заголовок и т.п.) провайдер узнаёт по тому, что в них НЕТ инструментов
   (`isHelperRequest` в `src/lib.js`). Если OpenCode начал слать инструменты — запрос заголовка снова станет
   полным ходом Claude и повторит сообщение окна (письмо peer_send уйдёт дважды).

Порядок работы:
1. `cd D:/Sources/opencode-plugins/opencode-claude-code-provider && npm run check-opencode` — какие
   проверки упали (строки `FAIL`). Результат автопроверки: `<XDG_DATA_HOME>/opencode/claude-code-provider-check.json`.
2. Работай в отдельной ветке и дереве: `git -C opencode-claude-code-provider worktree add ../opencode-claude-code-provider-adapt -b adapt main`
   и сделай в нём junction на `node_modules` основного клона. `main` живой — его не трогать до конца проверки.
3. Посмотри, что OpenCode присылает СЕЙЧАС, в песочнице (окна владельца не трогать, фоновый сервис
   OpenCode не перезапускать):
   - отдельные `XDG_DATA_HOME` и `XDG_CONFIG_HOME` в своей временной папке; в конфиг песочницы — копия
     `~/.config/opencode/opencode.jsonc`, где провайдер указывает на дерево `-adapt`, а агенты `title` и `summary` — на `claude-code/haiku`;
   - `CLAUDE_CODE_PROVIDER_PROBE=<файл>` — провайдер запишет каждый запрос (инструменты, роли, текст);
   - заголовок: `opencode run --standalone -m claude-code/haiku "Say ok."` — в файле будет запрос с `helper`;
   - сжатие: `OPENCODE_PASSWORD=<свой временный>`, `opencode serve --hostname 127.0.0.1 --port 4799`, сессия
     из трёх коротких ходов (`opencode run --server http://127.0.0.1:4799 --session <id> ...`), затем
     `opencode api --server http://127.0.0.1:4799 session.compact --param sessionID=<id> --data "{}"`.
4. По файлу пробы найди новый запрос сжатия (последнее сообщение пользователя) и запрос заголовка (поле `tools`).
   Обнови `COMPACTION_OPENINGS` / заголовок шаблона или `isHelperRequest` в `src/lib.js` и соответствующую проверку в
   `src/opencode-check.js`; образцы в `test/opencode-check.test.js` приведи к новому OpenCode.
5. Докажи в обе стороны: `npm test` зелёный; сломай новое условие — тест красный; верни — зелёный.
6. Живая проверка в той же песочнице: сжатие завершилось (`compaction completed`, ответ «Claude Code compacted…»),
   в сессии Claude Code есть команда `/compact` и нет запроса OpenCode «summarize»; следующий ход читает меньше
   токенов, чем до сжатия; после сжатия окно помнит факты из начала; запрос заголовка не повторяет
   сообщение окна (одно письмо на один `peer_send`). `npm run check-opencode` — `ok`.
7. Коммит в ветке (`git commit -s -F <файл> --only -- <файлы>`, новые файлы — по имени, без `git add -A`),
   слияние в `main` fast-forward, `npm test` на `main`, `git push origin main`. Удали
   `claude-code-provider-check.json`, чтобы провайдер проверил версию заново. Убери дерево и ветку.
8. Отчёт владельцу: что изменилось в OpenCode, что поправлено, как доказано, коммит.

Если формулировки OpenCode изменились так, что надёжной метки нет, — не угадывай: опиши владельцу, что
видно в файле пробы, и предложи варианты.
