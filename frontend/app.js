"use strict";
/*
 * Browser-only static frontend for Prada Customer Feedback Intelligence.
 * Cognito managed login uses Authorization Code + PKCE (no AWS credentials).
 * Tokens remain in memory; reloads require a new sign-in.
 */
const cfg = window.PRADA_CONFIG || {};
const $ = (id) => document.getElementById(id);
let rows = [];
let result = null;
let idToken = null;
let analysisElapsed = null;
let busy = false;
const THEME_ACTIONS = Object.freeze({
  "Delivery": "Investigate order fulfillment timelines and tracking update reliability in the affected market(s).",
  "Product Quality": "Review product-quality cases and determine whether they share product or batch characteristics.",
  "Customer Service": "Audit support response quality and identify opportunities to clarify escalation procedures.",
  "Packaging": "Review packaging-related feedback and check whether complaints cluster by product or market.",
  "Other": "Read the referenced comments individually and determine whether a new issue category is warranted."
});
const sentimentOrder = ["negative", "neutral", "positive"];
const DISPLAY_LIMIT = 20;

function showStatus(message, error = false) {
  const el = $("statusMessage");
  el.hidden = !message;
  el.textContent = message;
  el.classList.toggle("error", error);
}
function isConfigured() {
  return /^https:\/\//.test(cfg.cognitoDomain || "") && !cfg.cognitoDomain.includes("YOUR_")
    && cfg.clientId && !cfg.clientId.includes("REPLACE") && /^https:\/\//.test(cfg.redirectUri || "")
    && !cfg.redirectUri.includes("YOUR_") && /^https:\/\//.test(cfg.apiUrl || "");
}
function makeRandomBase64Url(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function authUrl(endpoint) {
  return `${cfg.cognitoDomain.replace(/\/$/, "")}${endpoint}`;
}
async function startLogin() {
  if (!isConfigured()) { showStatus("Configure Cognito domain, app client ID and callback URL in config.js first.", true); return; }
  const verifier = makeRandomBase64Url(64);
  const state = makeRandomBase64Url();
  sessionStorage.setItem("prada_pkce_verifier", verifier);
  sessionStorage.setItem("prada_oauth_state", state);
  const query = new URLSearchParams({
    response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: "openid email", code_challenge_method: "S256", code_challenge: await pkceChallenge(verifier), state
  });
  location.assign(`${authUrl("/oauth2/authorize")}?${query}`);
}
async function handleCallback() {
  const params = new URLSearchParams(location.search);
  if (params.has("error")) {
    showStatus(`Sign-in failed: ${params.get("error_description") || params.get("error")}`, true);
    history.replaceState({}, "", location.pathname);
    return;
  }
  const code = params.get("code");
  if (!code) return;
  const state = sessionStorage.getItem("prada_oauth_state");
  const verifier = sessionStorage.getItem("prada_pkce_verifier");
  history.replaceState({}, "", location.pathname); // Remove one-time auth code immediately
  sessionStorage.removeItem("prada_oauth_state");
  sessionStorage.removeItem("prada_pkce_verifier");
  if (!state || params.get("state") !== state || !verifier) {
    showStatus("Invalid authentication state. Please sign in again.", true);
    return;
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code", client_id: cfg.clientId, code,
    code_verifier: verifier, redirect_uri: cfg.redirectUri
  });
  try {
    const response = await fetch(authUrl("/oauth2/token"), {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString()
    });
    if (!response.ok) throw new Error(`Cognito token exchange failed (${response.status})`);
    const tokens = await response.json();
    if (typeof tokens.id_token !== "string") throw new Error("Cognito returned no ID token");
    idToken = tokens.id_token;
    updateAuth();
    showStatus("Signed in. You can now analyze feedback securely.");
  } catch (error) {
    showStatus(`${error.message}. Verify client type, callback URL and PKCE settings.`, true);
  }
}
function updateAuth() {
  $("authStatus").textContent = idToken ? "Signed in" : "Not signed in";
  $("loginBtn").hidden = Boolean(idToken);
  $("logoutBtn").hidden = !idToken;
}
function logout() {
  idToken = null;
  updateAuth();
  if (!isConfigured()) return;
  const query = new URLSearchParams({client_id: cfg.clientId, logout_uri: cfg.redirectUri});
  location.assign(`${authUrl("/logout")}?${query}`);
}

