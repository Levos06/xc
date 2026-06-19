---
xc_spec: "2.0"
language: "python"
module: "core.auth.session"
author: "Levos06"
---

# [EXPLANATION: overview]
lines: 1-86
## 🧱 Сервис аутентификации
Монолитный модуль: хэширование паролей, HMAC-токены и простой rate-limiter.
Описания ниже привязаны к диапазонам строк кода справа.

# [EXPLANATION: config]
lines: 7-12
## Конфигурация
Единственный источник «магических чисел».

| Константа | Значение |
|-----------|----------|
| `TOKEN_TTL` | 3600 c |
| `MAX_ATTEMPTS` | 5 |
| `PBKDF2_ROUNDS` | 120 000 |

# [EXPLANATION: secret_key]
lines: 14
## Секретный ключ
В демо ключ зашит; в проде — только из окружения (**fail-closed**).

# [EXPLANATION: hashing]
lines: 17-34
## 🔐 Хэширование паролей
`PBKDF2-HMAC-SHA256` со случайной солью. Время атаки растёт линейно по числу
итераций $c$:

$$T_{\text{attack}} \approx N \cdot c \cdot t_{\text{sha}}.$$

# [EXPLANATION: timing_safe]
lines: 34
## Сравнение в постоянное время
`hmac.compare_digest` — защита от timing-атак (вложенный диапазон внутри `hashing`).

# [EXPLANATION: tokens]
lines: 37-55
## 🎫 Сессионные токены
Подпись:

$$\mathrm{sig} = \mathrm{HMAC}_K(m) = H\!\big((K \oplus \mathrm{opad}) \,\|\, H((K \oplus \mathrm{ipad}) \,\|\, m)\big).$$

Валиден ⇔ подпись совпала **и** $\exp > t_{\text{now}}$.

# [EXPLANATION: rate_limiter]
lines: 58-78
## 🚦 Rate-limiter
После `MAX_ATTEMPTS` неудач аккаунт блокируется на `WINDOW` секунд.

# [CODE: MONOLITH]
```python
import hashlib
import hmac
import os
import time
from dataclasses import dataclass

# --- Конфигурация (единственный источник магических чисел) ---
TOKEN_TTL = 3600
MAX_ATTEMPTS = 5
PBKDF2_ROUNDS = 120_000
SALT_BYTES = 16
WINDOW = 300

SECRET_KEY = os.environ.get("SECRET_KEY", "demo-insecure-key").encode("utf-8")


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
        exp = int(payload.split(":")[1])
    except (ValueError, IndexError):
        return False
    expected = hmac.new(SECRET_KEY, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    return exp > now


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


if __name__ == "__main__":
    print("expired ->", verify_token("u:0"))
    print("valid   ->", verify_token(issue_token("alice")))
    record_failure("bob"); record_failure("bob"); record_failure("bob")
    record_failure("bob"); record_failure("bob")
    print("blocked ->", is_blocked("bob"))
```
