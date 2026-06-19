---
xc_spec: "2.0"
language: "python"
module: "core.auth"
---

# [EXPLANATION: overview]
lines: 1-12
## Архитектурный контекст
Слой выполняет валидацию сессионных токенов и демонстрирует запуск.

# [EXPLANATION: exp_invariant]
lines: 4-7
## Инвариант истечения токена
Отсутствие поля `exp` или истёкшее время жизни (`exp <= now`) трактуется как
невалидный токен (fail-closed).

# [CODE: MONOLITH]
```python
import time


def verify_session(token_data: dict) -> bool:
    if "exp" not in token_data:
        return False
    return token_data["exp"] > time.time()


if __name__ == "__main__":
    print("expired ->", verify_session({"exp": 0}))
    print("valid   ->", verify_session({"exp": time.time() + 3600}))
```