// Minimal RFC 4180-style parser with quote escaping, embedded commas and line breaks.
function parseCsv(text) {
  const records = [];
  const cleaned = text.replace(/^\uFEFF/, "");
  let field = "", fields = [], quoted = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"') {
      if (quoted && cleaned[i+1] === '"') { field += '"'; i++; }
      else if (quoted) quoted = false;
      else if (field === "") quoted = true;
      else throw new Error("Invalid quote in CSV");
    } else if (ch === "," && !quoted) { fields.push(field); field = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && cleaned[i+1] === "\n") i++;
      fields.push(field); field = "";
      if (fields.some(v => v.trim())) records.push(fields);
      fields = [];
    } else { field += ch; }
  }
  if (quoted) throw new Error("Unterminated quoted field in CSV");
  fields.push(field);
  if (fields.some(v => v.trim())) records.push(fields);
  if (records.length < 2) throw new Error("CSV must have a header and at least one row");
  const headers = records.shift().map(v => v.trim().toLowerCase());
  const fidIndex = headers.indexOf("feedback_id"), commentIndex = headers.indexOf("comment");
  if (fidIndex < 0 || commentIndex < 0) throw new Error("CSV must contain feedback_id and comment columns");
  const seen = new Set();
  if (records.length > DISPLAY_LIMIT) throw new Error(`Only ${DISPLAY_LIMIT} feedback records per analysis are supported by the current backend`);
  const data = records.map((cells, idx) => {
    if (cells.length !== headers.length) throw new Error(`CSV row ${idx + 2} has an unexpected number of columns`);
    const item = Object.fromEntries(headers.map((header, j) => [header, cells[j].trim()]));
    const id = item.feedback_id;
    if (!id || id.length > 50 || !item.comment || item.comment.length > 1000 || seen.has(id)) {
      throw new Error(`Invalid or duplicate feedback on CSV row ${idx+2}`);
    }
    seen.add(id);
    return item;
  });
  return data;
}
function loadRows(items, source) {
  rows = items;
  result = null;
  analysisElapsed = null;
  $("loadedCount").textContent = rows.length;
  $("analyzeBtn").disabled = !rows.length;
  $("importMessage").textContent = source;
  showStatus("");
  renderAll();
}
function renderAll() {
  renderMetrics(); renderSentiment(); renderIssues(); renderExecutiveSummary(); renderRecommendations(); renderMarkets(); renderCategories(); renderChannels(); renderRows();
}
function renderMetrics() {
  $("metricTotal").textContent = result ? result.classifications.length : "—";
  $("metricNegative").textContent = result ? result.classifications.filter(c => c.sentiment === "negative").length : "—";
  $("metricIssues").textContent = result ? result.recurring_issues.length : "—";
  $("metricLatency").textContent = analysisElapsed === null ? "—" : `${(analysisElapsed / 1000).toFixed(1)}s`;
  $("metricMode").textContent = result ? (result.mode === "bedrock" ? "AI analysis" : "Demo rules") : "Awaiting analysis";
}
function elem(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = String(text);
  return e;
}
function empty(container, text) { container.replaceChildren(elem("p", "empty", text)); }
function renderSentiment() {
  const holder = $("sentimentChart");
  if (!result) return empty(holder, "Run an analysis to see the sentiment distribution.");
  holder.replaceChildren();
  const counts = Object.fromEntries(sentimentOrder.map(s => [s, result.classifications.filter(c => c.sentiment === s).length]));
  const total = result.classifications.length;
  for (const type of sentimentOrder) {
    const line = elem("div", "sentiment-item");
    line.append(elem("span", "name", type[0].toUpperCase() + type.slice(1)));
    const track = elem("div", "track");
    const bar = elem("div", `bar ${type}`);
    bar.style.width = `${(counts[type] / total) * 100}%`;
    track.append(bar);
    line.append(track, elem("span", "count", `${counts[type]} · ${Math.round(counts[type] / total * 100)}%`));
    holder.append(line);
  }
}
function evidenceLinks(ids) {
  const holder = elem("div", "evidence-links");
  for (const id of ids) {
    const link = elem("a", "", id);
    link.href = `#feedback`;
    link.addEventListener("click", () => {
      $("filterSentiment").value = "all";
      renderRows();
      requestAnimationFrame(() => {
        const target = [...$("feedbackRows").children].find(row => row.dataset.feedbackId === id);
        if (target) { target.classList.add("evidence-target"); target.scrollIntoView({behavior:"smooth",block:"center"}); }
      });
    });
    holder.append(link);
  }
  return holder;
}
function renderIssues() {
  const holder = $("issuesList");
  if (!result) return empty(holder, "Repeated complaints and their supporting records will appear here.");
  if (!result.recurring_issues.length) return empty(holder, "No recurring negative issue detected in this batch. This does not prove there are no issues overall.");
  holder.replaceChildren();
  for (const issue of result.recurring_issues) {
    const card = elem("div", "issue"), head = elem("div", "issue-head");
    head.append(elem("strong", "", issue.theme), elem("span", "issue-count", `${issue.count} reports`));
    card.append(head, elem("p", "", "Evidence from the current sample"), evidenceLinks(issue.evidence_ids));
    holder.append(card);
  }
}
function renderExecutiveSummary() {
  const holder = $("executiveSummary");
  const badge = $("summaryMode");
  if (!result) {
    badge.textContent = "AWAITING ANALYSIS";
    return empty(holder, "Run an analysis to generate a briefing from your selected records.");
  }
  const briefing = result.executive_insights;
  if (!briefing || briefing.status === "unavailable" || !briefing.summary) {
    badge.textContent = briefing?.status === "unavailable" ? "TEMPORARILY UNAVAILABLE" : "NOT ENABLED";
    return empty(holder, "Classifications are available. Executive insights are not available for this analysis.");
  }
  badge.textContent = briefing.status === "generated" ? "AI-GENERATED · REVIEW" : "DEMO RULES";
  holder.replaceChildren(elem("p", "summary-text", briefing.summary));
  if (briefing.summary_evidence_ids?.length) holder.append(evidenceLinks(briefing.summary_evidence_ids));
  holder.append(elem("p", "summary-disclaimer", "Based only on this batch. Verify findings before making business decisions."));
}
function renderRecommendations() {
  const holder = $("recommendations");
  const badge = $("recommendMode");
  const hint = $("recommendHint");
  if (!result) {
    badge.textContent = "ANALYST REVIEW";
    hint.textContent = "Suggested investigations need human review. Findings do not establish root causes.";
    return empty(holder, "Run an analysis to generate evidence-linked actions.");
  }
  const insights = result.executive_insights;
  const aiRecommended = insights?.status === "generated";
  const suggestions = (aiRecommended || insights?.status === "mock") ? insights.recommendations : null;
  badge.textContent = aiRecommended ? "AI-GENERATED · REVIEW" : "RULE-BASED · REVIEW";
  hint.textContent = aiRecommended
    ? "AI-proposed investigations. Counts and evidence IDs are verified by application code; causes remain unproven."
    : "Suggested investigations use fixed rules on AI-classified themes. These are not AI-generated business decisions.";
  if (!result.recurring_issues.length) return empty(holder, "No recurring negative theme in this batch. Review individual records before concluding there is no issue.");
  holder.replaceChildren();
  (suggestions || result.recurring_issues).forEach((item, i) => {
    const block = elem("div", "recommendation");
    const theme = item.theme;
    block.append(elem("h3", "", `${String(i+1).padStart(2,"0")} / ${theme} · ${item.count} reports`));
    if (suggestions) {
      block.append(elem("p", "recommend-finding", item.finding));
      block.append(elem("p", "recommend-action", item.recommended_action));
      if (item.uncertainty) {
        const details = elem("details", "uncertainty-details");
        details.append(elem("summary", "", "Limitations and unknowns"), elem("p", "", item.uncertainty));
        block.append(details);
      }
    } else {
      block.append(elem("p", "", THEME_ACTIONS[theme] || THEME_ACTIONS.Other));
    }
    block.append(evidenceLinks(item.evidence_ids));
    holder.append(block);
  });
}

