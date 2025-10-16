
/* =============================================================
   CLOUD ADAPTER v1 — McD Crew System (Union City #19694)
   Author: ChatGPT for Jofree (2025-10-15)
   Purpose: Bridge localStorage-driven app -> Firebase Firestore
   Notes:
     - Non-invasive: keeps your current UI/logic working.
     - Mirrors writes to cloud; listens to cloud in real time.
     - Works even if some functions (renderItems/updateStatus) aren't loaded yet.
     - Leaves your "MENSAJE INBORRABLE" philosophy intact.
   ============================================================= */

(function(){
  "use strict";

  // ---- Store/tables ----
  const STORE_ID = "19694"; // change if you manage multiple stores
  // Keys already used by the app (we intercept writes to sync to cloud)
  const STORAGE_KEY       = "mc_items_main";
  const SHIFT_HISTORY_KEY = "mc_shift_history";
  const LANG_KEY          = "mc_lang";
  const PIE_NAMES_KEY     = "mc_pie_names";
  const PIE_STATUS_KEY    = "mc_pie_status";

  // Window-safe helpers
  function safe(fn){ try { fn(); } catch(e){ /* console.warn(e); */ } }
  function exists(id){ return !!document.getElementById(id); }
  function on(el, ev, fn){ if (el) el.addEventListener(ev, fn, true); }

  // Firebase handles (filled in init)
  let app=null, auth=null, db=null;

  // Cached unsubscribers
  let unsubItems=null, unsubRuntime=null, unsubSettings=null;

  // Utility: wait for Firebase SDK presence
  function waitForFirebaseSDKs(timeoutMs=8000){
    return new Promise((resolve, reject)=>{
      const t0 = Date.now();
      (function check(){
        if (window.firebase && firebase.firestore && firebase.auth) return resolve(true);
        if (Date.now()-t0 > timeoutMs) return reject(new Error("Firebase SDKs not present"));
        requestAnimationFrame(check);
      })();
    });
  }

  // --- Init Firebase (expects a global window.__FIREBASE_CONFIG__ object) ---
  async function initFirebase(){
    if (!window.__FIREBASE_CONFIG__) {
      console.warn("⛔ Missing __FIREBASE_CONFIG__ on window. Cloud sync disabled.");
      return;
    }
    await waitForFirebaseSDKs();
    if (!firebase.apps.length){
      firebase.initializeApp(window.__FIREBASE_CONFIG__);
    }
    app = firebase.app();
    auth = firebase.auth();
    db   = firebase.firestore();

    // Optional: offline persistence
    db.enablePersistence({ synchronizeTabs: true }).catch(()=>{});

    // Auth state -> attach role & kick subscriptions
    auth.onAuthStateChanged(async (user)=>{
      if (user){
        // Try reading role from token claims; fallback to users doc
        let role = "crew";
        try {
          const token = await user.getIdTokenResult(true);
          role = token.claims && token.claims.role || "crew";
        } catch(e){}
        try {
          const udoc = await db.collection("users").doc(user.uid).get();
          if (udoc.exists && udoc.data().role) role = udoc.data().role;
        } catch(e){}

        // Expose role to app UI (non-security): add body dataset, CSS can react
        document.body.dataset.role = role;

        startSubscriptions();
      } else {
        stopSubscriptions();
        // clear role badge
        delete document.body.dataset.role;
      }
    });
  }

  // --- Firestore refs ---
  function colItems(){ return db.collection("stores").doc(STORE_ID).collection("items"); }
  function docRuntime(){ return db.collection("stores").doc(STORE_ID).collection("runtime").doc("state"); }
  function docSettings(){ return db.collection("stores").doc(STORE_ID).collection("settings").doc("pies"); }
  function colShifts(){ return db.collection("stores").doc(STORE_ID).collection("shifts"); }

  // --- Start/Stop subscriptions ---
  function startSubscriptions(){
    if (!db) return;
    // Items in real-time
    if (!unsubItems){
      unsubItems = colItems().orderBy("cat").onSnapshot((snap)=>{
        const list=[];
        snap.forEach(d=> list.push({ id: d.id, ...d.data() }));
        // mirror to localStorage (for offline and for your current code flow)
        localMirrorSet(STORAGE_KEY, list);
        // Try to update global "items" and repaint
        safe(()=> { window.items = list; });
        repaint();
      });
    }
    // Settings (pies names/status) in real-time
    if (!unsubSettings){
      unsubSettings = docSettings().onSnapshot((doc)=>{
        const data = doc.exists ? doc.data() : {};
        const names  = data.names  || {};
        const status = data.status || {};
        localMirrorSet(PIE_NAMES_KEY, names);
        localMirrorSet(PIE_STATUS_KEY, status);
        repaint(); // names/status change can rename tasks
      });
    }
    // Runtime (lang) in real-time
    if (!unsubRuntime){
      unsubRuntime = docRuntime().onSnapshot((doc)=>{
        const data = doc.exists ? doc.data() : {};
        const lang = data.lang || localStorage.getItem(LANG_KEY) || "es";
        localMirrorSet(LANG_KEY, lang);
        // If app exposes applyLanguage, call it; else try common fallbacks
        safe(()=> {
          if (typeof window.applyLanguage === "function") window.applyLanguage(lang);
          if (typeof window.renderItems === "function") window.renderItems();
          if (typeof window.updateStatus === "function") window.updateStatus();
          const langBtn = document.getElementById("btnLang");
          if (langBtn) langBtn.textContent = lang === "en" ? "🌐 ESPAÑOL" : "🌐 ENGLISH";
        });
      });
    }
  }
  function stopSubscriptions(){
    if (unsubItems) { unsubItems(); unsubItems=null; }
    if (unsubSettings) { unsubSettings(); unsubSettings=null; }
    if (unsubRuntime) { unsubRuntime(); unsubRuntime=null; }
  }

  // --- Mirror localStorage but also notify app if needed ---
  function localMirrorSet(k, v){
    try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){}
  }

  // --- Cloud writes ---
  async function cloudReplaceAllItems(list){
    // Use a batch to upsert all items by id
    const batch = db.batch();
    list.forEach((it)=>{
      const id = it.id || (it.text || "item").toLowerCase().replace(/\s+/g,"-")+"-"+Math.random().toString(36).slice(2,7);
      const ref = colItems().doc(id);
      batch.set(ref, {
        ...it,
        id,
        storeId: STORE_ID,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    await batch.commit();
  }
  async function cloudUpsertItem(it){
    const id = it.id || (it.text || "item").toLowerCase().replace(/\s+/g,"-")+"-"+Math.random().toString(36).slice(2,7);
    await colItems().doc(id).set({
      ...it,
      id,
      storeId: STORE_ID,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
  async function cloudDeleteItem(id){
    await colItems().doc(id).delete();
  }
  async function cloudAppendShift(record){
    await colShifts().add({
      ...record,
      storeId: STORE_ID,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
  async function cloudSetLang(lang){
    await docRuntime().set({ lang, storeId: STORE_ID, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
  async function cloudSetPieNames(names){
    await docSettings().set({ names, storeId: STORE_ID, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
  async function cloudSetPieStatus(status){
    await docSettings().set({ status, storeId: STORE_ID, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  // --- Paint helper (safe) ---
  function repaint(){
    safe(()=> { if (typeof window.renderItems === "function") window.renderItems(); });
    safe(()=> { if (typeof window.updateStatus === "function") window.updateStatus(); });
  }

  // --- Intercept localStorage.setItem to sync writes to cloud ---
  const _origSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value){
    _origSetItem(key, value);
    safe(async ()=>{
      if (!db || !auth || !auth.currentUser) return; // require login to write cloud
      if (key === STORAGE_KEY){
        const list = JSON.parse(value || "[]");
        await cloudReplaceAllItems(Array.isArray(list) ? list : []);
      }
      if (key === LANG_KEY){
        const lang = (value||"").replace(/^"|"$/g,""); // handle JSON string quotes
        await cloudSetLang(lang || "es");
      }
      if (key === PIE_NAMES_KEY){
        await cloudSetPieNames(JSON.parse(value || "{}") || {});
      }
      if (key === PIE_STATUS_KEY){
        await cloudSetPieStatus(JSON.parse(value || "{}") || {});
      }
      if (key === SHIFT_HISTORY_KEY){
        const hist = JSON.parse(value || "[]");
        // append the last record only (avoid duplicating entire history)
        const last = Array.isArray(hist) && hist.length ? hist[hist.length-1] : null;
        if (last) await cloudAppendShift(last);
      }
    });
  };

  // --- Global helpers to integrate with existing UI ---
  function bindUI(){
    // 1) Language button -> push to cloud runtime
    on(document.getElementById("btnLang"), "click", ()=>{
      const lang = (localStorage.getItem(LANG_KEY) || '"es"').replace(/^"|"$/g,"");
      const next = lang === "es" ? "en" : "es";
      // local write triggers cloud via interceptor
      localStorage.setItem(LANG_KEY, JSON.stringify(next));
    });

    // 2) Checkbox item toggles -> upsert item to cloud
    document.addEventListener("change", (e)=>{
      const t = e.target;
      if (t && t.matches('input[type="checkbox"][data-id]')){
        const id = t.dataset.id;
        const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
        const it = list.find(x=>x.id===id);
        if (it){
          it.done = !!t.checked;
          it.timestamp = Date.now();
          // Mirror locally (triggers cloud batch via setItem)
          localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
          // Also single upsert (faster feedback on slow devices)
          safe(()=> cloudUpsertItem(it));
        }
      }
    }, true);

    // 3) Delete item buttons with class .trash [data-id]
    document.addEventListener("click", (e)=>{
      const btn = e.target.closest && e.target.closest(".trash");
      if (btn && btn.dataset.id){
        const id = btn.dataset.id;
        safe(()=> cloudDeleteItem(id));
      }
    }, true);

    // 4) Owner/Admin login panels -> use Firebase Auth (email/pass)
    if (exists("btnOwnerLogin")){
      on(document.getElementById("btnOwnerLogin"), "click", async ()=>{
        const email = (document.getElementById("ownerUser").value || "").trim();
        const pass  = (document.getElementById("ownerPass").value || "").trim();
        try {
          await firebase.auth().signInWithEmailAndPassword(email, pass);
          toast("✅ Owner conectado (Firebase)", "success");
        } catch(e){
          toast("❌ Error al iniciar sesión Owner: "+(e.message||e.code), "error");
        }
      });
    }
    if (exists("btnAdminInline") && exists("btnLogin")){
      on(document.getElementById("btnLogin"), "click", async ()=>{
        const email = (document.getElementById("adminUser").value || "").trim();
        const pass  = (document.getElementById("adminPass").value || "").trim();
        try {
          await firebase.auth().signInWithEmailAndPassword(email, pass);
          toast("✅ Admin conectado (Firebase)", "success");
        } catch(e){
          toast("❌ Error al iniciar sesión Admin: "+(e.message||e.code), "error");
        }
      });
    }
    if (exists("btnLogout")){
      on(document.getElementById("btnLogout"), "click", async ()=>{
        try { await firebase.auth().signOut(); toast("👋 Sesión cerrada", "success"); }
        catch(e){ toast("⚠️ No se pudo cerrar sesión: "+(e.message||e.code), "error"); }
      });
    }
    if (exists("btnOwnerLogout")){
      on(document.getElementById("btnOwnerLogout"), "click", async ()=>{
        try { await firebase.auth().signOut(); toast("👋 Sesión cerrada (Owner)", "success"); }
        catch(e){ toast("⚠️ No se pudo cerrar sesión: "+(e.message||e.code), "error"); }
      });
    }
  }

  // Expose minimal API
  window.Cloud = {
    init: initFirebase,
    setLangRemote: (l)=> db ? cloudSetLang(l) : null,
    upsertItem: (it)=> db ? cloudUpsertItem(it) : null,
    replaceAll: (list)=> db ? cloudReplaceAllItems(list) : null
  };

  // Bootstrap after DOM
  document.addEventListener("DOMContentLoaded", function(){
    bindUI();
    safe(initFirebase);
  });

})();
