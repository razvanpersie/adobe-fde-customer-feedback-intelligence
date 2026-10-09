# V4.1 update — feedback segmentation and usability

This package includes the prior V4 changes (compact uncertainty details, corrected sidebar order, no demo button, downloadable CSV template, market breakdown) **and now adds product-category and feedback-channel insights**.

## Deploy in this order

1. **Lambda:** In AWS Lambda → `prada-feedback-analyzer` → Code → Upload from `.zip file`, upload `prada_feedback_lambda_v4.zip`. Keep handler `lambda_function.lambda_handler` and environment variables `USE_MOCK_AI=false`, `MODEL_ID=eu.amazon.nova-2-lite-v1:0`, `ALLOWED_ORIGIN=https://projectrazvan.click`. Set a suitable Lambda timeout; two Bedrock calls increase overall latency. No DynamoDB, Cognito, API Gateway URL or IAM changes required.
2. **Test backend first:** Invoke Lambda with at least two records and `market`, `product_category`, `channel` populated. A 200 response should include `market_insights`, `category_insights`, and `channel_insights`. If the executive summary fails, `executive_insights.status='unavailable'` is an acceptable degradation; segment facts should still be available.
3. **S3:** Unzip `prada_feedback_frontend_v4.zip`. Upload the **contents of `frontend/`** directly under the S3 prefix `prada/`, replacing existing files. Include `feedback_template.csv`. Do not overwrite the root homepage or the `/users/` application.
4. **CloudFront:** Create an invalidation for `/prada/*` and wait for `Completed`.
5. **Browser:** Visit `https://projectrazvan.click/prada/index.html`, sign in with Cognito, click **Download CSV template** or upload `sample_feedback.csv` manually. There is no demo button and the dashboard starts empty. Analyze with AI. Confirm insights under **Regional**, **Product category**, and **Feedback channel** and test evidence-ID links.
6. **GitHub:** Merge the source folders and documentation from `prada_feedback_github_v4.zip` into your repository and commit. Run the test commands from `README.md`.

## Troubleshooting

- `Invalid ... evidence`: frontend and Lambda versions may differ. Deploy backend before frontend.
- `Failed to fetch`: check Network → `OPTIONS` and `POST`; `Access-Control-Allow-Origin` must be `https://projectrazvan.click` in preflight and POST responses.
- `executive_insights.status='unavailable'`: the second LLM tool call did not validate; classifications and segmentation still work. Check safe CloudWatch diagnostic logs.
- `No category/channel data`: upload a CSV with populated `product_category` and `channel` columns; see `feedback_template.csv`.

## Scope limitations

All percentages and counts apply only to the current upload (max 20 records). They are not company-wide estimates. Theme classification is one label per record. Regional, category, and channel conclusions should be treated as tentative, especially in small or self-selected samples.
