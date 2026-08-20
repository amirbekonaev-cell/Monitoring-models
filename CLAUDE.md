Критерии приёмки проверены вручную на работающем стенде — не «должно работать по коду», а реально прокликано/проверено на поднятом окружении.
Код в общем репозитории, ветка влита в main — фича-ветка на каждую историю, финальный merge в основную ветку.
Код прошёл ревью — в нашем случае самопроверка с явным протоколом изменений (что менялось, зачем, какие файлы) вместо ревью коллегой.
Нет заглушек, debug-вывода, паролей/ключей в коде — никаких TODO-заглушек, console.log/debug-логов, хардкод-секретов; секреты только через .env (в .gitignore).
Написаны и проходят автотесты на главную логику истории — не на всё подряд, а на ключевую бизнес-логику каждой конкретной US.
Проверены неудачные сценарии — пустой результат, недоступный источник (сеть/API упал), некорректный ввод пользователя.
Функциональность развёрнута на стенде и доступна по ссылке — у нас это docker compose up локально, доступно на localhost.
Обновлена инструкция — как запустить и как настроить (README/one-pager, растёт по мере добавления фич).
Регрессия — предыдущие уже сделанные истории продолжают работать после новых изменений.
# Project Overview
Brief 1-2 sentence description of the project, core domain, and goals.

## Tech Stack
- **Backend / Runtime:** [e.g., Python 3.11 / Node.js 20 / Java 17]
- **Frameworks:** [e.g., FastAPI / React / Spring Boot]
- **Database / Storage:** [e.g., PostgreSQL, Redis]
- **Key Libraries / APIs:** [e.g., Pydantic, SQLAlchemy, Axios]

---

## Build & Development Commands
- **Install dependencies:** `npm install` or `poetry install`
- **Run dev server:** `npm run dev` or `uvicorn app.main:app --reload`
- **Run all tests:** `pytest` or `npm test`
- **Run single test:** `pytest tests/test_auth.py`
- **Lint / Format:** `flake8 . && black .` or `npm run lint`
- **Build / Bundle:** `npm run build`

---

## Architecture & Code Structure
- `/src/api` — Route controllers and endpoint handlers.
- `/src/services` — Core business logic (keep handlers thin).
- `/src/models` — Schemas, ORM mappings, and domain types.
- `/tests` — Unit and integration tests mirroring `/src`.

---

## Code Style & Best Practices
- **Typing:** Strict typing required (use TypeScript types or Python type hints everywhere).
- **Naming:** `camelCase` for JS variables/functions, `snake_case` for Python, `PascalCase` for classes/components.
- **Error Handling:** Use custom domain exceptions; never fail silently or use bare `except:`.
- **Imports:** Group imports: standard library first, third-party packages second, local modules last.

---

## Workflow & Constraints
- Always run tests and linting before declaring a task finished.
- Do not modify configuration files (`.env`, `docker-compose.yml`) without explicit request.
- Keep dependencies minimal; do not install new packages without asking.
- Write unit tests for every newly added business logic function.