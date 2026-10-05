/* Standby console. Plain JS over the API: status and hours are computed
   server side; this file reads them out and keeps the ticked actions. */
(function () {
  "use strict";
  var view = document.getElementById("view");
  var sw = document.getElementById("hh-switch");
  var runBtn = document.getElementById("run-btn");

  var S = { meta: null, examples: [], custom: [], packs: {}, current: null, events: {}, running: false };

  /* ---- storage ---------------------------------------------------------- */
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var ticks = load("standby.ticks", {});

  /* ---- helpers ---------------------------------------------------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(n) { return Number(n).toLocaleString("en-US"); }
  function h(x) { return (Math.round(x * 10) / 10) + " h"; }
  function getJSON(p) {
    return fetch(p, { headers: { Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("The server answered " + r.status + " for " + p);
      return r.json();
    });
  }
  function postJSON(p, body) {
    return fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : "That household could not be checked.");
        return j;
      });
    });
  }

  var ICONS = {
    oxygen: '<path d="M8 2.5c-2.2 2.8-3.6 4.6-3.6 6.5a3.6 3.6 0 0 0 7.2 0C11.6 7.1 10.2 5.3 8 2.5z"/>',
    vent: '<path d="M8 2v6"/><path d="M8 8c-1.2-1.6-3.2-2-4.4-1-1.4 1.2-1.4 4 .3 5.6 1.4 1.3 3 1.4 4.1.4"/><path d="M8 8c1.2-1.6 3.2-2 4.4-1 1.4 1.2 1.4 4-.3 5.6-1.4 1.3-3 1.4-4.1.4"/>',
    sleep: '<path d="M12.6 9.6A5.2 5.2 0 0 1 6.4 3.4a5.2 5.2 0 1 0 6.2 6.2z"/>',
    cold: '<path d="M8 1.8v12.4M2.6 4.9l10.8 6.2M2.6 11.1l10.8-6.2"/>',
    power: '<path d="M9 1.5 3.5 9H7l-1 5.5L12.5 7H9z"/>',
    missing: '<path d="M8 3v10M3 8h10"/>'
  };
  function icon(kind) {
    return '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[kind] || ICONS.power) + "</svg>";
  }
  var WORD = { ready: "Covered", short: "Short", gap: "Gap", check: "Check" };
  function grade(it) {
    var why = "";
    if (it.status === "short") why = h(it.plan_h) + " planned of " + h(it.need_h);
    else if (it.status === "gap") why = it.device === "generator" ? "unsafe where it runs" : "no backup";
    else if (it.status === "check") why = it.via_generator ? "generator, fuel not recorded" : "hours not recorded";
    else why = h(it.plan_h) + " planned";
    return '<p class="grade big" data-grade="' + it.status + '"><span class="dot"></span><strong>' + WORD[it.status] + '</strong><span class="why">' + esc(why) + "</span></p>";
  }
  function tallyHTML(t) {
    var parts = [];
    [["ready", "covered"], ["short", "short"], ["gap", "with a gap"], ["check", "to check"]].forEach(function (k) {
      if (t[k[0]]) parts.push('<p class="grade" data-grade="' + k[0] + '"><span class="dot"></span>' + t[k[0]] + " " + k[1] + "</p>");
    });
    return parts.join("");
  }

  /* ---- state ------------------------------------------------------------ */
  function allHouseholds() { return S.examples.map(function (e) { return { id: e.id, name: e.name }; }).concat(S.custom.map(function (c) { return { id: c.id, name: c.name }; })); }
  function fillSwitch() {
    sw.innerHTML = allHouseholds().map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + "</option>"; }).join("");
    sw.value = S.current;
  }
  function getPack(id) {
    if (S.packs[id]) return Promise.resolve(S.packs[id]);
    var c = S.custom.filter(function (x) { return x.id === id; })[0];
    if (c) { S.packs[id] = c.pack; return Promise.resolve(c.pack); }
    return getJSON("/api/pack/" + encodeURIComponent(id)).then(function (p) { S.packs[id] = p; return p; });
  }
  function inputFor(id) {
    var e = S.examples.filter(function (x) { return x.id === id; })[0];
    if (e) return e.input;
    var c = S.custom.filter(function (x) { return x.id === id; })[0];
    return c ? c.input : null;
  }
  function event(key) {
    if (S.events[key]) return Promise.resolve(S.events[key]);
    return getJSON("/api/events/" + key).then(function (e) { S.events[key] = e; return e; });
  }

  function railProgress(p) {
    var total = 0, done = 0;
    if (p) p.people.forEach(function (pe) { pe.items.forEach(function (it) { (it.actions || []).forEach(function (_, i) { total++; if (ticks[p.household.id + "/" + it.id + "/" + i]) done++; }); }); });
    document.getElementById("rail-count").textContent = done + " of " + total;
    document.getElementById("rail-bar-fill").style.width = total ? Math.round(100 * done / total) + "%" : "0";
  }

  /* ---- pack view -------------------------------------------------------- */
  function itemHTML(p, it) {
    var hid = p.household.id;
    var acts = (it.actions || []).map(function (a, i) {
      var k = hid + "/" + it.id + "/" + i;
      return '<li><label><input type="checkbox" data-k="' + esc(k) + '"' + (ticks[k] ? " checked" : "") + "><span>" + esc(a) + "</span></label></li>";
    }).join("");
    var plan = it.plan_h ? '<span class="fine">Planned on half the manual figure: ' + h(it.plan_h) + ".</span>" : "";
    return '<article class="entry" id="item-' + it.id + '">' +
      '<div class="entry-head"><span class="tile" data-kind="' + it.kind + '">' + icon(it.kind) + "</span>" +
      '<div class="entry-head-text"><h3>' + esc(it.label) + '</h3><div class="entry-line"><span>' + esc(it.role) + "</span>" +
      (it.option_label ? '<span class="sep">' + esc(it.option_label) + "</span>" : "") + "</div>" + grade(it) + "</div></div>" +
      '<dl class="fields">' +
      "<dt>Backup</dt><dd>" + esc(it.cover) + plan + "</dd>" +
      (it.requirement ? "<dt>Needs</dt><dd>" + esc(it.requirement) + "</dd>" : "") +
      (it.gap ? "<dt>Gap</dt><dd>" + esc(it.gap) + "</dd>" : "") +
      (acts ? '<dt>Before the power goes</dt><dd><ul class="checklist">' + acts + "</ul></dd>" : "") +
      "<dt>Source</dt><dd class=\"quiet\">" + esc(it.source) + "</dd>" +
      "</dl></article>";
  }

  function packHTML(p) {
    var hh = p.household, ev = p.event, em = p.empower, t = p.tally;
    var nDev = 0; p.people.forEach(function (x) { nDev += x.items.length; });
    var itemMap = {};
    p.people.forEach(function (x) { x.items.forEach(function (i) { itemMap[i.id] = i; }); });
    var prio = (p.priority || []).map(function (x) {
      var it = itemMap[x.item_id];
      return "<li><span>" + esc(x.text) + "</span>" + (it ? '<a href="#item-' + it.id + '" data-jump="' + it.id + '">' + esc(it.label) + "</a>" : "<span></span>") + "</li>";
    }).join("");
    var hero =
      '<section class="pack-head"><span class="label pack-kicker">Readiness pack</span><h1>' + esc(hh.name) + "</h1>" +
      '<p class="pack-standing">' + esc(p.headline) + "</p>" +
      '<dl class="pack-meta">' +
      "<dt>Area</dt><dd>" + esc(hh.place_label) + (hh.zip ? " · " + esc(hh.zip) : "") + "</dd>" +
      "<dt>Planned against</dt><dd>" + esc(ev.name) + "</dd>" +
      "<dt>County outage record</dt><dd>" + ev.hours_over_10pct + " h with 10% or more dark</dd>" +
      "<dt>People · devices</dt><dd>" + p.people.length + " · " + nDev + "</dd>" +
      "<dt>Powered-equipment users</dt><dd>" + fmt(em.power) + " Medicare" + (em.scope === "zip" ? " in ZIP " + esc(em.zip) : " in " + esc(em.name) + " Co.") + "</dd></dl>" +
      '<div class="pack-tally">' + tallyHTML(t) + "</div>" +
      '<p class="pack-actions"><button class="button" type="button" id="print-btn">Print this pack</button></p></section>';
    var stand = prio ?
      '<section class="standout"><p class="standout-flag"><svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14V2.5"/><path d="M3 3h9l-2 3 2 3H3"/></svg>Do first</p>' +
      '<div class="pack-section-head"><h2>Before the power goes</h2></div>' +
      (p.decision ? '<p class="decision">' + esc(p.decision) + "</p>" : "") + '<ol class="prio">' + prio + "</ol></section>" : "";
    var people = p.people.map(function (pe) {
      return '<div class="person-head"><h2>' + esc(pe.name) + '</h2><span class="quiet">' + pe.items.length + (pe.items.length === 1 ? " device" : " devices") + "</span></div>" + pe.items.map(function (it) { return itemHTML(p, it); }).join("");
    }).join("");
    var miss = (p.missing || []).length ?
      '<div class="person-head"><h2>Not on the list</h2></div>' + p.missing.map(function (m) {
        return '<article class="entry"><div class="entry-head"><span class="tile" data-kind="missing">' + icon("missing") + '</span><div class="entry-head-text"><h3>' + esc(m.device) + '</h3><p class="grade big" data-grade="gap"><span class="dot"></span><strong>Gap</strong><span class="why">not on the household list</span></p></div></div><dl class="fields"><dt>Why</dt><dd>' + esc(m.why) + "</dd>" + (m.action ? "<dt>Do</dt><dd>" + esc(m.action) + "</dd>" : "") + "</dl></article>";
      }).join("") : "";
    return hero + stand + people + miss;
  }

  function showPack() {
    view.innerHTML = '<p class="loading">Loading the pack.</p>';
    getPack(S.current).then(function (p) {
      view.innerHTML = packHTML(p);
      railProgress(p);
      var pb = document.getElementById("print-btn");
      if (pb) pb.onclick = function () { window.print(); };
    }).catch(fail);
  }

  view.addEventListener("change", function (e) {
    var k = e.target && e.target.getAttribute && e.target.getAttribute("data-k");
    if (!k) return;
    if (e.target.checked) ticks[k] = 1; else delete ticks[k];
    save("standby.ticks", ticks);
    railProgress(S.packs[S.current]);
  });
  view.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-jump]");
    if (a) { e.preventDefault(); var el = document.getElementById("item-" + a.getAttribute("data-jump")); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
  });

  function fail(err) {
    view.innerHTML = '<div class="fetch-error"><p>' + esc(err.message) + "</p></div>";
  }

  /* ---- households view + builder --------------------------------------- */
  var form = null;
  function newForm() { return { name: "", place: "broward", people: [{ name: "", devices: [{ device: "inogen_g5", opt: "1" }] }], err: "" }; }
  function devSpec(id) { return S.meta.catalogue.filter(function (c) { return c.id === id; })[0]; }
  function defaultOpt(id) { return devSpec(id).option.choices[0][0]; }

  function cardsHTML() {
    var cards = S.examples.map(function (e) { return cardHTML(e.id, e.name, e.place_label, e.event, e.tally, e.people); });
    S.custom.forEach(function (c) { cardHTML; cards.push(cardHTML(c.id, c.name, c.pack.household.place_label, c.pack.event.name, c.pack.tally, c.pack.people.map(function (x) { return x.name; }))); });
    return '<ul class="call-list">' + cards.join("") + "</ul>";
  }
  function cardHTML(id, name, place, evn, t, people) {
    return '<li><a class="call-row hh-card" href="#/pack" data-pick="' + esc(id) + '"' + (id === S.current ? ' aria-current="true"' : "") + '><span class="tile" data-kind="power">' + icon("power") + '</span><span class="call-row-text"><span class="call-row-name">' + esc(name) + '</span><span class="call-row-sub">' + esc(place) + " · " + esc(evn) + " record</span></span><span class=\"hh-tally\">" + tallyHTML(t) + '</span><span class="call-row-sub">' + esc(people.join(", ")) + "</span></a></li>";
  }

  function formHTML() {
    var f = form;
    var places = S.meta.places.map(function (p) { return '<option value="' + p.id + '"' + (f.place === p.id ? " selected" : "") + ">" + esc(p.label) + "</option>"; }).join("");
    var ppl = f.people.map(function (pe, pi) {
      var devs = pe.devices.map(function (d, di) {
        var spec = devSpec(d.device);
        var dopts = S.meta.catalogue.map(function (c) { return '<option value="' + c.id + '"' + (c.id === d.device ? " selected" : "") + ">" + esc(c.label) + " (" + esc(c.role.toLowerCase()) + ")</option>"; }).join("");
        var oopts = spec.option.choices.map(function (c) { return '<option value="' + esc(c[0]) + '"' + (c[0] === d.opt ? " selected" : "") + ">" + esc(c[1]) + "</option>"; }).join("");
        return '<div class="fdev"><div><label class="f" for="d' + pi + "_" + di + '">Device</label><select id="d' + pi + "_" + di + '" data-f="device" data-p="' + pi + '" data-d="' + di + '">' + dopts + '</select></div><div><label class="f" for="o' + pi + "_" + di + '">' + esc(spec.option.label) + '</label><select id="o' + pi + "_" + di + '" data-f="opt" data-p="' + pi + '" data-d="' + di + '">' + oopts + "</select></div>" +
          (pe.devices.length > 1 ? '<button class="x" type="button" data-rm-dev="' + pi + "," + di + '" aria-label="Remove device">Remove</button>' : "<span></span>") + "</div>";
      }).join("");
      return '<div class="fperson"><div class="fperson-head"><div><label class="f" for="pn' + pi + '">Person</label><input type="text" id="pn' + pi + '" data-f="pname" data-p="' + pi + '" value="' + esc(pe.name) + '" maxlength="40" placeholder="First name"></div>' +
        (f.people.length > 1 ? '<button class="x" type="button" data-rm-person="' + pi + '">Remove</button>' : "<span></span>") + "</div>" + devs +
        '<div><button class="button" type="button" data-add-dev="' + pi + '"' + (pe.devices.length >= 6 ? " disabled" : "") + ">Add a device</button></div></div>";
    }).join("");
    return '<form class="form" id="hh-form" novalidate><div class="form-row"><div><label class="f" for="fn">Household</label><input type="text" id="fn" data-f="name" value="' + esc(f.name) + '" maxlength="60" placeholder="Name this household"></div><div><label class="f" for="fp">Area</label><select id="fp" data-f="place">' + places + "</select></div></div>" +
      ppl + '<div class="form-actions"><button class="button" type="button" id="add-person"' + (f.people.length >= 4 ? " disabled" : "") + '>Add a person</button><button class="button solid" type="submit" id="form-run">Run it</button>' + (f.err ? '<p class="err" role="alert">' + esc(f.err) + "</p>" : "") + "</div></form>";
  }

  function showHouseholds() {
    if (!form) form = newForm();
    view.innerHTML = '<div class="page-head"><h1>Households</h1></div>' + cardsHTML() +
      '<h2 class="label">New household</h2><div id="form-host">' + formHTML() + "</div>";
    bindForm();
  }
  function redrawForm() { var host = document.getElementById("form-host"); if (host) { host.innerHTML = formHTML(); bindForm(); } }

  function bindForm() {
    var el = document.getElementById("hh-form");
    if (!el) return;
    el.addEventListener("change", function (e) {
      var t = e.target, f = t.getAttribute("data-f");
      if (!f) return;
      var p = +t.getAttribute("data-p"), d = +t.getAttribute("data-d");
      if (f === "name") form.name = t.value;
      else if (f === "place") form.place = t.value;
      else if (f === "pname") form.people[p].name = t.value;
      else if (f === "device") { form.people[p].devices[d] = { device: t.value, opt: defaultOpt(t.value) }; redrawForm(); }
      else if (f === "opt") form.people[p].devices[d].opt = t.value;
    });
    el.addEventListener("input", function (e) {
      var f = e.target.getAttribute("data-f");
      if (f === "name") form.name = e.target.value;
      if (f === "pname") form.people[+e.target.getAttribute("data-p")].name = e.target.value;
    });
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.id === "add-person") { form.people.push({ name: "", devices: [{ device: "inogen_g5", opt: "1" }] }); redrawForm(); }
      if (b.hasAttribute("data-add-dev")) { form.people[+b.getAttribute("data-add-dev")].devices.push({ device: "airsense", opt: defaultOpt("airsense") }); redrawForm(); }
      if (b.hasAttribute("data-rm-dev")) { var q = b.getAttribute("data-rm-dev").split(","); form.people[+q[0]].devices.splice(+q[1], 1); redrawForm(); }
      if (b.hasAttribute("data-rm-person")) { form.people.splice(+b.getAttribute("data-rm-person"), 1); redrawForm(); }
    });
    el.addEventListener("submit", function (e) {
      e.preventDefault();
      var body = {
        id: "c" + Date.now(), name: form.name.trim(), place: form.place,
        people: form.people.map(function (pe) { return { name: pe.name.trim(), devices: pe.devices.map(function (d) { var s = devSpec(d.device); var o = {}; o[s.option.key] = d.opt; return { device: d.device, opts: o }; }) }; })
      };
      if (!body.name) { form.err = "Name the household."; return redrawForm(); }
      if (body.people.some(function (p) { return !p.name; })) { form.err = "Give each person a name."; return redrawForm(); }
      form.err = "";
      var btn = document.getElementById("form-run");
      btn.disabled = true; btn.textContent = "Running";
      postJSON("/api/run", body).then(function (pack) {
        S.custom.push({ id: body.id, name: body.name, input: body, pack: pack });
        save("standby.custom", S.custom);
        S.packs[body.id] = pack; S.current = body.id; save("standby.current", S.current);
        form = null; fillSwitch(); location.hash = "#/pack"; route();
      }).catch(function (err) { form.err = err.message; redrawForm(); });
    });
  }
  view.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-pick]");
    if (a) { S.current = a.getAttribute("data-pick"); save("standby.current", S.current); sw.value = S.current; }
  });

  /* ---- outage record --------------------------------------------------- */
  var IMG = {
    irma: { src: "/img/irma.jpg", alt: "Florida at night from orbit, before and after Hurricane Irma", cap: "Florida at night, 11 May and 12 September 2017. NASA/NOAA, public domain." },
    uri: { src: "/img/uri.gif", alt: "Night lights across Texas on 17 February 2021, with outage areas dark", cap: "Power outages across Texas, 17 February 2021. NOAA-20, public domain." },
    beryl: { src: "/img/beryl.gif", alt: "Night lights across East Texas on 15 July 2024, with outage areas dark", cap: "Power outages in East Texas, 15 July 2024. NOAA, public domain." }
  };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function day(d) { return d.getUTCDate() + " " + MON[d.getUTCMonth()]; }

  function chart(ev) {
    var W = 880, H = 300, L = 46, R = 16, T = 14, B = 52, w = W - L - R, hh = H - T - B;
    var pts = ev.curve.map(function (c) { return [Date.parse(c[0] + "Z"), c[1] / ev.total_customers]; });
    var t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    function X(t) { return L + (t - t0) / (t1 - t0) * w; }
    function Y(v) { return T + (1 - Math.min(v, 1)) * hh; }
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1); }).join("");
    var area = line + "L" + X(t1).toFixed(1) + " " + Y(0) + "L" + X(t0).toFixed(1) + " " + Y(0) + "Z";
    var g = "";
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="#ececec"/><text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + Math.round(v * 100) + "%</text>"; });
    var step = Math.ceil((t1 - t0) / 864e5 / 7) * 864e5, d0 = new Date(t0); d0.setUTCHours(0, 0, 0, 0);
    for (var t = d0.getTime() + 864e5; t < t1; t += step) g += '<text x="' + X(t).toFixed(1) + '" y="' + (T + hh + 18) + '" text-anchor="middle">' + day(new Date(t)) + "</text>";
    var ticks = "";
    ev.notices.forEach(function (n) { var t = Date.parse(n.utc + "Z"); if (t >= t0 && t <= t1) ticks += '<line x1="' + X(t).toFixed(1) + '" x2="' + X(t).toFixed(1) + '" y1="' + (T + hh + 26) + '" y2="' + (T + hh + 38) + '" stroke="#4a5f7a" stroke-width="1.5"/>'; });
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Share of county customers without power over time, with the dates of National Weather Service statements">' + g +
      '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(0.1) + '" y2="' + Y(0.1) + '" stroke="#a03a2e" stroke-dasharray="4 4"/>' +
      '<path d="' + area + '" fill="#ff4f00" fill-opacity=".12"/><path d="' + line + '" fill="none" stroke="#ff4f00" stroke-width="1.8" stroke-linejoin="round"/>' + ticks + "</svg>" +
      '<p class="legend"><span><i style="background:#ff4f00;height:2px"></i>Customers without power</span><span><i style="background:#a03a2e"></i>10% of customers</span><span><i style="background:#4a5f7a;height:8px;width:2px"></i>National Weather Service statement</span></p>';
  }

  function showRecord() {
    view.innerHTML = '<p class="loading">Loading the record.</p>';
    getPack(S.current).then(function (p) {
      return event(p.event.key).then(function (ev) {
        var seen = {}, rows = ev.notices.filter(function (n) { if (seen[n.headline]) return false; seen[n.headline] = 1; return true; }).map(function (n) {
          return '<li class="turn"><span class="turn-at">' + esc(n.local) + '</span><span class="turn-text">' + esc(n.headline) + "</span></li>";
        }).join("");
        var im = IMG[ev.key];
        view.innerHTML =
          '<div class="page-head"><span class="label">' + esc(ev.county) + " County, " + ev.state + "</span><h1>" + esc(ev.name) + '</h1></div>' +
          '<dl class="pack-meta"><dt>Customers in county</dt><dd>' + fmt(ev.total_customers) + "</dd><dt>Peak without power</dt><dd>" + fmt(ev.peak) + " (" + ev.peak_pct + "%)</dd><dt>Three days after peak</dt><dd>" + fmt(ev.out_72h_after_peak) + " (" + ev.pct_72h + "%)</dd><dt>Hours at 10% or more</dt><dd>" + ev.hours_over_10pct + " h</dd></dl>" +
          '<div class="section">' + chart(ev) + "</div>" +
          '<div class="section"><span class="label">What it cost</span><p class="harm">' + esc(p.event.harm) + "</p></div>" +
          '<div class="section"><figure class="figure"><img src="' + im.src + '" alt="' + esc(im.alt) + '"><figcaption>' + esc(im.cap) + "</figcaption></figure></div>" +
          '<div class="section"><span class="label">National Weather Service statements</span><ul class="transcript">' + rows + "</ul></div>";
      });
    }).catch(fail);
  }

  /* ---- run it ----------------------------------------------------------- */
  runBtn.addEventListener("click", function () {
    if (S.running) return;
    var inp = inputFor(S.current);
    if (!inp) return;
    S.running = true; runBtn.disabled = true;
    runBtn.querySelector("span").textContent = "Running";
    var body = JSON.parse(JSON.stringify(inp));
    postJSON("/api/run", body).then(function (pack) {
      S.packs[S.current] = pack;
      var c = S.custom.filter(function (x) { return x.id === S.current; })[0];
      if (c) { c.pack = pack; save("standby.custom", S.custom); }
      location.hash = "#/pack"; route();
    }).catch(function (err) {
      view.insertAdjacentHTML("afterbegin", '<div class="fetch-error" role="alert"><p>' + esc(err.message) + "</p></div>");
    }).then(function () { S.running = false; runBtn.disabled = false; runBtn.querySelector("span").textContent = "Run it"; });
  });

  sw.addEventListener("change", function () { S.current = sw.value; save("standby.current", S.current); route(); });

  /* ---- routing ---------------------------------------------------------- */
  function route() {
    var v = (location.hash.replace(/^#\//, "").split("/")[0]) || "pack";
    if (["pack", "households", "record"].indexOf(v) < 0) v = "pack";
    Array.prototype.forEach.call(document.querySelectorAll(".nav-link"), function (a) {
      if (a.getAttribute("data-view") === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    sw.disabled = false;
    if (v === "pack") showPack(); else if (v === "households") showHouseholds(); else showRecord();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  Promise.all([getJSON("/api/meta"), getJSON("/api/households")]).then(function (r) {
    S.meta = r[0]; S.examples = r[1];
    S.custom = load("standby.custom", []);
    S.custom.forEach(function (c) { S.packs[c.id] = c.pack; });
    S.current = load("standby.current", S.examples[0].id);
    if (!allHouseholds().some(function (x) { return x.id === S.current; })) S.current = S.examples[0].id;
    fillSwitch(); route();
  }).catch(fail);
})();