function renderSegmentPanel(holderId, responseField, groupKey, label, missingLabel) {
  const holder = $(holderId);
  if (!result) return empty(holder, `Upload and analyze feedback to see ${label.toLowerCase()} insights.`);
  const segments = result[responseField];
  if (!Array.isArray(segments)) return empty(holder, `${label} analysis is unavailable. Deploy the latest Lambda.`);
  if (!segments.length) return empty(holder, `No ${missingLabel} data found in the uploaded CSV.`);
  holder.replaceChildren();
  for (const segment of segments) {
    const card = elem("article", "market-card");
    const heading = elem("div", "market-heading");
    heading.append(elem("h3", "", segment[groupKey]));
    if (segment.small_sample) heading.append(elem("span", "sample-tag", "Small sample"));
    card.append(heading);
    const stat = elem("div", "market-stats");
    for (const [value, field] of [
      [segment.total_count, "Records"],
      [segment.negative_count, "Negative"],
      [`${segment.negative_pct}%`, "Negative share"]
    ]) {
      const box = elem("div", "market-stat");
      box.append(elem("strong", "", value), elem("span", "", field));
      stat.append(box);
    }
    card.append(stat);
    if (segment.top_negative_theme) {
      const top = elem("p", "market-top-theme");
      top.append(elem("strong", "", "Top complaint: "),
        document.createTextNode(`${segment.top_negative_theme} · ${segment.top_issue_count} report${segment.top_issue_count === 1 ? "" : "s"}`));
      card.append(top);
    }
    card.append(elem("p", "market-observation", segment.observation));
    const action = elem("div", "market-action");
    action.append(elem("span", "action-caption", segment.action_source === "ai"
      ? "AI-proposed investigation · analyst review" : "Suggested investigation · analyst review"));
    action.append(elem("p", "", segment.recommended_action));
    card.append(action);
    if (segment.evidence_ids?.length) card.append(evidenceLinks(segment.evidence_ids));
    holder.append(card);
  }
}
function renderMarkets() {
  renderSegmentPanel("marketInsights", "market_insights", "market", "Regional", "market");
}
function renderCategories() {
  renderSegmentPanel("categoryInsights", "category_insights", "product_category", "Product category", "product_category");
}
function renderChannels() {
  renderSegmentPanel("channelInsights", "channel_insights", "channel", "Feedback channel", "channel");
}

