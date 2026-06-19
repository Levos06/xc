/* Interactive two-mode viewer demo — mirrors the extension's logic. */
(function () {
  const root = document.getElementById("demo");
  if (!root) return;

  const CODE = [
    ["import", " time, hmac, hashlib, os"],
    [],
    ["c", "# конфигурация — единственный источник магических чисел"],
    ["", "TOKEN_TTL = ", ["n", "3600"]],
    ["", "PBKDF2_ROUNDS = ", ["n", "120_000"]],
    [],
    ["def", " ", ["f", "hash_password"], "(pw): "],
    ["", "    salt = os.urandom(", ["n", "16"], ")"],
    ["", "    dk = hashlib.pbkdf2_hmac(", ["s", '"sha256"'], ", pw.encode(), salt, PBKDF2_ROUNDS)"],
    ["", "    ", ["k", "return"], " ", ["s", 'f"{salt.hex()}${dk.hex()}"']],
    [],
    ["def", " ", ["f", "verify_session"], "(token): "],
    ["", "    ", ["k", "if"], " ", ["s", '"exp"'], " ", ["k", "not in"], " token:"],
    ["", "        ", ["k", "return"], " ", ["n", "False"]],
    ["", "    ", ["k", "return"], " token[", ["s", '"exp"'], "] > time.time()"],
  ];
  // raw line strings for highlighting reconstruction (kept simple: render tokens)
  const BLOCKS = [
    { id: "overview", start: 1, end: 15, html: "<p>Мини-сервис аутентификации: конфигурация, хэш пароля и проверка сессии в одном модуле.</p>" },
    { id: "config", start: 4, end: 5, html: "<p>Все «магические числа» живут <b>только здесь</b> — ниже по коду их быть не должно.</p>" },
    { id: "hashing", start: 7, end: 10, html: "<p><code>PBKDF2-HMAC-SHA256</code> со случайной солью на каждого пользователя.</p>" },
    { id: "attack_cost", start: 7, end: 10, html: "<p>Стоимость перебора растёт <b>линейно</b> по числу итераций <code>PBKDF2_ROUNDS</code>.</p>" },
    { id: "session", start: 12, end: 15, html: "<p>Проверка сессионного токена перед обработкой запроса.</p>" },
    { id: "fail_closed", start: 13, end: 14, html: "<p><b>Fail-closed:</b> токена без поля <code>exp</code> достаточно, чтобы отказать.</p>" },
  ];
  const LH = 26, PAD = 18;
  let mode = "grid", expanded = null;
  const activeTab = {}; // startLine -> id

  const codeEl = root.querySelector(".demo-code");
  const ctxEl = root.querySelector(".ctx");
  const grEl = root.querySelector(".gr");
  const modesEl = root.querySelector(".modes");

  function esc(s) { return String(s).replace(/[&<>]/g, c => c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"); }
  function tokens(line) {
    if (!line || !line.length) return "";
    let out = "";
    // first element may be a keyword class marker like "import"/"def" -> color whole word
    const lead = line[0];
    let parts = line;
    if (lead === "import" || lead === "def") { out += '<span class="k">' + lead + "</span>"; parts = line.slice(1); }
    else if (lead === "c") { return '<span class="c">' + esc(line[1]) + "</span>"; }
    else parts = line.slice(1);
    parts.forEach(p => {
      if (Array.isArray(p)) out += '<span class="' + p[0] + '">' + esc(p[1]) + "</span>";
      else out += esc(p);
    });
    return out;
  }

  function blocksForLine(n) { return BLOCKS.filter(b => n >= b.start && n <= b.end); }
  function span(list) { return list.length ? { min: Math.min(...list.map(b => b.start)), max: Math.max(...list.map(b => b.end)) } : null; }
  function highlight(sp) {
    codeEl.querySelectorAll(".ln").forEach(r => {
      const n = +r.dataset.line;
      r.classList.toggle("hot", !!sp && n >= sp.min && n <= sp.max);
    });
  }

  function renderCode() {
    codeEl.innerHTML = "";
    CODE.forEach((ln, i) => {
      const row = document.createElement("div");
      row.className = "ln"; row.dataset.line = i + 1;
      row.innerHTML = '<span class="gut">' + (i + 1) + "</span>" + (tokens(ln) || " ");
      row.addEventListener("mouseenter", () => {
        if (mode === "context") renderContext(i + 1);
        highlight(span(blocksForLine(i + 1)));
      });
      row.addEventListener("click", () => {
        const cov = blocksForLine(i + 1);
        if (mode === "grid" && cov.length) { expanded = cov.reduce((a, b) => b.start > a.start ? b : a).id; renderGrid(); }
      });
      codeEl.appendChild(row);
    });
  }

  function renderContext(n) {
    const cards = n ? blocksForLine(n) : [];
    ctxEl.innerHTML = cards.length
      ? cards.map(b => '<div class="ctx-card' + (cards.length === 1 ? " solo" : "") + '"><div class="blk-id">' + b.id + '</div><div class="md">' + b.html + "</div></div>").join("")
      : '<div class="empty">Наведите курсор на строку кода — появится её описание.</div>';
  }

  function groupsByStart() {
    const m = new Map();
    BLOCKS.forEach(b => { if (!m.has(b.start)) m.set(b.start, []); m.get(b.start).push(b); });
    return m;
  }
  function activeOf(s, group) { return group.find(b => b.id === activeTab[s]) || group[0]; }

  function renderGrid() {
    const groups = groupsByStart();
    const starts = [...groups.keys()].sort((a, b) => a - b);
    grEl.innerHTML = '<div class="lines"></div>';
    const lines = grEl.querySelector(".lines");
    lines.style.height = CODE.length * LH + "px";
    lines.style.background = "repeating-linear-gradient(to bottom, transparent 0, transparent " + (LH - 1) + "px, var(--line) " + (LH - 1) + "px, var(--line) " + LH + "px)";
    grEl.style.height = (PAD * 2 + CODE.length * LH) + "px";

    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const next = i + 1 < starts.length ? starts[i + 1] : CODE.length + 1;
      const group = groups.get(s);
      const b = activeOf(s, group);
      const sp = next - s;
      const isExp = b.id === expanded;
      const cell = document.createElement("div");
      cell.className = "gcell" + (isExp ? " expanded" : "");
      cell.style.top = (PAD + (s - 1) * LH) + "px";
      if (!isExp) cell.style.maxHeight = (sp * LH) + "px";

      const head = document.createElement("div");
      head.className = "ghead";
      if (group.length > 1) {
        const tabs = document.createElement("div"); tabs.className = "gtabs";
        group.forEach(g => {
          const t = document.createElement("span");
          t.className = "gtab" + (g.id === b.id ? " active" : "");
          t.textContent = g.id;
          t.addEventListener("click", e => { e.stopPropagation(); activeTab[s] = g.id; expanded = null; renderGrid(); });
          tabs.appendChild(t);
        });
        head.appendChild(tabs);
      } else {
        const lab = document.createElement("span"); lab.className = "blk-id"; lab.textContent = b.id; head.appendChild(lab);
      }
      const exp = document.createElement("span"); exp.className = "gexp"; exp.textContent = isExp ? "▾" : "▸"; head.appendChild(exp);

      const body = document.createElement("div"); body.className = "md"; body.innerHTML = b.html;
      cell.appendChild(head); cell.appendChild(body);
      cell.addEventListener("mouseenter", () => highlight({ min: b.start, max: b.end }));
      cell.addEventListener("mouseleave", () => highlight(null));
      cell.addEventListener("click", e => {
        if (e.target.closest && e.target.closest(".gtab")) return;
        expanded = expanded === b.id ? null : b.id; renderGrid();
      });
      grEl.appendChild(cell);
    }
  }

  function setMode(m) {
    mode = m; expanded = null;
    modesEl.querySelectorAll("button").forEach(x => x.classList.toggle("active", x.dataset.mode === m));
    ctxEl.classList.toggle("on", m === "context");
    grEl.classList.toggle("on", m === "grid");
    if (m === "context") renderContext(0); else renderGrid();
    highlight(null);
  }
  modesEl.querySelectorAll("button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));

  renderCode();
  setMode("grid");
})();
