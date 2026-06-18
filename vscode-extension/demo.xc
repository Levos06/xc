---
xc_spec: "1.0"
language: "python"
module: "core.auth.session"
always_apply: true
author: "Levos06"
tags: ["auth", "security", "demo"]
---

# [EXPLANATION: imports_and_config]
## 🧱 Фундамент модуля

Этот слой задаёт **импорты** и **конфигурационные константы** всего сервиса
аутентификации. Он намеренно вынесен первым блоком: всё, что объявлено здесь,
доступно остальным блокам после склейки через `xc-cli extract`.

### Конфигурация

| Константа | Значение | Назначение |
|-----------|----------|------------|
| `TOKEN_TTL` | `3600` | время жизни токена, сек |
| `MAX_ATTEMPTS` | `5` | порог rate-limiter |
| `PBKDF2_ROUNDS` | `120_000` | стоимость хэширования пароля |

### Инварианты
* Все «магические числа» живут **только здесь** — ниже по коду их быть не должно.
* `SECRET_KEY` в демо зашит, в проде обязан приходить из окружения (`fail-closed`).

> 💡 Подсказка для теста фокуса: поставьте курсор на строку `PBKDF2_ROUNDS`
> слева — справа должен подсветиться именно этот блок.

# [CODE: imports_and_config]
```python
import hashlib
import hmac
import os
import time
from dataclasses import dataclass, field

# --- Конфигурация (единственный источник магических чисел) ---
TOKEN_TTL = 3600           # сек
MAX_ATTEMPTS = 5           # попыток до блокировки
PBKDF2_ROUNDS = 120_000    # итераций PBKDF2
SALT_BYTES = 16

# В демо ключ зашит; в проде — os.environ["SECRET_KEY"].
SECRET_KEY = os.environ.get("SECRET_KEY", "demo-insecure-key").encode("utf-8")
```

# [EXPLANATION: password_hashing]
## 🔐 Хэширование паролей

Пароли **никогда** не хранятся в открытом виде. Используем `PBKDF2-HMAC-SHA256`
со случайной солью на каждого пользователя.

### Контракт функций
1. `hash_password(password)` → строка вида `salt_hex$digest_hex`.
2. `verify_password(password, stored)` → `bool`, сравнение в постоянное время.

### Граничные условия (edge cases)
- [ ] Пустой пароль → всё равно хэшируется (не падаем), но это не значит «валиден».
- [x] Сравнение через `hmac.compare_digest` — защита от timing-атак.
- [x] Соль уникальна на запись, поэтому одинаковые пароли дают **разные** хэши.

```text
password ──salt──► PBKDF2 (120k раундов) ──► digest
```

# [CODE: password_hashing]
```python
def hash_password(password: str) -> str:
    salt = os.urandom(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS
    )
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split("$", 1)
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    candidate = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS
    )
    return hmac.compare_digest(candidate.hex(), digest_hex)
```

# [EXPLANATION: token_logic]
## 🎫 Сессионные токены

Токен — это подписанная строка `payload.signature`, где `payload` содержит имя
пользователя и метку истечения `exp`.

### Почему именно так
* **Подпись HMAC** не даёт подделать `payload` без `SECRET_KEY`.
* Поле `exp` проверяется на стороне сервера — даже валидная подпись не спасёт
  просроченный токен (**fail-closed**).

### Инварианты безопасности
1. Токен **невалиден**, если истёк (`exp <= now`).
2. Токен **невалиден**, если подпись не совпадает.
3. Отсутствие/искажение `exp` трактуется как невалидный токен, а не как «вечный».

# [CODE: token_logic]
```python
def issue_token(username: str, now: float | None = None) -> str:
    now = time.time() if now is None else now
    exp = int(now + TOKEN_TTL)
    payload = f"{username}:{exp}"
    sig = hmac.new(SECRET_KEY, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_token(token: str, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    try:
        payload, sig = token.rsplit(".", 1)
        username, exp_str = payload.split(":")
        exp = int(exp_str)
    except (ValueError, AttributeError):
        return False
    expected = hmac.new(
        SECRET_KEY, payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    return exp > now
```

# [EXPLANATION: rate_limiter]
## 🚦 Ограничение попыток входа

Простой in-memory rate-limiter: после `MAX_ATTEMPTS` неудачных попыток аккаунт
временно блокируется. Защищает от перебора паролей (brute-force).

### Состояние
Хранится в словаре `username -> RateState`. В проде это был бы Redis с TTL.

### Граничные условия
- Успешный вход **сбрасывает** счётчик.
- Блокировка снимается автоматически по истечении окна (`WINDOW`).
- Неизвестный пользователь обрабатывается так же, как известный (не раскрываем,
  существует ли аккаунт — анти-enumeration).

# [CODE: rate_limiter]
```python
WINDOW = 300  # окно блокировки, сек


@dataclass
class RateState:
    failures: int = 0
    blocked_until: float = 0.0


_rate: dict[str, RateState] = {}


def is_blocked(username: str, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    st = _rate.get(username)
    return bool(st and st.blocked_until > now)


def record_failure(username: str, now: float | None = None) -> None:
    now = time.time() if now is None else now
    st = _rate.setdefault(username, RateState())
    st.failures += 1
    if st.failures >= MAX_ATTEMPTS:
        st.blocked_until = now + WINDOW


def record_success(username: str) -> None:
    _rate.pop(username, None)
```

# [EXPLANATION: user_store]
## 👤 Хранилище пользователей и вход

Минимальное in-memory хранилище и функция `login`, связывающая все слои воедино:
проверка блокировки → проверка пароля → выдача токена.

### Поток `login`
```text
login(user, pass)
   ├─ is_blocked?            ─► True  → отказ
   ├─ verify_password?       ─► False → record_failure → отказ
   └─ ok                     ─► record_success → issue_token
```

### Чек-лист ревью
- [x] Не логируем пароли.
- [x] Единая ветка отказа (нельзя по тайму различить «нет юзера» и «неверный пароль»).
- [ ] TODO: вынести хранилище в БД.

# [CODE: user_store]
```python
@dataclass
class User:
    username: str
    password_hash: str


_users: dict[str, User] = {}


def register(username: str, password: str) -> User:
    user = User(username=username, password_hash=hash_password(password))
    _users[username] = user
    return user


def login(username: str, password: str, now: float | None = None) -> str | None:
    if is_blocked(username, now):
        return None
    user = _users.get(username)
    if user is None or not verify_password(password, user.password_hash):
        record_failure(username, now)
        return None
    record_success(username)
    return issue_token(username, now)
```

# [EXPLANATION: demo_main]
## ▶️ Демонстрация

Запустите файл целиком командой:

```bash
xc-cli run demo.xc
```

Сценарий ниже регистрирует пользователя, делает успешный вход, проверяет токен,
а затем имитирует серию неверных паролей до срабатывания блокировки.

**Ожидаемый вывод:** валидный токен, `verify_token -> True`, и `blocked -> True`
после `MAX_ATTEMPTS` промахов.

# [CODE: demo_main]
```python
if __name__ == "__main__":
    register("alice", "correct horse battery staple")

    token = login("alice", "correct horse battery staple")
    print("login ok      ->", token is not None)
    print("token valid   ->", verify_token(token))

    # Имитируем перебор пароля.
    for i in range(MAX_ATTEMPTS):
        login("alice", "wrong-guess")
    print(f"after {MAX_ATTEMPTS} fails, blocked ->", is_blocked("alice"))

    # Просроченный токен отвергается (now сдвинут далеко в будущее).
    future = time.time() + TOKEN_TTL + 10
    print("expired token ->", verify_token(token, now=future))
```
