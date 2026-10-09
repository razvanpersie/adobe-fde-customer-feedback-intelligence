# Technical interview walkthrough (suggested 10 minutes)

## 1. Customer problem (60 sec)

A luxury retailer's CX analyst receives feedback across survey, support and review channels. The challenge is seeing recurring customer problems and locating the original evidence without reading each message manually. This is a **fictional Prada-inspired** demonstration and does not connect to Adobe or Prada systems.

## 2. Demo the workflow (3 minutes)

- Authenticate through Cognito.
- Show that the dashboard starts empty and provides a CSV template.
- Upload the synthetic `frontend/sample_feedback.csv` manually (16 records).
- Run **Analyze with AI**. Explain that classification happens in Bedrock Nova 2 Lite.
- Inspect the overall recurring issues and executive briefing.
- Navigate regional, product-category and channel breakdowns; click evidence IDs to jump to original comments.
- Do not present uploaded-sample percentages as representative of the wider population.

## 3. Explain trusted vs untrusted computation (2 minutes)

- Language model supplies structured sentiment and single-theme labels per feedback ID.
- Lambda enforces allowed labels, unique IDs and one returned classification per input ID.
- Lambda, *not the model*, calculates counts, negative shares, recurring problems and evidence IDs from validated classifications.
- Second optional model call drafts an executive summary and investigation recommendations; its failure never discards the classifications.
- The user remains responsible for interpreting findings and authorizing any real-world action.

## 4. Walk through reliability (2 minutes)

- Validation: invalid/duplicate IDs, overlong comments, malformed JSON, invalid model output.
- Security: PKCE/Cognito authentication, REST authorizer, no AWS credentials in browser, origin-restricted CORS (not a security boundary).
- Operational: structured logs for token counts / model latency / invocation failures, without raw customer comments.
- Test locally via Python unit suite and Node CSV/UI checks; CI runs automatically on pushes.

## 5. State trade-offs (2 minutes)

- 20 records/request and synchronous calls prioritize simple architecture and predictable spend over throughput.
- Two Bedrock calls add latency; executive insight generation is optional, so the main output remains usable.
- Single-label taxonomy loses multi-topic complaints.
- No storage avoids complexity but loses audit history and user review state.
- Uploaded sample is non-representative, and theme classification is not independently calibrated.
- Production extension: PII redaction, async ingestion, benchmarking against labeled data, budgets and alerts, infrastructure-as-code, and human-in-the-loop approval.

## Likely questions and short answers

**Why no database?** The assignment asks for a narrow, functional end-to-end workflow. Keeping data in browser memory minimizes privacy scope and deployment complexity; persisted reviews would be a next increment.

**What if the model hallucinates?** Schema validation rejects invalid output and invented IDs; all numerical facts come from code. It cannot guarantee a correct sentiment label, so we need an evaluation dataset.

**How can it scale?** Upload to S3 and process batches asynchronously via queue/worker, persist results and notify the analyst. Set quotas and track input/output tokens.

**Why not just send all data to an LLM?** Traceability and correctness: numerical aggregation and evidence mappings are deterministic and testable.

**What does confidence mean?** This MVP does not claim calibrated statistical confidence. Small sample indicators and unknown-cause caveats communicate evidence limits without fabricating confidence scores.