function renderRows() {
  const tbody = $("feedbackRows"); tbody.replaceChildren();
  const classifications = new Map(result?.classifications?.map(c => [c.feedback_id, c]) || []);
  const filter = $("filterSentiment").value;
  const toShow = rows.filter(row => filter === "all" || classifications.get(row.feedback_id)?.sentiment === filter);
  if (!toShow.length) {
    tbody.append(elem("tr", ""));
    const td = elem("td", "empty", rows.length ? "No records match the selected filter." : "No feedback loaded.");
    td.colSpan=6; tbody.lastChild.append(td); return;
  }
  for (const item of toShow) {
    const tr = elem("tr", ""); tr.dataset.feedbackId = item.feedback_id;
    tr.append(elem("td", "", item.feedback_id));
    const meta = [item.market, item.channel].filter(Boolean).join(" / ") || "—";
    tr.append(elem("td", "", meta), elem("td", "", item.product_category || "—"), elem("td", "comment", item.comment));
    const c = classifications.get(item.feedback_id);
    const sentiment = elem("td", "");
    if (c) sentiment.append(elem("span", `pill ${c.sentiment}`, c.sentiment)); else sentiment.textContent = "Pending";
    tr.append(sentiment, elem("td", "", c?.theme || "—"));
    tbody.append(tr);
  }
}
function validateAnalysis(data, requested) {
  if (!data || !Array.isArray(data.classifications) || !Array.isArray(data.recurring_issues)) throw new Error("Malformed API response");
  if (data.classifications.length !== requested.length) throw new Error("Incomplete AI classifications");
  const wanted = new Set(requested.map(x => x.feedback_id));
  const found = new Set();
  for (const classification of data.classifications) {
    if (!wanted.has(classification.feedback_id) || found.has(classification.feedback_id)
        || !sentimentOrder.includes(classification.sentiment)
        || !Object.prototype.hasOwnProperty.call(THEME_ACTIONS, classification.theme)) throw new Error("Unrecognized AI classification");
    found.add(classification.feedback_id);
  }
  for (const issue of data.recurring_issues) {
    if (!Object.prototype.hasOwnProperty.call(THEME_ACTIONS, issue.theme) || !Array.isArray(issue.evidence_ids)
        || !issue.evidence_ids.every(id => wanted.has(id)) || issue.count !== issue.evidence_ids.length) {
      throw new Error("Invalid recurring-issue evidence");
    }
  }
  // Independently verify all segment statistics against CSV fields and model classifications.
  const byId = new Map(data.classifications.map(c => [c.feedback_id, c]));
  function verifySegments(responseField, sourceField) {
    if (data[responseField] == null) return; // Older deployments may omit these fields.
    if (!Array.isArray(data[responseField])) throw new Error(`Invalid ${sourceField} results`);
    const grouped = new Map();
    for (const item of requested) {
      const key = (item[sourceField] || "").trim().toLocaleLowerCase();
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }
    const seen = new Set();
    if (data[responseField].length !== grouped.size) throw new Error(`Incomplete ${sourceField} analysis`);
    for (const seg of data[responseField]) {
      const key = String(seg[sourceField] || "").toLocaleLowerCase();
      const records = grouped.get(key);
      if (!records || seen.has(key)) throw new Error(`Unknown or duplicate ${sourceField}`);
      seen.add(key);
      const negative = records.filter(x => byId.get(x.feedback_id).sentiment === "negative");
      const positive = records.filter(x => byId.get(x.feedback_id).sentiment === "positive");
      const leading = negative.filter(x => byId.get(x.feedback_id).theme === seg.top_negative_theme);
      const evidence = new Set(negative.map(x => x.feedback_id));
      const topEvidence = new Set(leading.map(x => x.feedback_id));
      if (seg.total_count !== records.length || seg.negative_count !== negative.length
          || seg.positive_count !== positive.length
          || seg.neutral_count !== records.length - negative.length - positive.length
          || seg.negative_pct !== Math.round(negative.length / records.length * 100)
          || !Array.isArray(seg.evidence_ids) || seg.evidence_ids.length !== evidence.size
          || !seg.evidence_ids.every(id => evidence.has(id))
          || seg.top_issue_count !== leading.length
          || !Array.isArray(seg.top_issue_evidence_ids)
          || seg.top_issue_evidence_ids.length !== topEvidence.size
          || !seg.top_issue_evidence_ids.every(id => topEvidence.has(id))
          || !["ai", "rule-based"].includes(seg.action_source)
          || typeof seg.observation !== "string" || typeof seg.recommended_action !== "string") {
        throw new Error(`${sourceField} evidence validation failed`);
      }
    }
  }
  verifySegments("market_insights", "market");
  verifySegments("category_insights", "product_category");
  verifySegments("channel_insights", "channel");
  // Executive insights are optional for backwards compatibility with deployed v2 Lambdas.
  if (data.executive_insights != null) {
    const insights = data.executive_insights;
    if (!insights || !["generated", "mock", "unavailable"].includes(insights.status)
        || !Array.isArray(insights.summary_evidence_ids) || !Array.isArray(insights.recommendations)
        || !insights.summary_evidence_ids.every(id => wanted.has(id))) throw new Error("Invalid executive insights metadata");
    const recurringByTheme = new Map(data.recurring_issues.map(x => [x.theme, x]));
    for (const recommendation of insights.recommendations) {
      const issue = recurringByTheme.get(recommendation.theme);
      if (!issue || recommendation.count !== issue.count
          || !Array.isArray(recommendation.evidence_ids)
          || recommendation.evidence_ids.join("|") !== issue.evidence_ids.join("|")) {
        throw new Error("Invalid executive insight evidence");
      }
    }
  }
}
async function analyze() {
  if (busy) return;
  if (!idToken) { showStatus("Sign in first. The AI endpoint only accepts authenticated requests.", true); return; }
  if (!rows.length) { showStatus("Upload a CSV first.", true); return; }
  busy = true;
  const button = $("analyzeBtn"); button.disabled = true; button.textContent = "Analyzing feedback…";
  showStatus("Analyzing feedback. This may take a few seconds.");
  const start = performance.now();
  try {
    const response = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json", "Authorization": idToken},
      body: JSON.stringify({feedback:rows.map(({feedback_id,comment,market,product_category,channel}) => ({
        feedback_id, comment, market:market || "", product_category:product_category || "", channel:channel || ""
      }))}),
    });
    let body;
    try { body = await response.json(); } catch { throw new Error(`API returned a non-JSON response (HTTP ${response.status})`); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        idToken = null; updateAuth();
        throw new Error("Authorization failed or session expired. Sign in again.");
      }
      throw new Error(`Analysis failed (HTTP ${response.status}): ${body.error || "Unknown API error"}`);
    }
    validateAnalysis(body, rows);
    result = body;
    analysisElapsed = Math.round(performance.now() - start);
    renderAll();
    showStatus(`Analysis complete: ${body.classifications.length} records reviewed.`);
  } catch (error) { showStatus(error.message || "Analysis failed", true); }
  finally { busy = false; button.disabled = false; button.innerHTML = '✳ Analyze with AI <span aria-hidden="true">↗</span>'; }
}
async function init() {
  $("loginBtn").addEventListener("click", startLogin);
  $("logoutBtn").addEventListener("click", logout);
  $("analyzeBtn").addEventListener("click", analyze);
  $("filterSentiment").addEventListener("change", renderRows);
  $("csvInput").addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { showStatus("CSV file exceeds the 1 MB limit", true); return; }
    try { loadRows(parseCsv(await file.text()), `Loaded ${file.name}`); }
    catch (error) { showStatus(error.message, true); }
    finally { e.target.value = ""; }
  });
  updateAuth();
  await handleCallback();
  // No records loaded automatically. User uploads a CSV; synthetic demo records live in repository for testing.
  renderAll();
  if (!isConfigured()) showStatus("Setup required: edit config.js with your Cognito domain, app client ID and CloudFront callback URL.", true);
}
init().catch(error => showStatus(`Initialization failed: ${error.message}`, true));
