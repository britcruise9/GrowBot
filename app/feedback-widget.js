/* [?] feedback widget (Brit 0727: "every page should have the [?] pop up").
   One include, zero dependencies: <script src="/feedback-widget.js" data-surface="v3"></script>
   Injects a small corner [?] button; tapping opens a one-field sheet that POSTs
   { text, stage: <surface>, sid: <device/session id if the page has one>, logSid: <journal session id or ""> } to the
   long-live /api/feedback endpoint (open, rate-limited, read on /dash.html).
   z-index 45 on purpose: UNDER v3's wake gate (60) and brain panel (80) and v2's popups,
   so it never covers a creature moment. Accessible: real button, labelled field, Esc closes. */
(function(){
  if (window.__gbFbWidget) return; window.__gbFbWidget = 1;
  var surf = "unknown";
  try { var cs = document.currentScript; surf = (cs && cs.getAttribute("data-surface")) || location.pathname; } catch(e){}
  function sid(){
    try { return localStorage.getItem("pb_did") || localStorage.getItem("pb2_sid") || localStorage.getItem("gb_next_sid") || ""; } catch(e){ return ""; }
  }
  /* 0925 (field note from a device could not be matched to its log): sid above is the DEVICE,
     journals are keyed by SESSION. logSid is the journal/watch session id when the page has one (v3 LOG_SID,
     "nx-..."), read from the page, never guessed from storage: a page without a journal sends "".
     0925 review (FB-OPTOUT): the session id is the key to that journal, so it follows the page's own sharing switch,
     the way v3's watch link does (logOn() && LOG_SID). Journal sharing off = "". A page that has a LOG_SID but no
     logOn() to ask also sends "": for a privacy control the safe direction is not sharing. */
  function logSid(){
    try { var s = window.LOG_SID; if (typeof s !== "string" || typeof window.logOn !== "function" || !window.logOn()) return ""; return s.slice(0, 40); } catch(e){ return ""; }
  }
  var css = document.createElement("style");
  css.textContent =
    "#gbFbBtn{position:fixed;right:10px;bottom:10px;z-index:45;width:34px;height:34px;border-radius:17px;border:1px solid rgba(140,160,190,.4);background:rgba(10,14,22,.72);color:#aebfd6;font:700 15px/32px -apple-system,system-ui,sans-serif;text-align:center;cursor:pointer;padding:0}" +
    "#gbFbBtn:active{transform:translateY(1px)}" +
    "#gbFbOv{position:fixed;inset:0;z-index:46;background:rgba(4,6,10,.6);display:flex;align-items:flex-end;justify-content:center}" +
    "#gbFbSh{width:100%;max-width:480px;background:#12161e;color:#dbe4ee;border-top:1px solid rgba(140,160,190,.3);border-radius:14px 14px 0 0;padding:14px 14px 18px;font:14px/1.5 -apple-system,system-ui,sans-serif}" +
    "#gbFbSh h2{margin:0 0 8px;font-size:14px}" +
    "#gbFbTx{width:100%;box-sizing:border-box;min-height:84px;background:#0b0f15;color:#dbe4ee;border:1px solid rgba(140,160,190,.35);border-radius:9px;padding:9px;font:13px/1.5 inherit;resize:vertical}" +
    "#gbFbRow{display:flex;gap:8px;margin-top:9px}" +
    "#gbFbGo{flex:1;background:#2563eb;border:0;border-radius:9px;color:#fff;font:700 13px inherit;padding:11px}" +
    "#gbFbNo{background:#1a212c;border:0;border-radius:9px;color:#aebfd6;font:13px inherit;padding:11px 14px}" +
    "#gbFbSt{margin:7px 0 0;font-size:12px;color:#8fa3bd;min-height:1.2em}";
  document.head.appendChild(css);
  var btn = document.createElement("button");
  btn.id = "gbFbBtn"; btn.textContent = "?"; btn.setAttribute("aria-label", "having a problem or an idea? tell us");
  btn.title = "having a problem or an idea? tell us";
  var ov = null;
  function close(){ if (ov) { ov.remove(); ov = null; } }
  function open(){
    if (ov) return;
    ov = document.createElement("div"); ov.id = "gbFbOv";
    ov.innerHTML = '<div id="gbFbSh" role="dialog" aria-modal="true" aria-labelledby="gbFbT">' +
      '<h2 id="gbFbT">having a problem or an idea? tell us</h2>' +
      '<textarea id="gbFbTx" aria-label="your message" maxlength="1500" placeholder="what happened, or what you wish existed"></textarea>' +
      '<div id="gbFbRow"><button id="gbFbGo">send</button><button id="gbFbNo">close</button></div>' +
      '<p id="gbFbSt"></p>' +
      '<p style="margin:10px 0 0;font-size:11px;color:#8fa3bd">or email <a href="mailto:info@growbot.dev" style="color:#aebfd6">info@growbot.dev</a> directly, we read this fast but that reaches a human right away</p>' +
      '</div>';   /* 0731: this widget is on nearly every page (v3/v2/meet/agent), so it's the ONE place to add a direct-email line and fix "no way to reach support" everywhere at once. The [ ? ] send is async (read on /dash.html later) — someone stuck NOW needs the immediate option too. */
    document.body.appendChild(ov);
    ov.addEventListener("click", function(e){ if (e.target === ov) close(); });
    document.getElementById("gbFbNo").addEventListener("click", close);
    var tx = document.getElementById("gbFbTx"); try { tx.focus(); } catch(e){}
    document.getElementById("gbFbGo").addEventListener("click", function(){
      var t = (tx.value || "").trim(); var st = document.getElementById("gbFbSt");
      if (t.length < 3) { st.textContent = "a few more words?"; return; }
      var go = document.getElementById("gbFbGo"); go.disabled = true; st.textContent = "sending…";
      fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, stage: "fb:" + surf, sid: sid(), logSid: logSid() }) })
      .then(function(r){ if (r.ok) { st.textContent = "got it. thank you 💛"; setTimeout(close, 1200); }
        else { go.disabled = false; st.textContent = "hiccup, try again in a moment"; } })
      .catch(function(){ go.disabled = false; st.textContent = "no connection, try again"; });
    });
  }
  btn.addEventListener("click", open);
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") close(); });
  function mount(){ if (document.body) document.body.appendChild(btn); else setTimeout(mount, 300); }
  mount();
})();
