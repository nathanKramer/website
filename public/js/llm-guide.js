// Interactive figures for the "Inside a Language Model" post.
// Every demo uses small hand-picked numbers to show how a step behaves.
(function () {
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const fmtPct = (p) => (p >= 0.1 ? (p * 100).toFixed(0) + "%" : p >= 0.001 ? (p * 100).toFixed(1) + "%" : "<0.1%");

  function renderBars(el, items, opts) {
    opts = opts || {};
    const max = opts.scaleTo1 ? 1 : Math.max.apply(null, items.map((i) => i.p));
    el.innerHTML = "";
    items.forEach((it, idx) => {
      const row = document.createElement("div");
      const top = opts.highlight === undefined ? idx === 0 : opts.highlight === idx;
      row.className = "llm-bar" + (top ? " top" : "");
      row.innerHTML = '<span class="lbl"></span><span class="track"><span class="fill"></span></span><span class="pct"></span>';
      row.querySelector(".lbl").textContent = it.t.replace(/^ /, "␣");
      row.querySelector(".fill").style.width = Math.max(0.5, (it.p / max) * 100) + "%";
      row.querySelector(".pct").textContent = fmtPct(it.p);
      el.appendChild(row);
    });
  }

  function softmax(logits, T) {
    const s = logits.map((l) => l / T);
    const m = Math.max.apply(null, s);
    const e = s.map((x) => Math.exp(x - m));
    const sum = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / sum);
  }

  function svgEl(svg, tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(e);
    return e;
  }

  /* ---- opening figure + temperature ---- */
  const catTokens = [" mat", " floor", " couch", " bed", " roof", " keyboard", " moon", " banana"];
  const catLogits = [4.0, 3.2, 2.9, 2.6, 1.9, 1.5, 0.2, -0.6];

  if ($("llmHeroBars")) {
    const p = softmax(catLogits, 1);
    renderBars($("llmHeroBars"), catTokens.slice(0, 5).map((t, i) => ({ t, p: p[i] })));
  }

  if ($("llmTemp")) {
    const temp = $("llmTemp");
    const draw = () => {
      const T = parseFloat(temp.value);
      $("llmTempOut").textContent = T.toFixed(2);
      const p = softmax(catLogits, T);
      renderBars($("llmTempBars"), catTokens.map((t, i) => ({ t, p: p[i] })), { scaleTo1: true });
      $("llmTempNote").textContent =
        T < 0.4 ? "Very focused: almost always “mat”."
        : T > 1.4 ? "Very random: even “banana” gets a chance."
        : "Balanced: usually sensible, sometimes surprising.";
    };
    temp.addEventListener("input", () => { draw(); $("llmSamples").innerHTML = ""; });
    draw();
    $("llmSampleBtn").addEventListener("click", () => {
      const p = softmax(catLogits, parseFloat(temp.value));
      const box = $("llmSamples");
      box.innerHTML = "";
      for (let k = 0; k < 12; k++) {
        let r = Math.random(), i = 0;
        while (i < p.length - 1 && r > p[i]) { r -= p[i]; i++; }
        const s = document.createElement("span");
        s.textContent = catTokens[i].trim();
        box.appendChild(s);
      }
    });
  }

  /* ---- tokenizer (rule-based imitation, not a real BPE tokenizer) ---- */
  if ($("llmTokInput")) {
    const special = {
      strawberry: ["str", "aw", "berry"],
      unbelievably: ["un", "belie", "v", "ably"],
      chatbots: ["chat", "bots"],
      tokenizer: ["token", "izer"],
      tokens: ["tokens"],
    };
    const suffixes = ["ization", "ation", "ingly", "ing", "ness", "ment", "able", "ably", "ful", "less", "ly", "ed", "er", "est"];
    const chunk = (w) => { const out = []; for (let i = 0; i < w.length; i += 5) out.push(w.slice(i, i + 5)); return out; };
    const splitWord = (lead, w) => {
      const lw = w.toLowerCase();
      if (special[lw]) {
        const parts = special[lw].slice();
        if (w[0] !== w[0].toLowerCase()) parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
        parts[0] = lead + parts[0];
        return parts;
      }
      if (w.length <= 7) return [lead + w];
      for (const s of suffixes) {
        if (lw.endsWith(s) && w.length - s.length >= 3) {
          const stem = w.slice(0, w.length - s.length);
          const stemParts = stem.length > 7 ? chunk(stem) : [stem];
          stemParts[0] = lead + stemParts[0];
          return stemParts.concat([w.slice(w.length - s.length)]);
        }
      }
      const c = chunk(w);
      c[0] = lead + c[0];
      return c;
    };
    const tokenize = (text) => {
      const raw = text.match(/ ?[A-Za-z]+| ?\d{1,3}|'[a-z]{1,2}\b| ?[^\sA-Za-z\d]|\n| +/g) || [];
      let out = [];
      raw.forEach((r) => {
        const m = r.match(/^( ?)([A-Za-z]+)$/);
        if (m) out = out.concat(splitWord(m[1], m[2]));
        else out.push(r);
      });
      return out;
    };
    const tokId = (t) => {
      let h = 2166136261;
      for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
      return (h >>> 0) % 100000;
    };
    const draw = () => {
      const text = $("llmTokInput").value;
      const toks = tokenize(text);
      const out = $("llmTokOut");
      out.innerHTML = "";
      toks.forEach((t) => {
        const s = document.createElement("span");
        s.className = "llm-tok";
        s.textContent = t === "\n" ? "↵" : t;
        out.appendChild(s);
      });
      $("llmTokChars").textContent = text.length;
      $("llmTokCount").textContent = toks.length;
      $("llmTokRatio").textContent = toks.length ? (text.length / toks.length).toFixed(1) : "0";
      $("llmTokIds").textContent = "[" + toks.map(tokId).join(", ") + "]";
    };
    $("llmTokInput").addEventListener("input", draw);
    draw();
  }

  /* ---- embedding map ---- */
  if ($("llmEmbSvg")) {
    const svg = $("llmEmbSvg");
    const el = (tag, attrs, parent) => svgEl(svg, tag, attrs, parent);
    const words = [
      ["cat", 20, 70], ["dog", 26, 76], ["kitten", 14, 64], ["puppy", 22, 83], ["horse", 32, 70],
      ["pizza", 72, 22], ["pasta", 80, 27], ["bread", 66, 15], ["apple", 82, 15],
      ["king", 70, 72], ["queen", 80, 84], ["prince", 64, 79], ["princess", 73, 91],
      ["man", 54, 58], ["woman", 64, 70],
      ["happy", 24, 32], ["joyful", 17, 26], ["sad", 37, 20], ["angry", 42, 29],
    ];
    const groups = [["ANIMALS", 22, 95], ["FOOD", 75, 4], ["ROYALTY", 88, 97], ["FEELINGS", 28, 9]];
    const X = (x) => 30 + x * 5.8, Y = (y) => 385 - y * 3.7;
    const defs = el("defs", {});
    const mk = el("marker", { id: "llmArrowHead", viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z", class: "emb-arrowhead" }, mk);
    for (let g = 0; g <= 100; g += 20) {
      el("line", { x1: X(g), y1: Y(0), x2: X(g), y2: Y(100), class: "emb-grid" });
      el("line", { x1: X(0), y1: Y(g), x2: X(100), y2: Y(g), class: "emb-grid" });
    }
    groups.forEach(([t, x, y]) => { el("text", { x: X(x), y: Y(y), class: "emb-group", "text-anchor": "middle" }).textContent = t; });
    const arrows = el("g", { visibility: "hidden" });
    const arrow = (a, b) => {
      const A = words.find((w) => w[0] === a), B = words.find((w) => w[0] === b);
      el("line", { x1: X(A[1]), y1: Y(A[2]), x2: X(B[1]), y2: Y(B[2]), class: "emb-arrow", "marker-end": "url(#llmArrowHead)" }, arrows);
    };
    arrow("man", "woman");
    arrow("king", "queen");
    words.forEach(([w, x, y]) => {
      el("circle", { cx: X(x), cy: Y(y), r: 5, class: "emb-dot" });
      el("text", { x: X(x) + 8, y: Y(y) + 4, class: "emb-label" }).textContent = w;
    });
    let on = false;
    $("llmEmbBtn").addEventListener("click", () => {
      on = !on;
      arrows.setAttribute("visibility", on ? "visible" : "hidden");
      $("llmEmbBtn").textContent = on ? "Hide arrows" : "Show king − man + woman";
      $("llmEmbNote").textContent = on
        ? "Both arrows point the same way: the model has learned a direction that roughly means “male → female”. Start at king, take away man, add woman, and you land near queen."
        : "Similar words sit together. Directions mean something too.";
    });
  }

  /* ---- attention ---- */
  if ($("llmAtt")) {
    const base = ["The", "animal", "didn't", "cross", "the", "street", "because", "it", "was", "too"];
    let last = "tired";
    let sel = 10;
    const attMap = {
      7: { 1: 0.38, 5: 0.32, 7: 0.1, 6: 0.08, 3: 0.05, 0: 0.03, 2: 0.02, 4: 0.02 },
      10: {
        tired: { 1: 0.46, 7: 0.22, 8: 0.1, 9: 0.08, 10: 0.07, 5: 0.03, 3: 0.02, 0: 0.02 },
        wide: { 5: 0.48, 7: 0.2, 8: 0.1, 9: 0.08, 10: 0.07, 1: 0.03, 3: 0.02, 4: 0.02 },
      },
      3: { 1: 0.42, 2: 0.3, 3: 0.18, 0: 0.1 },
      5: { 3: 0.42, 4: 0.25, 5: 0.18, 1: 0.1, 0: 0.05 },
      6: { 3: 0.3, 2: 0.25, 6: 0.2, 1: 0.15, 5: 0.1 },
    };
    const explain = {
      7: "“it” is ambiguous so far. The model splits its attention between “animal” and “street”.",
      "10tired": "“tired” looks back hard at “animal”. Animals get tired, so now “it” is clearly the animal.",
      "10wide": "“wide” looks back at “street”. Streets are wide, so now “it” is clearly the street.",
      3: "“cross” attends to who is doing the crossing (“animal”) and to “didn't”, which flips its meaning.",
      5: "“street” attends to “cross”: it's the thing being crossed.",
      6: "“because” looks back at the event being explained: “didn't cross”.",
    };
    const weightsFor = (i) => {
      if (i === 10) return attMap[10][last];
      if (attMap[i]) return attMap[i];
      const w = {};
      if (i === 0) { w[0] = 1; return w; }
      w[i] = 0.4; w[i - 1] = 0.35;
      const rest = 0.25 / i;
      for (let k = 0; k < i - 1; k++) w[k] = rest;
      w[i - 1] += rest;
      return w;
    };
    const draw = () => {
      const box = $("llmAtt");
      box.innerHTML = "";
      const all = base.concat([last]);
      const w = weightsFor(sel);
      const mx = Math.max.apply(null, Object.values(w));
      all.forEach((word, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "llm-att-word" + (i === sel ? " sel" : "") + (i > sel ? " future" : "");
        const v = w[i] || 0;
        b.innerHTML = '<span class="heat"></span><span class="w"></span><small></small>';
        b.querySelector(".w").textContent = word;
        b.querySelector(".heat").style.opacity = i <= sel ? ((v / mx) * 0.85).toFixed(2) : 0;
        b.querySelector("small").textContent = i <= sel && v > 0 ? Math.round(v * 100) + "%" : "";
        b.setAttribute("aria-label", word + (i <= sel ? ", attention " + Math.round(v * 100) + "%" : ", later word"));
        b.addEventListener("click", () => { sel = i; draw(); });
        box.appendChild(b);
      });
      const key = sel === 10 ? "10" + last : sel;
      $("llmAttExplain").textContent =
        explain[key] || "“" + all[sel] + "” mostly looks at itself and the word just before it. Not every word needs to reach far back.";
    };
    const setLast = (word) => {
      last = word;
      sel = 10;
      $("llmAttTired").className = "llm-btn" + (word === "tired" ? "" : " ghost");
      $("llmAttWide").className = "llm-btn" + (word === "wide" ? "" : " ghost");
      draw();
    };
    $("llmAttTired").addEventListener("click", () => setLast("tired"));
    $("llmAttWide").addEventListener("click", () => setLast("wide"));
    draw();
  }

  /* ---- generation loop ---- */
  if ($("llmGenText")) {
    const prompt = "The best thing about the ocean is";
    const steps = [
      [[" the", 0.34], [" how", 0.22], [" that", 0.15], [" its", 0.09]],
      [[" sound", 0.18], [" way", 0.16], [" smell", 0.11], [" waves", 0.1]],
      [[" of", 0.61], [".", 0.12], [" it", 0.06], [" at", 0.04]],
      [[" the", 0.52], [" waves", 0.27], [" water", 0.08], [" crashing", 0.05]],
      [[" waves", 0.71], [" water", 0.09], [" sea", 0.05], [" tide", 0.04]],
      [[" crashing", 0.28], [".", 0.22], [" at", 0.15], [" against", 0.09]],
      [[" against", 0.38], [".", 0.3], [" on", 0.17], [" at", 0.06]],
      [[" the", 0.7], [" rocks", 0.12], [" a", 0.06], [" my", 0.03]],
      [[" rocks", 0.48], [" shore", 0.31], [" sand", 0.08], [" cliffs", 0.05]],
      [[".", 0.74], [" at", 0.08], [",", 0.06], [" below", 0.04]],
      [["<end>", 0.81], [" It", 0.07], [" I", 0.05], ["\n", 0.03]],
    ];
    let gi = 0, timer = null;
    const draw = (justAdded) => {
      const t = $("llmGenText");
      t.innerHTML = "";
      const p = document.createElement("span");
      p.className = "p";
      p.textContent = prompt;
      t.appendChild(p);
      for (let k = 0; k < gi; k++) {
        const tok = steps[k][0][0];
        if (tok === "<end>") continue;
        const s = document.createElement("span");
        s.textContent = tok;
        if (justAdded && k === gi - 1) s.className = "new";
        t.appendChild(s);
      }
      $("llmGenStep").textContent = gi;
      const done = gi >= steps.length;
      if (gi > 0) renderBars($("llmGenBars"), steps[gi - 1].map(([tk, pr]) => ({ t: tk === "\n" ? "↵" : tk, p: pr })), { scaleTo1: true, highlight: 0 });
      else $("llmGenBars").innerHTML = '<p class="llm-note">Press the button to make the first prediction.</p>';
      $("llmGenBtn").disabled = done;
      $("llmGenAuto").disabled = done;
      if (done) {
        const e = document.createElement("span");
        e.className = "p";
        e.textContent = "  [done: the model predicted <end>]";
        t.appendChild(e);
      }
    };
    const next = () => {
      if (gi < steps.length) { gi++; draw(true); }
      if (gi >= steps.length && timer) { clearInterval(timer); timer = null; }
    };
    $("llmGenBtn").addEventListener("click", next);
    $("llmGenAuto").addEventListener("click", () => { if (timer) return; timer = setInterval(next, 650); next(); });
    $("llmGenReset").addEventListener("click", () => { if (timer) { clearInterval(timer); timer = null; } gi = 0; draw(false); });
    draw(false);
  }

  /* ---- training ---- */
  if ($("llmTrain")) {
    const stages = [
      { label: "untrained", t: 0, note: "Random parameters: every one of ~100,000 tokens gets about the same tiny chance. The right answer is a lottery ticket.",
        bars: [[" Paris", 0.00002], [" a", 0.00002], [" the", 0.00002], [" Lyon", 0.00002], [" banana", 0.00002]] },
      { label: "early", t: 0.12, note: "It has learned that “the” and “a” often come next. Grammar arrives before facts.",
        bars: [[" the", 0.09], [" a", 0.07], [" Paris", 0.005], [" Lyon", 0.001], [" banana", 0.0004]] },
      { label: "midway", t: 0.32, note: "It now links “capital” and “France” to a city. Paris leads, but it isn't sure.",
        bars: [[" Paris", 0.22], [" a", 0.1], [" the", 0.07], [" Lyon", 0.03], [" banana", 0.0001]] },
      { label: "trained", t: 0.92, note: "Confident and correct. The loss is small, so further training barely changes these parameters.",
        bars: [[" Paris", 0.8], [" a", 0.05], [" the", 0.03], [" Lyon", 0.004], [" banana", 0.00001]] },
    ];
    const svg = $("llmLossSvg");
    const sv = (tag, attrs) => svgEl(svg, tag, attrs);
    const LX = (t) => 34 + t * 276, LY = (l) => 145 - (l / 11) * 130;
    const curve = (t) => 0.22 + 10.6 * Math.exp(-6.2 * t);
    const pts = [];
    for (let i = 0; i <= 60; i++) { const t = i / 60; pts.push(LX(t).toFixed(1) + "," + LY(curve(t)).toFixed(1)); }
    sv("path", { d: "M" + LX(0) + "," + LY(0) + " L" + pts.join(" L") + " L" + LX(1) + "," + LY(0) + " Z", class: "loss-area" });
    sv("line", { x1: LX(0), y1: LY(0), x2: LX(1), y2: LY(0), class: "loss-axis" });
    sv("line", { x1: LX(0), y1: LY(0), x2: LX(0), y2: LY(11), class: "loss-axis" });
    sv("path", { d: "M" + pts.join(" L"), class: "loss-line" });
    [0, 5, 10].forEach((v) => { sv("text", { x: 26, y: LY(v) + 4, class: "loss-tick", "text-anchor": "end" }).textContent = v; });
    sv("text", { x: LX(0.5), y: 165, class: "loss-tick", "text-anchor": "middle" }).textContent = "training steps →";
    sv("text", { x: LX(0) + 6, y: LY(11) + 4, class: "loss-tick" }).textContent = "loss";
    const dot = sv("circle", { r: 6, class: "loss-dot" });
    const draw = () => {
      const s = stages[+$("llmTrain").value];
      $("llmTrainOut").textContent = s.label;
      const pi = s.bars.findIndex((b) => b[0] === " Paris");
      renderBars($("llmTrainBars"), s.bars.map(([t, p]) => ({ t, p })), { scaleTo1: true, highlight: pi });
      $("llmTrainNote").textContent = s.note;
      const loss = -Math.log(s.bars[pi][1]);
      $("llmTrainLoss").textContent = loss.toFixed(1);
      dot.setAttribute("cx", LX(s.t));
      dot.setAttribute("cy", LY(Math.min(10.8, loss)));
    };
    $("llmTrain").addEventListener("input", draw);
    draw();
  }

  /* ---- glossary search ---- */
  if ($("llmGlossSearch")) {
    const input = $("llmGlossSearch");
    const list = input.closest(".llm-gloss-search").nextElementSibling;
    if (list && list.tagName === "UL") {
      const items = Array.from(list.children);
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        let shown = 0;
        items.forEach((li) => {
          const match = !q || li.textContent.toLowerCase().includes(q);
          li.hidden = !match;
          if (match) shown++;
        });
        $("llmGlossEmpty").hidden = shown > 0;
      });
    }
  }
})();
