# Architecture decision record — secure AI-assisted feedback analysis

## Customer context

Independent Prada-inspired prototype for a customer experience analyst. Uploaded comments originate from optional `market`, `product_category`, and `channel` columns. Included feedback is synthetic; no real Prada data or Adobe integration is claimed.

## Architecture and authorization

Static S3/CloudFront frontend → Cognito hosted login (public SPA client, authorization-code + PKCE) → API Gateway REST (`POST /feedback/analyze`, Cognito user-pool authorizer) → Python Lambda → Bedrock Nova 2 Lite. API Gateway has no OAuth authorization scopes in this MVP, so the browser sends a Cognito **ID token**. No AWS credentials or app-client secrets reside in JavaScript. ID tokens are held in memory and require sign-in on refresh. CORS restricts the configured browser origin but is **not** an authentication control.

## Reliability boundary — AI vs authoritative facts

First model call classifies one sentiment and one theme per feedback ID using Bedrock structured tool output. Lambda validates IDs and enum values. **All aggregations are deterministic:** per-market, per-product-category, and per-channel record counts, sentiment counts and ratios, top negative themes, and evidence IDs. Input values are grouping dimensions, not AI-inferred locations, categories, or channels. Case-insensitive grouping preserves the first observed display label.

A separate **optional** Bedrock call generates the executive summary, evidence-linked investigative recommendations, and optionally brief segment-specific actions. Model-proposed segment actions are attached only to real segment labels with negative feedback; otherwise rule-based next steps remain. The model is never trusted to set counts or evidence links. If the second call fails, classifications and segmentation still succeed.

## Trade-offs and limitations

- Only 20 records per request to bound synchronous runtime, tokens, and cost. Two Bedrock calls can increase latency. For higher volume, use asynchronous S3 ingestion and batch jobs.
- Taxonomy permits one theme per record; mixed complaints may lose secondary issues. Evaluate multi-label classification with annotated examples before production.
- **Negative share** is `negative_count/total_count` for the uploaded rows in a segment, not a regional/product/channel satisfaction score. Small/self-selected samples are not representative. Never infer causes from a correlation between channel and complaint theme.
- Data stays in browser memory; analysis results are not persisted. No multi-user access control beyond Cognito account access, no production PII redaction, approval workflow, or infrastructure provisioning automation.
- A real implementation would limit scopes to least privilege, add rate limits and spend budgets, metrics with correlation IDs, error alerts, token/cost visibility, audit logs, operational approval, and model calibration.

## Failure modes and logs

Invalid or duplicate feedback: 400; absent/invalid Cognito token: API Gateway 401/403; model classification failure: 502 with no raw model content; second-call failure: 200 with `executive_insights.status='unavailable'` and safe rule-based actions. Logs include counts, Bedrock stop reasons, approximate latency and token consumption, without logging comments. Client independently verifies segment statistics and evidence ID sets against uploaded CSV data.
