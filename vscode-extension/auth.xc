---
xc_spec: "1.0"
language: "python"
module: "core.auth"
always_apply: true
---

# [EXPLANATION: main_logic]
## Архитектурный контекст
Слой выполняет валидацию сессионных токенов.

## Инварианты безопасности:
* Токен не должен обрабатываться, если время жизни (`exp`) истекло.
* Отсутствие поля `exp` трактуется как невалидный токен (fail-closed).

# [CODE: main_logic]
```python
import time


def verify_session(token_data: dict) -> bool:
    if "exp" not in token_data:
        return False
    return token_data["exp"] > time.time()


if __name__ == "__main__":
    # Демонстрация: токен с истёкшим сроком отвергается.
    print("expired ->", verify_session({"exp": 0}))
    print("valid   ->", verify_session({"exp": time.time() + 3600}))
```
